"""agy quota for the status line, from `agy -p /usage --output-format json`.

agy keeps its quota only in memory, so `refresh()` asks a print-mode agy for it
(a read-only command: no agent turn, no quota spent, about 2 s) and writes
agy_usage.json. Quota only moves while agy runs, so `cached()` starts a
detached refresh when an agy conversation changed since the last attempt (at
most every MIN_S), and otherwise only every REFRESH_S. A window that resets in
between shows as reset from its cached resetsAt.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
# The plugin folder may be a read-only install, so the cache lives with Claude's own files.
STATE = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"), "agent-boxes")
CACHE = os.path.join(STATE, "agy_usage.json")
LOCK = os.path.join(STATE, "agy_usage.lock")
REFRESH_S = 60 * 60      # with no agy activity
MIN_S = 2 * 60           # between refreshes while agy runs
TIMEOUT_S = 60
AGY = shutil.which("agy") or (os.path.join(os.environ["LOCALAPPDATA"], "agy", "bin", "agy.exe")
                             if os.name == "nt" and os.environ.get("LOCALAPPDATA") else None)
_LOCKS = {}

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
# Never DETACHED_PROCESS on Windows: it makes Windows ignore CREATE_NO_WINDOW, so a console child
# (agy) gets a visible terminal window of its own.
DETACH = ({"creationflags": CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
          else {"start_new_session": True})
NO_WINDOW = {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}


def read_cache():
    try:
        with open(CACHE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def write_cache(groups, failed=False):
    now = int(time.time() * 1000)
    old = read_cache() or {}
    success = old.get("lastSuccessAtMs", old.get("atMs", 0) if not old.get("failedAtMs") else 0)
    data = {"lastAttemptAtMs": now, "lastSuccessAtMs": success if failed else now, "groups": groups}
    tmp = CACHE + ".%s.tmp" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE)


def unlock(token):
    fd = _LOCKS.pop(token, None)
    if fd is not None:
        os.close(fd)  # the OS releases our lock; never unlink a successor's file


def take_lock():
    """The OS owns this lock's lifetime, including after a refresh crashes."""
    fd = None
    try:
        os.makedirs(STATE, exist_ok=True)
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        token = "%s-%s" % (os.getpid(), secrets.token_hex(16))
        os.write(fd, token.encode("ascii"))
        os.ftruncate(fd, len(token))
        _LOCKS[token] = fd
        return token
    except OSError:
        if fd is not None:
            os.close(fd)
        return None


def attempt_ms(data):
    at = (data or {}).get("lastAttemptAtMs", (data or {}).get("atMs", 0))
    return at if isinstance(at, (int, float)) else 0


def stale(data, activity_ms=0):
    """Due for a refresh: hourly, or sooner once agy has run since the last attempt."""
    at = attempt_ms(data)
    age = time.time() - at / 1000
    return age > REFRESH_S or (age > MIN_S and activity_ms > at)


def cached(activity_ms=0):
    """Read usage, starting a detached refresh when it is due.

    activity_ms: when an agy conversation last changed (agy_scan rows' newest modifiedAtMs).
    """
    data = read_cache()
    token = take_lock() if stale(data, activity_ms) and AGY and os.path.isfile(AGY) else None
    if token:
        try:
            data = read_cache()
            if not stale(data, activity_ms):
                return data
            # Record before launch too: even a child that fails to start must back off.
            write_cache((data or {}).get("groups") or {}, failed=True)
            subprocess.Popen(
                [sys.executable, "-E", os.path.abspath(__file__)],
                close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                **DETACH,
            )
        except OSError:
            pass
        finally:
            unlock(token)
    return data


def epoch(stamp):
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def parse(usage):
    """agy's `/usage` command data -> {'gemini': {'5h': {'used': 19.5, 'resetsAt': ...}, '7d': {...}}, 'claude/gpt': {...}}"""
    groups = {}
    for g in (usage or {}).get("groups") or []:
        name = (g.get("name") or "").lower()
        if name.endswith(" models"):
            name = name[: -len(" models")]
        name = name.replace(" and ", "/")
        windows = {}
        for b in g.get("buckets") or []:
            key = {"weekly": "7d", "5h": "5h"}.get(b.get("window"))
            left = b.get("remaining_fraction")
            if key is None or isinstance(left, bool) or not isinstance(left, (int, float)):
                continue
            w = windows[key] = {"used": round(100 * (1 - left), 2)}
            # An untouched window's reset_time just rolls forward, so keep it only once quota is used.
            resets = epoch(b.get("reset_time")) if w["used"] > 0 else None
            if resets is not None:
                w["resetsAt"] = resets
        if name and windows:
            groups[name] = windows
    return groups


def usage_data():
    """The `/usage` command's data from a print-mode agy, or None."""
    r = subprocess.run(
        [AGY, "-p", "/usage", "--output-format", "json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
        timeout=TIMEOUT_S, cwd=os.path.expanduser("~"), **NO_WINDOW,
    )
    out = json.loads(r.stdout)
    return (out.get("command") or {}).get("data") if isinstance(out, dict) else None


def refresh():
    token = take_lock()
    # The launching parent releases its short lock just after Popen returns.
    for _ in range(20):
        if token:
            break
        time.sleep(0.1)
        token = take_lock()
    if not token:
        return
    try:
        old = read_cache() or {}
        try:
            groups = parse(usage_data())
        except Exception:
            groups = {}
        write_cache(groups or old.get("groups") or {}, failed=not groups)
    except OSError:
        pass
    finally:
        unlock(token)


if __name__ == "__main__":
    refresh()
