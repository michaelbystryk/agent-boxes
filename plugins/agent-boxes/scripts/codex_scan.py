"""Prints this session's running Codex runs and Codex rate limits as one JSON line.

argv[1] holds the session id. The session's transcripts (its own and its
subagents') name every `codex exec` command it ran; each is matched to the
Codex thread it started, and those threads and the sub-agents they spawn are
the session's.

Reads the newest numbered ~/.codex/state_N.sqlite for the threads, and bounded tails of
recent rollout (rollouts reach gigabytes) for its lifecycle and token counts.
"""
import glob
import hashlib
import json
import ntpath
import os
import posixpath
import re
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

HOME = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
LOOKBACK_MS = 12 * 3600 * 1000  # threads updated in the last 12 h
STALE_S = 60 * 60               # a "running" run silent this long is dead (long builds log nothing)
TAILS = (256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024)
QUOTA_LOOKBACK_MS = 7 * 24 * 3600 * 1000
QUOTA_FILES = 8
QUOTA_BYTES = 8 * 1024 * 1024
BRIEF_BYTES = 1024 * 1024
HEAD_BYTES = 64 * 1024
MATCH_BEFORE_MS = 5 * 1000      # a thread starts after the shell call...
MATCH_AFTER_MS = 3 * 60 * 1000  # ...and within this long of it
BARE_AFTER_MS = 30 * 1000
PROMPT_CHARS = 150
LIFECYCLE = ("task_started", "task_complete", "turn_aborted")
CLAUDE_HOME = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
CLAUDE_PROJECTS = os.path.join(CLAUDE_HOME, "projects")
SHELL_TOOLS = ("Bash", "PowerShell")
UNVERIFIED_MS = 15 * 60 * 1000
# Find this chat's runs among live processes too (boxes.py turns it on; tests opt in).
PROCESSES = False
_LAUNCHES = {}
STATE = os.path.join(CLAUDE_HOME, "agent-boxes")
_TRANSCRIPTS = {}
_COMMANDS = {}
_READ_BUDGET = None
CACHE_VERSION = 7
TRANSCRIPT_BYTES = 64 * 1024 * 1024
TRANSCRIPT_SECONDS = 2
RECORD_BYTES = 4 * 1024 * 1024

# Flags with values, including global options accepted before `exec`.
VAR = re.compile(r"""\$\{?([A-Za-z_]\w*)\}?""")
VALUE_FLAGS = ("-m", "--model", "-c", "--config", "-s", "--sandbox", "-C", "--cd",
               "-o", "--output-last-message", "-p", "--profile", "-i", "--image",
               "--color", "--output-schema", "--enable", "--disable", "--add-dir",
               "-a", "--ask-for-approval", "--local-provider", "--thread-source")


def obj(value):
    return value if isinstance(value, dict) else {}


