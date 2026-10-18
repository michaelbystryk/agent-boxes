"""This session's llm-blender-bench builds (`python tools/bench.py run <agent> <task>`), while they run.

bench.py starts the agent CLI headless and tees its JSON events to
<repo>/benches/<agent>/<task>/runs/<n>/agent_log.jsonl, then appends a row to
<repo>/results/<task>/runs.json when the agent exits. Headless agy leaves its
conversation DB row idle for the whole run and headless `claude -p` is not a subagent
of this session, so that log is the only liveness signal for them.
"""
import json
import os
import time

import codex_scan

STALE_S = codex_scan.STALE_S
TAIL = 4 * 1024 * 1024
WIDTH = 60
# the event each CLI writes last
DONE = {"claude": ("type", "result"), "agy": ("event", "result")}


def run_dir(bench, at_ms):
    """The run the call made: the lowest-numbered runs/<n> whose prompt.md was written after it."""
    runs = os.path.join(bench, "runs")
    try:
        names = sorted((n for n in os.listdir(runs) if n.isdigit()), key=int)
    except OSError:
        return None
    for n in names:
        try:
            if os.path.getmtime(os.path.join(runs, n, "prompt.md")) * 1000 >= at_ms - 5000:
                return os.path.join(runs, n)
        except OSError:
            continue
    return None


def finished(repo, task, run):
    try:
        with open(os.path.join(repo, "results", task, "runs.json"), encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return False
    want = codex_scan.norm_path(run)
    return isinstance(rows, list) and any(
        isinstance(r, dict) and isinstance(r.get("run_dir"), str)
        and codex_scan.norm_path(os.path.join(repo, r["run_dir"])) == want for r in rows)


def events(path):
    with open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - TAIL))
        raw = f.read()
    out = []
    for line in raw.splitlines():
        try:
            out.append(codex_scan.obj(json.loads(line)))
        except ValueError:
            continue
    return out


def flat(text):
    return codex_scan.short(" ".join((text or "").split()), WIDTH)


def named(tool, path):
    return codex_scan.short(f"{tool} {os.path.basename(path)}" if path else tool or "", WIDTH)


def claude_action(ev):
    for b in reversed(codex_scan.obj(ev.get("message")).get("content") or []):
        b = codex_scan.obj(b)
        if b.get("type") == "tool_use":
            i = codex_scan.obj(b.get("input"))
            if isinstance(i.get("command"), str):
                return "$ " + flat(i["command"])
            return named(b.get("name"), i.get("file_path") or i.get("path"))
    return None


def agy_action(ev):
    s = codex_scan.obj(ev.get("step_update"))
    if s.get("step_type") != "tool":
        return None
    p = codex_scan.obj(codex_scan.obj(s.get("tool_info")).get("parameters"))
    if isinstance(p.get("CommandLine"), str):
        return "$ " + flat(p["CommandLine"])
    return named(s.get("tool_name"), p.get("TargetFile") or p.get("AbsolutePath"))


def tool_calls(path):
    """Claude's tool calls over the whole log; image results make it outgrow any tail."""
    n = 0
    with open(path, "rb") as f:
        for line in f:
            if line.startswith(b'{"type":"assistant"') and b'"tool_use"' in line:
                try:
                    content = codex_scan.obj(json.loads(line).get("message")).get("content") or []
                except ValueError:
                    continue
                n += sum(1 for b in content if codex_scan.obj(b).get("type") == "tool_use")
    return n


def model_of(repo, agent):
    try:
        import tomllib

        with open(os.path.join(repo, "bench.toml"), "rb") as f:
            return tomllib.load(f)["agents"][agent]["model"]
    except Exception:
        return None


def runs(session_id, agent):
    """Agent rows (as boxes.agent_rows takes them) for this session's live bench runs of `agent`."""
    now = time.time()
    act = claude_action if agent == "claude" else agy_action
    key, done = DONE[agent]
    out, seen = [], set()
    for c in codex_scan.session_commands(session_id):
        if c["kind"] != "bench" or c["agent"] != agent:
            continue
        d = run_dir(c["cwd"], c["atMs"])
        if not d or d in seen:
            continue
        seen.add(d)
        log = os.path.join(d, "agent_log.jsonl")
        try:
            if now - os.path.getmtime(log) > STALE_S or finished(c["repo"], c["task"], d):
                continue
            evs = events(log)
        except OSError:
            continue
        if any(e.get(key) == done for e in evs[-3:]):
            continue
        row = {
            "id": d,
            "task": f"{c['task']} {'control run' if c.get('control') else 'run'} {os.path.basename(d)}",
            "parentId": None,
            "nickname": "bench",
            "model": model_of(c["repo"], agent),
            "effort": None,
            "startedAtMs": int(c["atMs"]),
            "now": next((a for a in map(act, reversed(evs)) if a), None),
        }
        if agent == "agy":
            row["steps"] = max([codex_scan.obj(e.get("step_update")).get("step_index") or 0 for e in evs] + [0])
        else:
            row["count"] = f"{tool_calls(log)} tools"
        out.append(row)
    return out
