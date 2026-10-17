"""agy quota for the status line, read off agy's own `/usage` screen.

agy keeps its quota only in memory and `/usage` works only in the interactive
app, so `refresh()` starts agy in a hidden terminal, types `/usage`, parses
the screen and writes agy_usage.json. `cached()` only reads that file and
starts a detached refresh when it is older than REFRESH_S.

Optional: it needs `pyte` and a pty (`pywinpty` on Windows, the standard
`pty` module elsewhere). Without them the quota shows as unknown.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# The plugin folder may be a read-only install, so the cache lives with Claude's own files.
STATE = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude"), "agent-boxes")
CACHE = os.path.join(STATE, "agy_usage.json")
LOCK = os.path.join(STATE, "agy_usage.lock")
REFRESH_S = 10 * 60
AGY = shutil.which("agy") or (os.path.join(os.environ["LOCALAPPDATA"], "agy", "bin", "agy.exe")
                             if os.name == "nt" and os.environ.get("LOCALAPPDATA") else None)
_LOCKS = {}
LOG = os.path.join(STATE, "agy_usage.log")
COLS, ROWS = 140, 60

DURATION = re.compile(r"(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?")


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
    """The OS owns this lock's lifetime, including after a scraper crashes."""
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


def cache_age(data):
    at = (data or {}).get("lastAttemptAtMs", (data or {}).get("atMs", 0))
    return time.time() - (at if isinstance(at, (int, float)) else 0) / 1000


def cached():
    """Read usage, starting a detached refresh only when the last attempt is stale."""
    data = read_cache()
    token = take_lock() if cache_age(data) > REFRESH_S and AGY and os.path.isfile(AGY) and can_scrape() else None
    if token:
        try:
            data = read_cache()
            if cache_age(data) <= REFRESH_S:
                return data
            # Record before launch too: even a child that fails to start must back off.
            write_cache((data or {}).get("groups") or {}, failed=True)
            detach = (
                {"creationflags": 0x00000008 | 0x08000000}  # DETACHED_PROCESS | CREATE_NO_WINDOW
                if os.name == "nt" else {"start_new_session": True}
            )
            subprocess.Popen(
                [sys.executable, "-E", os.path.abspath(__file__)],
                close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                **detach,
            )
        except OSError:
            pass
        finally:
            unlock(token)
    return data


def can_scrape():
    """Whether the hidden-terminal scrape can run here: pyte, and a pty for this platform."""
    try:
        import pyte  # noqa: F401
        if os.name == "nt":
            import winpty  # noqa: F401
        else:
            import pty  # noqa: F401
    except ImportError:
        return False
    return True


def seconds(text):
    m = DURATION.fullmatch(text.strip())
    if not m or not any(m.groups()):
        return None
    d, h, mi = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60


def parse(lines, now):
    """{'gemini': {'5h': {'used': 19.5, 'resetsAt': ...}, '7d': {...}}, 'claude/gpt': {...}}"""
    groups, group, window = {}, None, None
    for line in lines:
        s = line.strip()
        m = re.fullmatch(r"([A-Z][A-Z /&-]*) MODELS", s)
        if m:
            name = m.group(1).lower().replace(" and ", "/")
            group = groups.setdefault(name, {})
            window = None
            continue
        if group is None:
            continue
        if s.startswith("Weekly Limit"):
            window = group.setdefault("7d", {})
        elif s.startswith("Five Hour Limit"):
            window = group.setdefault("5h", {})
        elif window is not None:
            m = re.search(r"\]\s*([\d.]+)%", s)
            if m:
                window["used"] = round(100 - float(m.group(1)), 2)
            m = re.match(r"Refreshes in (.+)", s)
            if m and seconds(m.group(1)) is not None:
                window["resetsAt"] = now + seconds(m.group(1))
    groups = {g: {key: w for key, w in windows.items() if "used" in w}
              for g, windows in groups.items()}
    return {g: w for g, w in groups.items() if w}


class PosixPty:
    """The few calls of winpty's PtyProcess that screen_text uses, over the standard pty module."""

    def __init__(self, argv, rows, cols):
        import fcntl
        import pty
        import struct
        import termios

        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.chdir(os.path.expanduser("~"))
                os.execvp(argv[0], argv)
            except BaseException:
                os._exit(127)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def read(self, n):
        try:
            data = os.read(self.fd, n)
        except OSError:
            raise EOFError
        if not data:
            raise EOFError
        return data.decode("utf-8", "replace")

    def write(self, text):
        os.write(self.fd, text.encode("utf-8"))

    def terminate(self, force=False):
        import signal

        sig = signal.SIGKILL if force else signal.SIGTERM
        try:
            os.killpg(self.pid, sig)
        except OSError:
            try:
                os.kill(self.pid, sig)
            except OSError:
                pass
        try:
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        try:
            os.close(self.fd)
        except OSError:
            pass


def spawn(argv, rows, cols):
    if os.name == "nt":
        from winpty import PtyProcess

        return PtyProcess.spawn(argv, dimensions=(rows, cols), cwd=os.path.expanduser("~"))
    return PosixPty(argv, rows, cols)


def screen_text():
    """Runs agy in a hidden terminal and returns the `/usage` screen's lines."""
    import pyte

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    chunks = []
    try:  # agy may append to its log; keep only the latest scrape's
        open(LOG, "w").close()
    except OSError:
        pass
    p = spawn([AGY, "--log-file", LOG], ROWS, COLS)

    def reader():
        while True:
            try:
                d = p.read(65536)
            except EOFError:
                return
            if d:
                chunks.append(d)

    def wait(pred, secs):
        end = time.time() + secs
        while time.time() < end:
            while chunks:
                stream.feed(chunks.pop(0))
            text = "\n".join(screen.display)
            if pred(text):
                return text
            time.sleep(0.2)
        return None

    threading.Thread(target=reader, daemon=True).start()
    try:
        if not wait(lambda t: "for shortcuts" in t, 40):
            return None
        p.write("/usage")
        time.sleep(0.5)
        p.write("\r")
        # both groups' 5-hour windows drawn, each with its reset line
        done = lambda t: t.count("Five Hour Limit") >= 2 and len(re.findall(r"Refreshes in|Quota available", t)) >= 4
        text = wait(done, 30) or wait(lambda t: False, 2) or "\n".join(screen.display)
        return text.splitlines()
    finally:
        for key in ("\x1b", "\x03", "\x03"):
            try:
                p.write(key)
            except Exception:
                pass
            time.sleep(0.3)
        try:
            p.terminate(force=True)
        except Exception:
            pass


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
        now = time.time()
        try:
            groups = parse(screen_text() or [], now)
        except Exception:
            groups = {}
        write_cache(groups or old.get("groups") or {}, failed=not groups)
    except OSError:
        pass
    finally:
        unlock(token)


if __name__ == "__main__":
    refresh()