def iso_time(value):
    """ISO time with microseconds, including on Python 3.8."""
    if not isinstance(value, str):
        return 0.0
    value = re.sub(r"(\.\d{6})\d+", r"\1", value)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def tail_events(path, size):
    """Yields the parsed JSON lines of the file's last `size` bytes, newest first."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        start = max(0, end - size)
        f.seek(start)
        data = f.read(size)
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]  # first line is cut
    for raw in reversed(lines):
        if not raw.strip():
            continue
        try:
            ev = json.loads(raw)
            if isinstance(ev, dict):
                yield ev
        except ValueError:
            continue


def event_time(ev):
    return iso_time(obj(ev).get("timestamp"))


def read_tail(path, budget=None):
    """Returns lifecycle, token info, limits, last event time and limits time.

    The last event's own timestamp stands for activity: Windows does not move
    a file's mtime while the writer keeps it open.
    """
    life = info = limits = None
    last_at = limits_at = 0.0
    size = os.path.getsize(path)
    left = min(size, TAILS[-1], budget[0] if budget is not None else size)
    end, carry = size, b""
    with open(path, "rb") as f:
        while left:
            n = min(TAILS[0], left)
            end -= n
            f.seek(end)
            lines = (f.read(n) + carry).split(b"\n")
            carry = lines.pop(0) if end else b""
            left -= n
            if budget is not None:
                budget[0] -= n
            for raw in reversed(lines):
                try:
                    ev = obj(json.loads(raw))
                except ValueError:
                    continue
                last_at = last_at or event_time(ev)
                p = obj(ev.get("payload"))
                t = p.get("type")
                if life is None and t in LIFECYCLE:
                    life = t
                if t == "token_count":
                    if info is None and isinstance(p.get("info"), dict):
                        info = p["info"]
                    if limits is None and isinstance(p.get("rate_limits"), dict):
                        limits, limits_at = p["rate_limits"], event_time(ev)
                if life and info and limits:
                    return life, info, limits, last_at, limits_at
    return life, info, limits, last_at, limits_at


ACTION_TAIL = 262144


def short(text, width=60):
    text = " ".join(str(text).split())
    return text[: width - 1] + "…" if len(text) > width else text


def last_action(path):
    """What the thread did last, from its newest finished item: a command, an edit, a reply."""
    for ev in tail_events(path, ACTION_TAIL):
        p = obj(ev.get("payload"))
        if p.get("type") == "item_completed":
            item = obj(p.get("item"))
            kind = item.get("type")
            if kind == "CommandExecution":
                cmd = item.get("command") or []
                script = cmd[-1] if isinstance(cmd, list) and cmd else str(cmd)
                first = next((ln for ln in str(script).splitlines() if ln.strip() and ln.strip() not in ("@'", '@"')), "")
                return "$ " + short(first)
            elif kind == "FileChange":
                files = list(obj(item.get("changes")).keys())
                if files:
                    more = f" +{len(files) - 1}" if len(files) > 1 else ""
                    return "editing " + os.path.basename(files[0]) + more
            elif kind == "ImageView":
                return "viewing " + os.path.basename(str(item.get("path") or ""))
            elif kind == "AgentMessage":
                text = " ".join(c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict))
                if text.strip():
                    return "says: " + short(text)
    return None


def task_label(title, first_msg):
    text = (title or first_msg or "").strip()
    text = re.sub(r"^#\s+", "", text)
    m = re.search(r"\b(?:Task|TASK)\s*:\s*(.+)", text)
    if m:
        text = m.group(1)
    text = " ".join((text.splitlines() or [""])[0].split())
    return text


def fresh_tokens(usage):
    """Input not served from cache, plus output."""
    if "input_tokens" not in usage:
        return usage.get("total_tokens")
    return usage["input_tokens"] - usage.get("cached_input_tokens", 0) + usage.get("output_tokens", 0)


def parent_of(source):
    try:
        return json.loads(source)["subagent"]["thread_spawn"]["parent_thread_id"]
    except (TypeError, ValueError, KeyError):
        return None


def threads(lookback_ms=LOOKBACK_MS):
    cands = [(int(m.group(1)), p) for p in glob.glob(os.path.join(HOME, "state_*.sqlite"))
             for m in [re.fullmatch(r"state_(\d+)\.sqlite", os.path.basename(p))] if m]
    if not cands:
        return []
    con = None
    try:
        con = sqlite3.connect(Path(max(cands)[1]).resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        cols = {r[1] for r in con.execute("pragma table_info(threads)")}
        if not {"id", "rollout_path"} <= cols:
            return []

        def stamp(name):
            parts = [c for c in (name + "_ms", name + " * 1000") if c.split()[0] in cols]
            return "coalesce(" + ", ".join(parts + ["0"]) + ")" if parts else "0"

        names = ("id", "rollout_path", "title", "first_user_message", "model", "reasoning_effort",
                 "tokens_used", "agent_nickname", "agent_path", "source", "cwd")
        select = [n if n in cols else "NULL as " + n for n in names]
        select += [stamp(n) + " as " + n + "_ms" for n in ("created_at", "updated_at")]
        archived = "archived = 0 and " if "archived" in cols else ""
        since = int(time.time() * 1000) - lookback_ms
        cur = con.execute(
            "select " + ", ".join(select) + " from threads where " + archived + stamp("updated_at")
            + " > ? order by " + stamp("updated_at") + " desc limit 400",
            (since,),
        )
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    except sqlite3.Error:
        return []
    finally:
        if con is not None:
            con.close()


def norm_text(s):
    return " ".join(s.split())[:PROMPT_CHARS] if isinstance(s, str) else ""


def norm_path(p):
    if not isinstance(p, str):
        return None
    p = host_path(p)
    if p and p.startswith("\\\\?\\"):  # Windows long-path prefix \\?\
        p = p[4:]
    paths = ntpath if os.name == "nt" else posixpath
    return paths.normcase(paths.normpath(p)) if p and paths.isabs(p) else None


def host_path(p):
    """Git Bash's /c/x is C:/x."""
    m = re.match(r"^/([a-zA-Z])/(.*)$", p) if os.name == "nt" else None
    return f"{m.group(1).upper()}:/{m.group(2)}" if m else p


def born(stat):
    """When the file was created, where the OS keeps it. Not st_ctime: on POSIX that is the
    last metadata change, which every append moves."""
    b = getattr(stat, "st_birthtime", None)
    if b is None and os.name == "nt":
        b = stat.st_ctime
    return b


def load_transcript(cache, stat, path):
    try:
        with open(cache, encoding="utf-8") as f:
            data = json.load(f)
        valid = (isinstance(data, dict) and data.get("version") == CACHE_VERSION
                 and isinstance(data.get("calls"), list)
                 and isinstance(data.get("offset"), int) and isinstance(data.get("size"), int)
                 and 0 <= data["offset"] <= data["size"] <= stat.st_size
                 and (stat.st_size > data["size"] or data["mtime"] == stat.st_mtime_ns)
                 and data.get("ino") == stat.st_ino and data.get("born") == born(stat)
                 and data["offset"] <= data.get("skipOffset", data["offset"]) <= stat.st_size
                 and 0 <= data.get("headBytes", -1) <= min(4096, stat.st_size))
        if valid:
            with open(path, "rb") as f:
                valid = data.get("headHash") == hashlib.sha256(f.read(data["headBytes"])).hexdigest()
        return data if valid else {}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def extract_calls(raw, data, since_ms):
    handoff = b'"continued-in"' in raw
    shell = ((b'"Bash"' in raw or b'"PowerShell"' in raw)
             and (b"codex" in raw or b"agy" in raw or b"bench.py" in raw))
    if not (handoff or shell):
        return
    try:
        ev = obj(json.loads(raw))
    except ValueError:
        return
    if ev.get("type") == "continued-in":
        data["continuedIn"] = ev.get("continuedInSessionId")
    content = obj(ev.get("message")).get("content")
    at_ms = event_time(ev) * 1000
    if ev.get("type") != "assistant" or not isinstance(content, list) or at_ms < since_ms:
        return
    for block in content:
        block = obj(block)
        inp = obj(block.get("input"))
        command = inp.get("command")
        if (block.get("type") == "tool_use" and block.get("name") in SHELL_TOOLS
                and isinstance(command, str) and any(k in command for k in ("codex", "agy", "bench.py"))):
            calls = parsed_calls(at_ms, command, inp.get("cwd") or ev.get("cwd"))
            data["calls"].extend(calls)
            kind = None if calls else looks_like_launch(command)
            if kind:
                data.setdefault("unverified", []).append([at_ms, kind])


