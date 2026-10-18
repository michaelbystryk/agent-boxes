"""Live processes this Claude Code chat started, however they were launched.

Claude Code puts CLAUDE_CODE_SESSION_ID and CLAUDE_PID in the environment of every command
it runs, and children inherit it: through xargs, loops, scripts, and after the shell that
started them has exited. So a process belongs to the chat when its own environment says so;
the process tree is used only to tell a launcher from the process it starts.

Standard library only: ctypes on Windows and macOS, /proc on Linux. Each process is read on
its own and any failure skips just that process; a platform that can't be read gives [].
"""
import os
import re
import struct
import sys
import time

# Names worth reading the arguments of: the CLIs, and the interpreters that launch them.
CANDIDATE = re.compile(r"(codex[\w.-]*|agy|node|bun|python[\d.]*w?|pyw?)(\.exe)?")
BUDGET_S = 1.5
ENV_BYTES = 1 << 20


class Proc:
    __slots__ = ("pid", "ppid", "name", "startMs", "argv", "env", "cwd")

    def __init__(self, pid, ppid, name, start_ms=None):
        self.pid, self.ppid, self.name, self.startMs = pid, ppid, name, start_ms
        self.argv, self.env, self.cwd = [], {}, None


def environ(pairs):
    out = {}
    for item in pairs:
        key, sep, value = item.partition("=")
        if sep and key:
            out[key] = value
    return out


# --- Windows -------------------------------------------------------------------------------