def save_transcript(cache, data):
    tmp = cache + ".%s.tmp" % os.getpid()
    try:
        os.makedirs(STATE, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, cache)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def prune_transcripts():
    """Drop caches of transcripts untouched for a week, so one file per chat doesn't pile up."""
    cutoff = time.time() - 7 * 24 * 3600
    try:
        names = os.listdir(STATE)
    except OSError:
        return
    for name in names:
        if name.endswith(".tmp") or name.startswith(("transcript-", "launches-")) and name.endswith(".json"):
            path = os.path.join(STATE, name)
            try:
                expiry = time.time() - 3600 if name.endswith(".tmp") else cutoff
                if os.path.getmtime(path) < expiry:
                    os.remove(path)
            except OSError:
                pass


def transcript_data(path, since_ms):
    """Cache shell calls and the complete-line offset; read only appended bytes."""
    global _READ_BUDGET
    if path in _TRANSCRIPTS:
        return _TRANSCRIPTS[path]
    stat = os.stat(path)
    key = hashlib.sha256(os.fsencode(os.path.abspath(path))).hexdigest()
    cache = os.path.join(STATE, "transcript-" + key + ".json")
    data = load_transcript(cache, stat, path)
    rebuilt = not data
    data["calls"] = [c for c in data.get("calls", []) if isinstance(c, dict)
                     and isinstance(c.get("atMs"), (int, float)) and c["atMs"] >= since_ms
                     and c.get("kind") in ("codex", "agy", "bench")]
    data["unverified"] = [u for u in data.get("unverified", []) if isinstance(u, list) and len(u) == 2
                          and isinstance(u[0], (int, float)) and u[0] >= since_ms and u[1] in ("codex", "agy", "bench")]
    offset = data.get("offset", 0)
    start = data.get("skipOffset", offset)
    cursor, skipping = start, start > offset
    if _READ_BUDGET is None:
        _READ_BUDGET = [TRANSCRIPT_BYTES, time.monotonic() + TRANSCRIPT_SECONDS]
    if offset < stat.st_size:
        with open(path, "rb") as f:
            f.seek(cursor)
            while cursor < stat.st_size and _READ_BUDGET[0] > 0 and time.monotonic() < _READ_BUDGET[1]:
                raw = f.readline(min(RECORD_BYTES + 1, stat.st_size - cursor, _READ_BUDGET[0]))
                if not raw:
                    break
                _READ_BUDGET[0] -= len(raw)
                cursor += len(raw)
                if not raw.endswith(b"\n"):
                    if skipping or len(raw) > RECORD_BYTES:
                        skipping = True
                        continue
                    cursor = offset  # retry an unfinished, bounded record next poll
                    break
                if not skipping and len(raw) <= RECORD_BYTES:
                    extract_calls(raw, data, since_ms)
                offset, skipping = cursor, False
    changed = rebuilt or offset != data.get("offset", 0) or cursor > start
    if changed:
        with open(path, "rb") as f:
            head = f.read(min(4096, stat.st_size))
        data.update(version=CACHE_VERSION, size=stat.st_size, mtime=stat.st_mtime_ns, offset=offset,
                    ino=stat.st_ino, born=born(stat),
                    headBytes=len(head), headHash=hashlib.sha256(head).hexdigest())
        # Only oversized records need a separate discard cursor across budgets.
        data.pop("skipOffset", None)
        if skipping:
            data["skipOffset"] = cursor
        save_transcript(cache, data)
    _TRANSCRIPTS[path] = data
    return data


def transcripts(session_id, ids=None):
    """The session's transcripts and its subagents', whichever project holds them.

    A session that ran out of context goes on writing under a new id, while
    the engine still reports the first: follow the `continued-in` chain. Each id
    on it goes into `ids`.
    """
    paths, seen = [], set() if ids is None else ids
    since = time.time() * 1000 - LOOKBACK_MS
    while re.fullmatch(r"[\w-]+", session_id or "") and session_id not in seen:
        seen.add(session_id)
        main = glob.glob(os.path.join(CLAUDE_PROJECTS, "*", session_id + ".jsonl"))
        subs = glob.glob(os.path.join(CLAUDE_PROJECTS, "*", session_id, "subagents", "*.jsonl"))
        next_id = None
        for path in main + subs:
            try:
                if path in subs and os.path.getmtime(path) * 1000 < since:
                    continue
                data = transcript_data(path, since)
            except OSError:
                continue
            paths.append(path)
            if path in main and isinstance(data.get("continuedIn"), str):
                next_id = data["continuedIn"]
        session_id = next_id
    return paths


def via(path):
    """The subagent whose transcript this is (subagents/agent-<id>.jsonl), or None for a chat's own."""
    if os.path.basename(os.path.dirname(path)) != "subagents":
        return None
    m = re.fullmatch(r"agent-([\w-]+)\.jsonl", os.path.basename(path))
    return m.group(1) if m else None


def session_commands(session_id):
    """One shared pass for both scanners, including session continuations. Each call carries
    `via`: the subagent that ran it, or None for the chat itself. Runs found as live processes
    join them, merged with the command that started them."""
    key = (CLAUDE_PROJECTS, session_id)
    if key not in _COMMANDS:
        since = time.time() * 1000 - LOOKBACK_MS
        ids, calls, unparsed = set(), [], []
        for path in transcripts(session_id, ids):
            data = transcript_data(path, since)
            calls += [{**c, "via": via(path)} for c in data["calls"] if c["atMs"] >= since]
            unparsed += [(at, kind, via(path)) for at, kind in data.get("unverified", [])]
        launches = remembered(session_id, live_launches(ids | {session_id}) if PROCESSES else None, since)
        _COMMANDS[key] = merge_launches(calls, launches, unparsed)
        _LAUNCHES[key] = (launches, unparsed)
    return _COMMANDS[key]


def unverified(session_id):
    """How many recent commands looked like launches, parsed to nothing, and have no process
    of their kind to show for them: their runs may be missing from the boxes."""
    now = time.time() * 1000
    session_commands(session_id)
    launches, unparsed = _LAUNCHES.get((CLAUDE_PROJECTS, session_id), ([], []))
    starts = [(c["kind"], c["startMs"]) for c in launches]
    return sum(1 for at, kind, _ in unparsed if at >= now - UNVERIFIED_MS
               and not any(k == kind and at - 2000 <= t <= at + MATCH_AFTER_MS for k, t in starts))


def launch_argv(argv):
    """A process's argv as the command that started it: `node .../codex.js` and codex's
    platform binaries as `codex`, any python or py launcher as `python`; [] for anything else."""
    words = [w for w in argv if isinstance(w, str)]

    def base(w):
        return re.sub(r"\.(exe|cmd|js|mjs)$", "", re.split(r"[\\/]", w)[-1].lower())

    if len(words) >= 2 and base(words[0]) in ("node", "bun"):
        script = words[1].lower().replace("\\", "/")
        name = next((n for n in ("codex", "agy") if f"/{n}/" in script or base(words[1]) == n), None)
        if not name:
            return []
        words = [name] + words[2:]
    if not words:
        return []
    name = base(words[0])
    if name.startswith("codex"):
        name = "codex"
    elif re.fullmatch(r"python[\d.]*w?|pyw?", name):
        name = "python"
    elif name != "agy":
        return []
    return [name] + words[1:]


def argv_calls(at_ms, argv, cwd):
    """The calls a live process makes, from its real argv and working directory."""
    words = launch_argv(argv)
    if not words:
        return []
    # single-quoted, so parsed_calls takes every word literally
    command = " ".join("'" + w.replace("'", "'\"'\"'") + "'" for w in words)
    out = []
    for c in parsed_calls(at_ms, command, cwd):
        if c["kind"] == "codex":
            if c.get("prompt") == "-":  # the brief came on stdin
                c.pop("prompt")
            # codex may already run in its -C dir, so a relative -C would be applied twice
            if c.get("cwd") and not os.path.isdir(c["cwd"]) and cwd and os.path.isdir(cwd):
                c["cwd"] = cwd
        out.append(c)
    return out


def live_launches(session_ids):
    """Calls for this chat's live processes, one per launch, or None when processes can't be read.
    A launcher (node codex.js, py) and the process it starts are one launch; so are a bench run
    and the agent CLI it starts. `ids` holds every (pid, start) of the launch, so a later poll
    that sees only one of them still knows it."""
    try:
        import procs

        found, tree = procs.launches(session_ids)
    except Exception:
        return None
    calls = {}
    for p in found:
        got = argv_calls(p.startMs, p.argv, p.cwd)
        if got:
            calls[p.pid] = (p, got[0])
    into = {}
    for pid, (p, call) in calls.items():
        anc, hops = p.ppid, 0
        while anc in tree and anc != pid and hops < 64 and pid not in into:
            if anc in calls:
                q, parent = calls[anc]
                if q.startMs <= p.startMs + 2000 and (
                        parent["kind"] == "bench"
                        or anc == p.ppid and parent["kind"] == call["kind"]
                        and launch_argv(q.argv)[1:] == launch_argv(p.argv)[1:]):
                    into[pid] = anc
            anc, hops = tree[anc].ppid, hops + 1
    out = {}
    for pid, (p, call) in calls.items():
        root, hops = pid, 0
        while root in into and hops < 64:
            root, hops = into[root], hops + 1
        q, root_call = calls[root]
        launch = out.setdefault(root, {**root_call, "atMs": q.startMs, "startMs": q.startMs, "ids": [], "alive": True})
        launch["ids"].append([pid, p.startMs])
    return list(out.values())


def remembered(session_id, live, since):
    """Launches seen in earlier polls plus the live ones, kept per chat so a run that ended
    between polls still counts (pairing needs every call of a burst). A live launch that shares
    a (pid, start) with a remembered one is the same launch."""
    path = os.path.join(STATE, "launches-" + hashlib.sha256((session_id or "").encode()).hexdigest()[:32] + ".json")
    old = []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == 2 and isinstance(data.get("calls"), list):
            old = [c for c in data["calls"] if isinstance(c, dict) and isinstance(c.get("startMs"), (int, float))
                   and c["startMs"] >= since and c.get("kind") in ("codex", "agy", "bench")
                   and isinstance(c.get("ids"), list) and all(isinstance(i, list) and len(i) == 2 for i in c["ids"])]
    except (OSError, ValueError):
        pass
    if not live:
        return old
    merged = [dict(c) for c in old]
    for launch in live:
        ids = {tuple(i) for i in launch["ids"]}
        same = next((c for c in merged if ids & {tuple(i) for i in c["ids"]}), None)
        if same is None:
            merged.append(launch)
            continue
        start = min(same["startMs"], launch["startMs"])
        same.update({**launch, "atMs": start, "startMs": start,
                     "ids": [list(i) for i in sorted(ids | {tuple(i) for i in same["ids"]})]})
    keep = [{k: v for k, v in c.items() if k != "alive"} for c in merged]
    if keep != old:
        tmp = path + ".%s.tmp" % os.getpid()
        try:
            os.makedirs(STATE, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 2, "calls": keep}, f)
            os.replace(tmp, path)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
    return merged