def _windows():
    import ctypes
    from ctypes import wintypes

    if struct.calcsize("P") != 8:
        raise OSError("needs 64-bit Python")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    shell32 = ctypes.WinDLL("shell32")
    HANDLE, PVOID = wintypes.HANDLE, ctypes.c_void_p

    class ENTRY(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
                    ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
                    ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_wchar * 260)]

    class BASIC(ctypes.Structure):
        _fields_ = [("ExitStatus", PVOID), ("PebBaseAddress", PVOID), ("AffinityMask", PVOID),
                    ("BasePriority", PVOID), ("UniqueProcessId", PVOID), ("InheritedFrom", PVOID)]

    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.CreateToolhelp32Snapshot.restype = HANDLE
    for fn in (k32.Process32FirstW, k32.Process32NextW):
        fn.argtypes = [HANDLE, ctypes.POINTER(ENTRY)]
        fn.restype = wintypes.BOOL
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenProcess.restype = HANDLE
    k32.CloseHandle.argtypes = [HANDLE]
    k32.GetProcessTimes.argtypes = [HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k32.GetProcessTimes.restype = wintypes.BOOL
    k32.IsWow64Process.argtypes = [HANDLE, ctypes.POINTER(wintypes.BOOL)]
    k32.IsWow64Process.restype = wintypes.BOOL
    k32.ReadProcessMemory.argtypes = [HANDLE, PVOID, PVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.ReadProcessMemory.restype = wintypes.BOOL
    k32.LocalFree.argtypes = [PVOID]
    ntdll.NtQueryInformationProcess.argtypes = [HANDLE, wintypes.ULONG, PVOID, wintypes.ULONG,
                                                ctypes.POINTER(wintypes.ULONG)]
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    shell32.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)

    QUERY, LIMITED, VM_READ = 0x0400, 0x1000, 0x0010

    def snapshot():
        snap = k32.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
        if not snap or snap == HANDLE(-1).value:
            raise OSError("no process snapshot")
        out = {}
        try:
            e = ENTRY()
            e.dwSize = ctypes.sizeof(ENTRY)
            ok = k32.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                out[e.th32ProcessID] = Proc(e.th32ProcessID, e.th32ParentProcessID, e.szExeFile)
                ok = k32.Process32NextW(snap, ctypes.byref(e))
        finally:
            k32.CloseHandle(snap)
        return out

    def read(h, addr, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not addr or not k32.ReadProcessMemory(h, PVOID(addr), buf, size, ctypes.byref(got)) or got.value != size:
            raise OSError("unreadable")
        return buf.raw

    def text(h, raw, off):
        """A UNICODE_STRING (x64: u16 length, u16 max, pad, u64 buffer) inside `raw`."""
        length = min(struct.unpack_from("<H", raw, off)[0], 65534)
        ptr = struct.unpack_from("<Q", raw, off + 8)[0]
        return read(h, ptr, length).decode("utf-16-le", "replace") if length and ptr else ""

    def env_block(h, ptr, size):
        if 0 < size <= ENV_BYTES:
            raw = read(h, ptr, size)
        else:  # size unknown: page by page to the double NUL
            raw, addr = b"", ptr
            while len(raw) < ENV_BYTES:
                chunk = 4096 - addr % 4096
                try:
                    raw += read(h, addr, chunk)
                except OSError:
                    break
                addr += chunk
                if "\0\0" in raw[: len(raw) // 2 * 2].decode("utf-16-le", "replace"):
                    break
        block = raw[: len(raw) // 2 * 2].decode("utf-16-le", "replace")
        return block.split("\0\0", 1)[0].split("\0")

    def argv_of(line):
        n = ctypes.c_int()
        arr = shell32.CommandLineToArgvW(line, ctypes.byref(n))
        if not arr:
            return []
        try:
            return [arr[i] for i in range(n.value)]
        finally:
            k32.LocalFree(ctypes.cast(arr, PVOID))

    def details(p):
        h = k32.OpenProcess(QUERY | VM_READ, False, p.pid)
        if not h:
            raise OSError("no access")
        try:
            wow = wintypes.BOOL()
            if not k32.IsWow64Process(h, ctypes.byref(wow)) or wow.value:
                raise OSError("32-bit process")
            times = [wintypes.FILETIME() for _ in range(4)]
            if not k32.GetProcessTimes(h, *[ctypes.byref(t) for t in times]):
                raise OSError("no start time")
            ft = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            p.startMs = (ft - 116444736000000000) // 10000
            info, got = BASIC(), wintypes.ULONG()
            if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(got)):
                raise OSError("no process information")
            params = struct.unpack("<Q", read(h, info.PebBaseAddress + 0x20, 8))[0]
            # RTL_USER_PROCESS_PARAMETERS (x64): CurrentDirectory.DosPath 0x38, CommandLine 0x70,
            # Environment 0x80, EnvironmentSize 0x3F0
            raw = read(h, params, 0x3F8)
            p.cwd = text(h, raw, 0x38) or None
            p.argv = argv_of(text(h, raw, 0x70))
            p.env = environ(env_block(h, struct.unpack_from("<Q", raw, 0x80)[0],
                                      struct.unpack_from("<Q", raw, 0x3F0)[0]))
        finally:
            k32.CloseHandle(h)

    return snapshot, details


# --- Linux ---------------------------------------------------------------------------------

def _linux():
    hz = os.sysconf("SC_CLK_TCK")
    with open("/proc/stat") as f:
        boot = next(int(line.split()[1]) for line in f if line.startswith("btime "))

    def snapshot():
        out = {}
        for d in os.listdir("/proc"):
            if not d.isdigit():
                continue
            try:
                with open(f"/proc/{d}/stat", "rb") as f:
                    raw = f.read().decode("utf-8", "replace")
            except OSError:
                continue
            # comm sits in parentheses and may hold spaces or ")"
            name = raw[raw.find("(") + 1: raw.rfind(")")]
            rest = raw[raw.rfind(")") + 2:].split()
            try:
                out[int(d)] = Proc(int(d), int(rest[1]), name, int((boot + int(rest[19]) / hz) * 1000))
            except (IndexError, ValueError):
                continue
        return out

    def details(p):
        with open(f"/proc/{p.pid}/cmdline", "rb") as f:
            p.argv = [a.decode("utf-8", "replace") for a in f.read(ENV_BYTES).split(b"\0")[:-1]]
        with open(f"/proc/{p.pid}/environ", "rb") as f:
            p.env = environ(a.decode("utf-8", "replace") for a in f.read(ENV_BYTES).split(b"\0"))
        p.cwd = os.readlink(f"/proc/{p.pid}/cwd")

    return snapshot, details


# --- macOS ---------------------------------------------------------------------------------

def _macos():
    import ctypes

    lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.proc_listallpids.restype = ctypes.c_int
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    lib.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                           ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    lib.sysctl.restype = ctypes.c_int
    BSDINFO, BSDINFO_SIZE = 3, 136       # PROC_PIDTBSDINFO, sizeof(struct proc_bsdinfo)
    VNODEPATH, VNODEPATH_SIZE = 9, 2352  # PROC_PIDVNODEPATHINFO, sizeof(struct proc_vnodepathinfo)

    def sysctl(mib, size):
        arr = (ctypes.c_int * len(mib))(*mib)
        buf = ctypes.create_string_buffer(size)
        n = ctypes.c_size_t(size)
        if lib.sysctl(arr, len(mib), buf, ctypes.byref(n), None, 0) != 0:
            raise OSError("sysctl failed")
        return buf.raw[: n.value]

    argmax = struct.unpack("<i", sysctl([1, 8], 4))[0]  # CTL_KERN, KERN_ARGMAX

    def snapshot():
        n = lib.proc_listallpids(None, 0)
        pids = (ctypes.c_int * (n + 64))()
        n = lib.proc_listallpids(pids, ctypes.sizeof(pids))
        out = {}
        buf = ctypes.create_string_buffer(BSDINFO_SIZE)
        for pid in pids[:max(n, 0)]:
            if pid <= 0 or lib.proc_pidinfo(pid, BSDINFO, 0, buf, BSDINFO_SIZE) != BSDINFO_SIZE:
                continue
            raw = buf.raw
            ppid = struct.unpack_from("<I", raw, 16)[0]
            name = (raw[64:96].split(b"\0")[0] or raw[48:64].split(b"\0")[0]).decode("utf-8", "replace")
            sec, usec = struct.unpack_from("<QQ", raw, 120)
            out[pid] = Proc(pid, ppid, name, sec * 1000 + usec // 1000)
        return out

    def details(p):
        raw = sysctl([1, 49, p.pid], argmax)  # KERN_PROCARGS2: argc, exec path, argv, env
        argc = struct.unpack_from("<i", raw, 0)[0]
        parts = raw[4:].split(b"\0")
        i = 1  # past the exec path
        while i < len(parts) and parts[i] == b"":
            i += 1
        p.argv = [a.decode("utf-8", "replace") for a in parts[i:i + argc]]
        env = []
        for a in parts[i + argc:]:
            if not a:
                break
            env.append(a.decode("utf-8", "replace"))
        p.env = environ(env)
        buf = ctypes.create_string_buffer(VNODEPATH_SIZE)
        if lib.proc_pidinfo(p.pid, VNODEPATH, 0, buf, VNODEPATH_SIZE) == VNODEPATH_SIZE:
            p.cwd = buf.raw[152:152 + 1024].split(b"\0")[0].decode("utf-8", "replace") or None

    return snapshot, details


def platform():
    if os.name == "nt":
        return _windows()
    if sys.platform == "darwin":
        return _macos()
    if os.path.isdir("/proc"):
        return _linux()
    raise OSError("no process access on " + sys.platform)


def host_pid(procs):
    """The Claude Code process this scan runs under: its CLAUDE_PID, else the parent named claude."""
    pid = os.environ.get("CLAUDE_PID", "")
    if pid.isdigit():
        return int(pid)
    me = procs.get(os.getpid())
    parent = procs.get(me.ppid) if me else None
    return parent.pid if parent and parent.name.lower().startswith("claude") else None


def launches(session_ids, budget_s=BUDGET_S):
    """(this chat's candidate processes, {pid: Proc} for the whole tree).

    A candidate is a CLI or interpreter whose environment names one of the chat's session ids,
    or the chat's Claude Code process as CLAUDE_PID."""
    stop = time.monotonic() + budget_s
    snapshot, details = platform()
    procs = snapshot()
    host = host_pid(procs)
    ids = {s for s in session_ids if s}
    found = []
    for p in procs.values():
        if p.pid == os.getpid() or not CANDIDATE.fullmatch(p.name.lower()):
            continue
        if time.monotonic() > stop:
            break
        try:
            details(p)
        except Exception:
            continue
        if p.argv and p.startMs and (p.env.get("CLAUDE_CODE_SESSION_ID") in ids
                                     or host and p.env.get("CLAUDE_PID") == str(host)):
            found.append(p)
    return found, procs