def same_launch(c, p):
    """Whether transcript call `c` started process launch `p`."""
    if c["kind"] != p["kind"] or not p["startMs"] - MATCH_AFTER_MS <= c["atMs"] <= p["startMs"] + 2000:
        return False
    if c["kind"] == "bench":
        return (c["agent"], c["task"], bool(c.get("control"))) == (p["agent"], p["task"], bool(p.get("control"))) \
            and norm_path(c.get("repo")) == norm_path(p.get("repo"))
    pa, pb = prompts(c), prompts(p)
    if pa and pb and not any(same_prompt(x, y) for x in pa for y in pb):
        return False
    if c["kind"] == "agy":
        a = {norm_path(x) for x in c.get("cwd") or []} - {None}
        b = {norm_path(x) for x in p.get("cwd") or []} - {None}
        return not a or not b or bool(a & b)
    a, b = norm_path(c.get("cwd")), norm_path(p.get("cwd"))
    return not a or not b or a == b


def merge_launches(calls, launches, unparsed=()):
    """Transcript calls and process launches. A launch takes the time (so bursts pair as before),
    subagent (`via`) and missing fields of the command that started it. Commands and launches
    that could match each other form a group: an even group pairs in time order, like
    pair_calls; in an uneven one each launch takes the latest free command, and `via` only when
    the group's commands agree on it. A launch no parsed command explains takes the subagent of
    the unparsed launch commands (xargs, loops) just before it, when they agree."""
    launches = sorted(launches, key=lambda c: c["startMs"])
    edges = [[i for i, c in enumerate(calls) if same_launch(c, p)] for p in launches]
    group = {}  # union-find over ("p", i) and ("c", j)

    def find(x):
        while group.get(x, x) != x:
            x = group[x]
        return x

    for k, e in enumerate(edges):
        for i in e:
            group[find(("c", i))] = find(("p", k))
    members = {}
    for k, e in enumerate(edges):
        if e:
            members.setdefault(find(("p", k)), ([], set()))[0].append(k)
            members[find(("p", k))][1].update(e)
    pair, vias, used = {}, {}, set()
    for ks, cs in members.values():
        cs = sorted(cs, key=lambda i: calls[i]["atMs"])
        if len(ks) == len(cs) and all(i in edges[k] for k, i in zip(ks, cs)):
            pair.update(zip(ks, cs))
            vias.update((k, calls[i].get("via")) for k, i in zip(ks, cs))
            continue
        agreed = {calls[i].get("via") for i in cs}
        for k in ks:
            free = [i for i in edges[k] if i not in used]
            if free:
                pair[k] = max(free, key=lambda i: calls[i]["atMs"])
                used.add(pair[k])
            vias[k] = agreed.pop() if len(agreed) == 1 else None
    used = set(pair.values())
    out = []
    for k, p in enumerate(launches):
        merged = dict(p)
        if k in pair:
            c = calls[pair[k]]
            merged["atMs"] = c["atMs"]
            for f in ("brief", "prompt", "cwd", "model", "effort"):
                if c.get(f) and not merged.get(f):
                    merged[f] = c[f]
        if edges[k]:
            merged["via"] = vias.get(k)
        else:
            found = {v for at, kind, v in unparsed
                     if kind == p["kind"] and p["startMs"] - MATCH_AFTER_MS <= at <= p["startMs"] + 2000}
            merged["via"] = found.pop() if len(found) == 1 else None
        out.append(merged)
    return [c for i, c in enumerate(calls) if i not in used] + out


def session_calls(session_id):
    """The session's `codex exec` calls: when, the -C dir, and the brief fed on stdin.
    A bench.py launch counts as a call with only its bench dir."""
    return [c if c["kind"] == "codex" else {"atMs": c["atMs"], "kind": "codex", "cwd": c["cwd"], "via": c.get("via")}
            for c in session_commands(session_id)
            if c["kind"] == "codex" or (c["kind"] == "bench" and c["agent"] == "codex")]


def expand(text, env):
    """Fills in `$VAR` / `${VAR}` from the command's own `VAR=value` assignments."""
    return VAR.sub(lambda m: env.get(m.group(1), m.group(0)), text)


def shell_segments(command):
    """Words and boundaries, keeping quoted newlines and heredoc bodies intact."""
    segments, words, word = [], [], []
    quote, started, i = None, False, 0
    body_tag, strip_tabs = None, False

    def finish_word():
        nonlocal word, started, body_tag, strip_tabs
        if started:
            value = "".join(word)
            if words and words[-1] in ("<<", "<<-"):
                body_tag, strip_tabs = value, words[-1] == "<<-"
            words.append(value)
        word, started = [], False

    while i < len(command):
        ch = command[i]
        if ch in ("\\", "`") and quote != "'" and i + 1 < len(command):
            if command.startswith("\n", i + 1) or command.startswith("\r\n", i + 1):
                i += 2 if command.startswith("\n", i + 1) else 3
                continue
            if command[i + 1] in (quote, '"', "'", " ", "\t", ";", "|", "&"):
                word.append(command[i + 1])
                started = True
                i += 2
                continue
        if quote:
            if ch == quote:
                quote = None
            else:
                word.append(ch)
            i += 1
            continue
        if ch in ('"', "'"):
            quote, started = ch, True
        elif ch == "#" and not started:
            i = command.find("\n", i)
            if i < 0:
                break
            continue
        elif ch in " \t\r":
            finish_word()
        elif ch in ";|&()\n":
            finish_word()
            if words:
                segments.append({"words": words, "complete": True, "body": None, "end": ch})
                words = []
            if ch == "\n" and body_tag:
                body, end = [], i + 1
                closed = False
                while end < len(command):
                    stop = command.find("\n", end)
                    stop = len(command) if stop < 0 else stop
                    line = command[end:stop].rstrip("\r")
                    check = line.lstrip("\t") if strip_tabs else line
                    end = min(stop + 1, len(command))
                    if check == body_tag:
                        closed = True
                        break
                    body.append(check)
                target = next((x for x in reversed(segments) if "<<" in x["words"] or "<<-" in x["words"]), None)
                if target is not None:
                    target["body"] = "\n".join(body) if closed else None
                    target["complete"] = closed
                body_tag = None
                i = end
                continue
        elif ch in "<>":
            finish_word()
            op = ch
            if i + 1 < len(command) and command[i + 1] == ch:
                op += ch
                i += 1
                if op == "<<" and i + 1 < len(command) and command[i + 1] == "-":
                    op += "-"
                    i += 1
            words.append(op)
        else:
            word.append(ch)
            started = True
        i += 1
    finish_word()
    if words:
        segments.append({"words": words, "complete": quote is None and body_tag is None, "body": None})
    return segments


def shell_words(command):
    return [w for s in shell_segments(command) for w in s["words"]]


def resolve_path(path, cwd=None):
    """An absolute path, or None when the shell would have expanded something we can't
    ($HOME-style variables, PowerShell expressions), so a guess never hides a run."""
    paths = ntpath if os.name == "nt" else posixpath
    path = host_path(path)
    if path == "~" or path.startswith(("~/", "~\\")):
        path = os.path.expanduser(path)
    if re.search(r"[$`]", path) or path.startswith("~"):
        return None
    if paths.isabs(path):
        return paths.normpath(path)
    return paths.normpath(paths.join(cwd, path)) if cwd else None


def brief_text(path, cwd=None):
    """Read a small regular redirect target relative to the shell's cwd."""
    path = resolve_path(path, cwd)
    if not path:
        return None
    try:
        if os.path.isfile(path) and os.path.getsize(path) <= BRIEF_BYTES:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read(2000)
    except OSError:
        pass
    return None


def exec_args(words, env, call):
    """Keep a positional prompt and skip option values in either shell."""
    if isinstance(words, str):
        words = shell_words(words)
    positional, i, options = [], 0, True
    while i < len(words):
        word = words[i]
        if word in ("<", ">", ">>", "<<", "<<-"):
            break
        flag, sep, value = word.partition("=")
        if options and word == "--":
            options = False
        elif options and flag in VALUE_FLAGS:
            if not sep:
                i += 1
                value = words[i] if i < len(words) else ""
            if flag in ("-C", "--cd") and value:
                call["cwd"] = resolve_path(expand(value, env), call.get("cwd"))
        elif not options or not word.startswith("-"):
            positional.append(expand(word, env))
        i += 1
    if positional:
        call["prompt"] = norm_text(" ".join(positional))


def looks_like_launch(command, depth=0):
    """The kind of run a command starts somewhere in its words ("codex", "agy", "bench"), even
    where parsed_calls can't follow it (`xargs codex exec`, `for t in ...; do agy -p "$t"`,
    `sh -c '...'`), or None. Text that only mentions one, in quotes or a heredoc, is a single
    word and doesn't count."""
    for seg in shell_segments(command):
        words = seg["words"]
        for i, w in enumerate(words):
            name = re.sub(r"\.(exe|cmd)$", "", re.split(r"[\\/]", w)[-1].lower())
            if name == "codex" and "exec" in words[i + 1:]:
                return "codex"
            if name == "agy" and any(r in ("-p", "--print", "--prompt") or r.startswith(("--print=", "--prompt="))
                                     for r in words[i + 1:]):
                return "agy"
            if re.fullmatch(r"python[\d.]*w?|pyw?", name):
                for j in range(i + 1, len(words) - 1):
                    if re.split(r"[\\/]", words[j])[-1] == "bench.py" and words[j + 1] == "run":
                        return "bench"
            if depth < 3 and i and words[i - 1].lower() in ("-c", "-command", "/c") and re.search(r"\s", w):
                kind = looks_like_launch(w, depth + 1)
                if kind:
                    return kind
    return None


def parsed_calls(at_ms, command, cwd=None):
    """Persist only matching fields; never keep the original shell command."""
    out, env, previous = [], {}, []
    for seg in shell_segments(command):
        words = list(seg["words"])
        while words and re.match(r"^[A-Za-z_]\w*=", words[0]):
            key, value = words.pop(0).split("=", 1)
            env[key] = expand(value, env)
        if words and words[0] == "env":
            words.pop(0)
            while words and re.match(r"^[A-Za-z_]\w*=", words[0]):
                key, value = words.pop(0).split("=", 1)
                env[key] = expand(value, env)
        if words and words[0] == "nohup":
            words.pop(0)
        if len(words) >= 2 and words[0] == "timeout":
            words = words[2:]
        if not words:
            continue
        name = re.split(r"[\\/]", words[0])[-1].lower()
        name = re.sub(r"\.(exe|cmd)$", "", name)
        if name in ("cd", "set-location"):
            args = [w for w in words[1:] if w.lower() not in ("-path", "-literalpath")]
            if args:
                cwd = resolve_path(expand(args[0], env), cwd)
        elif re.fullmatch(r"python[\d.]*w?|pyw?", name):
            # llm-blender-bench: `python tools/bench.py run <agent> <task>` starts that agent's CLI
            # headless, working in <repo>/benches/<agent>/<task> (<task>_noguide for --no-guide control runs)
            args = [w for w in words[1:] if not w.startswith("-")]
            control = "--no-guide" in words
            if (len(args) >= 4 and re.split(r"[\\/]", args[0])[-1] == "bench.py" and args[1] == "run"
                    and args[2] in ("claude", "codex", "agy")):
                script = resolve_path(expand(args[0], env), cwd)
                if script:
                    paths = ntpath if os.name == "nt" else posixpath
                    repo = paths.dirname(paths.dirname(script))
                    out.append({"atMs": at_ms, "kind": "bench", "agent": args[2], "task": args[3], "repo": repo,
                                "control": control,
                                "cwd": paths.join(repo, "benches", args[2], args[3] + ("_noguide" if control else ""))})
        elif name in ("codex", "agy"):
            call = {"atMs": at_ms, "kind": name,
                    "cwd": host_path(expand(cwd, env)) if cwd else None}
            if name == "codex":
                i = 1
                while i < len(words) and words[i].startswith("-"):
                    flag, sep, _ = words[i].partition("=")
                    i += 2 if flag in VALUE_FLAGS and not sep else 1
                if i >= len(words) or words[i] != "exec":
                    previous = words
                    continue
                exec_args(words[1:i], env, call)
                exec_args(words[i + 1:], env, call)
            else:
                dirs, printed, i = [], False, 1
                while i < len(words):
                    flag, sep, value = words[i].partition("=")
                    if flag in ("-p", "--print", "--prompt", "--add-dir", "--model", "--effort"):
                        if not sep:
                            i += 1
                            value = words[i] if i < len(words) else ""
                        value = expand(value, env)
                        if flag == "--add-dir":
                            dirs.append(resolve_path(value, call["cwd"]))
                            dirs = [d for d in dirs if d]
                        elif flag in ("-p", "--print", "--prompt"):
                            printed = True
                            call["prompt"] = norm_text(value)
                        elif value:
                            call[flag[2:]] = value[:60]  # --model / --effort, shown on the row
                    i += 1
                if not printed:
                    previous = words
                    continue
                call["cwd"] = list(dict.fromkeys(dirs + ([call["cwd"]] if call["cwd"] else [])))
            if seg["complete"]:
                if seg["body"] is not None:
                    call["brief"] = norm_text(seg["body"])
                elif "<" in words:
                    i = words.index("<") + 1
                    if i < len(words):
                        # The shell opens redirects from its own cwd, not codex's -C dir.
                        call["brief"] = norm_text(brief_text(expand(words[i], env), cwd))
                elif previous and previous[0].lower() in ("cat", "gc", "get-content", "type"):
                    args = [w for w in previous[1:] if not w.startswith("-")]
                    if args:
                        call["brief"] = norm_text(brief_text(expand(args[0], env), cwd))
            else:
                call.pop("prompt", None)
            out.append(call)
        previous = words if seg.get("end") == "|" else []
    return out


def exec_calls(at_ms, command, cwd=None):
    return [c for c in parsed_calls(at_ms, command, cwd) if c["kind"] == "codex"]


def thread_identity(thread, budget):
    """Fill missing cwd/first prompt from a bounded rollout header."""
    cwd, prompt = thread.get("cwd"), thread.get("first_user_message")
    if cwd and prompt or budget[0] <= 0:
        return cwd, prompt
    try:
        with open(thread["rollout_path"], "rb") as f:
            raw = f.read(min(HEAD_BYTES, budget[0]))
        budget[0] -= len(raw)
    except (OSError, TypeError, KeyError):
        return cwd, prompt
    for line in raw.splitlines():
        try:
            ev = obj(json.loads(line))
        except ValueError:
            continue
        p = obj(ev.get("payload"))
        if ev.get("type") in ("session_meta", "turn_context"):
            cwd = cwd or p.get("cwd")
        if p.get("type") == "user_message":
            prompt = prompt or p.get("message")
        if p.get("role") == "user" and isinstance(p.get("content"), list):
            prompt = prompt or " ".join(str(obj(c).get("text") or "") for c in p["content"])
        if cwd and prompt:
            break
    return cwd, prompt


def prompts(call):
    """The call's prompt texts, each cut at the first shell substitution ($(...), $VAR, `...`):
    the shell expanded those, so only the literal text before them can match the run's."""
    out = []
    for k in ("prompt", "brief"):
        text = norm_text(call.get(k))
        if k == "prompt":
            text = re.split(r"[$`]", text, maxsplit=1)[0].rstrip()
        if text:
            out.append(text)
    return out


def same_prompt(a, b):
    n = min(len(a), len(b))
    return bool(n and a[:n] == b[:n])


def pair_calls(roots, calls, id_key, time_key, compatible, matches, after):
    """Bound sequential calls; pair equal-sized ambiguous bursts in time order."""
    calls = sorted(calls, key=lambda c: c["atMs"])
    roots = sorted(roots, key=lambda r: r[time_key])
    edges = []
    for i, c in enumerate(calls):
        at, cursor, stop = c["atMs"], c["atMs"], None
        for other in calls[i + 1:]:
            if not compatible(c, other):
                continue
            if other["atMs"] - cursor > MATCH_BEFORE_MS:
                stop = other["atMs"]
                break
            cursor = other["atMs"]
        edges.append({j for j, r in enumerate(roots)
                      if at - MATCH_BEFORE_MS <= r[time_key] <= at + after(c)
                      and (stop is None or r[time_key] < stop) and matches(c, r)})
    claimed, seen = {}, set()
    for i in range(len(calls)):
        if i in seen or not edges[i]:
            continue
        group, candidates = {i}, set(edges[i])
        while True:
            more = {j for j, e in enumerate(edges) if j not in group and e & candidates}
            if not more:
                break
            group |= more
            candidates.update(k for j in more for k in edges[j])
        seen |= group
        ordered = list(zip(sorted(group), sorted(candidates)))
        if len(group) == len(candidates) and all(j in edges[k] for k, j in ordered):
            claimed.update((roots[j][id_key], calls[k]) for k, j in ordered)
    return claimed


def ours(rows, calls):
    """Thread id -> the call that started it, for the session's calls and their descendants."""
    roots = [t for t in rows if parent_of(t["source"]) is None and t["created_at_ms"]]
    identities, budget = {}, [QUOTA_BYTES]

    def compatible(a, b):
        ac, bc = norm_path(a.get("cwd")), norm_path(b.get("cwd"))
        ap, bp = prompts(a), prompts(b)
        return (not ac or not bc or ac == bc) and (not ap or not bp or any(same_prompt(x, y) for x in ap for y in bp))

    def matches(c, t):
        cwd, wanted = norm_path(c.get("cwd")), prompts(c)
        if c.get("cwd") and cwd is None:
            return False
        have_cwd, have_prompt = t.get("cwd"), t.get("first_user_message")
        if (cwd and not have_cwd) or (wanted and not have_prompt):
            if t["id"] not in identities:
                identities[t["id"]] = thread_identity(t, budget)
            have_cwd, have_prompt = identities[t["id"]]
        return (not cwd or norm_path(have_cwd) == cwd) and (not wanted or any(same_prompt(p, norm_text(have_prompt)) for p in wanted))

    claimed = pair_calls(roots, calls, "id", "created_at_ms", compatible, matches,
                         lambda c: MATCH_AFTER_MS if c.get("cwd") or prompts(c) else BARE_AFTER_MS)
    grew = True
    while grew:
        grew = False
        for t in rows:
            if t["id"] not in claimed and parent_of(t["source"]) in claimed:
                claimed[t["id"]] = claimed[parent_of(t["source"])]
                grew = True
    return claimed


def quota_paths(rows, now):
    """Newest rollouts from the database, then recent on-disk sessions."""
    paths = {t["rollout_path"]: (t["updated_at_ms"] or 0) / 1000 for t in rows if t.get("rollout_path")}
    for days in range(8):
        day = datetime.fromtimestamp(now) - timedelta(days=days)
        pattern = os.path.join(HOME, "sessions", day.strftime("%Y/%m/%d"), "*.jsonl")
        for path in glob.glob(pattern):
            try:
                paths[path] = max(paths.get(path, 0), os.path.getmtime(path))
            except OSError:
                pass
    return [p for p in sorted(paths, key=paths.get, reverse=True)
            if paths[p] * 1000 >= now * 1000 - QUOTA_LOOKBACK_MS][:QUOTA_FILES]


def scan(session_id, rows=None):
    now = time.time()
    rows = threads(QUOTA_LOOKBACK_MS) if rows is None else rows
    recent_rows = [t for t in rows if (t["updated_at_ms"] or 0) > now * 1000 - LOOKBACK_MS]
    mine = ours(recent_rows, session_calls(session_id)) if recent_rows else {}
    agents, limits, limits_at = [], None, 0
    tails = {}
    for t in recent_rows:
        if t["id"] not in mine:
            continue
        path = t["rollout_path"]
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        updated = max(mtime, (t["updated_at_ms"] or 0) / 1000)
        try:
            life, info, rl, last_at, rl_at = read_tail(path, [2 * 1024 * 1024])
            tails[path] = (life, info, rl, last_at, rl_at)
        except OSError:
            continue
        active_at = max(updated, last_at)
        recent = now - active_at < STALE_S
        if rl and (rl_at or active_at) > limits_at:
            limits, limits_at = rl, rl_at or active_at
        if not recent or life in ("task_complete", "turn_aborted"):
            continue
        total = obj((info or {}).get("total_token_usage"))
        last = obj((info or {}).get("last_token_usage"))
        window = (info or {}).get("model_context_window") or 0
        ctx = round(100 * last.get("input_tokens", 0) / window) if window and last else None
        agents.append({
            "id": t["id"],
            "task": task_label(t["title"], t["first_user_message"])
            or (t["agent_path"] or "").rstrip("/").rsplit("/", 1)[-1].replace("_", " "),
            "parentId": parent_of(t["source"]),
            "nickname": t["agent_nickname"],
            "model": t["model"],
            "effort": t["reasoning_effort"],
            # new tokens only: every turn re-sends the whole context, mostly from cache
            "tokens": fresh_tokens(total) or t["tokens_used"] or 0,
            "ctxPercent": ctx,
            "startedAtMs": t["created_at_ms"] or 0,
            "updatedAtMs": int(active_at * 1000),
            "now": last_action(path),
            "via": mine[t["id"]].get("via"),
        })
    budget = QUOTA_BYTES
    for path in quota_paths(rows, now):
        if budget <= 0:
            break
        try:
            if path in tails:
                _, _, rl, last_at, rl_at = tails[path]
            else:
                allowance = [min(QUOTA_BYTES // QUOTA_FILES, budget)]
                before = allowance[0]
                _, _, rl, last_at, rl_at = read_tail(path, allowance)
                budget -= before - allowance[0]
            at = rl_at or last_at or os.path.getmtime(path)
            if rl and at > limits_at:
                limits, limits_at = rl, at
        except OSError:
            continue
    windows = []
    if limits:
        for key in ("primary", "secondary"):
            w = limits.get(key)
            if isinstance(w, dict) and w.get("window_minutes"):
                windows.append({
                    "minutes": w["window_minutes"],
                    "usedPercent": w.get("used_percent"),
                    "resetsAt": w.get("resets_at"),
                })
    agents.sort(key=lambda a: a["startedAtMs"])
    out = {
        "nowMs": int(now * 1000),
        "agents": agents,
        "limits": windows,
        "limitsAtMs": int(limits_at * 1000),
        "plan": (limits or {}).get("plan_type"),
    }
    return out


def main():
    session_id = sys.argv[1] if len(sys.argv) > 1 else None
    sys.stdout.write(json.dumps(scan(session_id)))


if __name__ == "__main__":
    main()
