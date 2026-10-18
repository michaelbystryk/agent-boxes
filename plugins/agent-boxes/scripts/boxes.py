"""JSON for the agent-boxes side bar: Codex's and Antigravity's quotas and this
session's Codex and Antigravity runs.

Usage: python -E boxes.py <session_id>

Each tool's box says whether the tool is installed at all (`installed`), so the side bar
can leave out the tools a person does not use.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TASK_WIDTH = 28


def pct(v):
    return "–" if not isinstance(v, (int, float)) else "%d%%" % round(v)


def tokens(n):
    if n >= 1e6:
        return f"{n / 1e6:.{0 if n >= 1e7 else 1}f}M"
    if n >= 1e3:
        return f"{round(n / 1e3)}k"
    return str(n)


def span(ms):
    m = max(0, round(ms / 60000))
    if m < 60:
        return f"{m}m"
    h = m // 60
    if h < 24:
        return f"{h}h{m % 60:02d}m"
    return f"{h // 24}d{h % 24}h"


def clip(text, width):
    return text[: width - 1] + "…" if len(text) > width else text


def window_used(w, now_ms):
    """A window's % used as a number, 0 once it has reset; None when unknown."""
    if w is None or not isinstance(w.get("usedPercent"), (int, float)):
        return None
    if w.get("resetsAt") is not None and w["resetsAt"] * 1000 <= now_ms:
        return 0
    return w["usedPercent"]


def window_raw(w, now_ms):
    """A window for the router: {used, resetsAtMs}; used is 0 once it has reset, None when unknown."""
    if w is None:
        return None
    out = {"used": window_used(w, now_ms)}
    if w.get("resetsAt") is not None and w["resetsAt"] * 1000 > now_ms:
        out["resetsAtMs"] = int(w["resetsAt"] * 1000)
    return out


def window_text(label, w, now_ms):
    if w is None:
        return f"{label} –"
    resets_ms = None if w.get("resetsAt") is None else w["resetsAt"] * 1000
    if resets_ms is not None and resets_ms <= now_ms:
        return f"{label} 0% (reset)"
    return f"{label} {pct(w.get('usedPercent'))}"


def agent_text(a, now_ms):
    if "steps" in a:  # Antigravity reports steps, not tokens
        a = {**a, "count": f"{a['steps']} steps"}
    name = f"{a['nickname']}: " if a.get("nickname") else ""
    model = " ".join(x for x in (a.get("model"), a.get("effort")) if x)
    parts = [
        clip(f"{name}{a.get('task') or '(no task)'}", TASK_WIDTH),
        model,
        a.get("count") or f"{tokens(a.get('tokens') or 0)} tok",
        span(now_ms - a["startedAtMs"]) if a.get("startedAtMs") else None,
    ]
    return " · ".join(p for p in parts if p)


def agent_rows(agents, now):
    """Agents as {depth, text, now} rows, each sub-agent under its parent."""
    ids = {a["id"] for a in agents}
    rows = []

    def walk(a, depth):
        rows.append({"depth": depth, "text": agent_text(a, now), "now": a.get("now")})
        for child in agents:
            if child["parentId"] == a["id"]:
                walk(child, depth + 1)

    for a in agents:
        if a["parentId"] is None or a["parentId"] not in ids:
            walk(a, 0)
    return rows


def codex_box(session_id, rows=None, prepare=False):
    import codex_scan

    if not os.path.isdir(codex_scan.HOME):
        return {"installed": False, "limits": [], "agents": []}
    if prepare:
        return codex_scan.threads(codex_scan.QUOTA_LOOKBACK_MS)
    scan = codex_scan.scan(session_id, rows=rows)
    now = scan["nowMs"]
    five = next((w for w in scan["limits"] if w["minutes"] == 300), None)
    week = next((w for w in scan["limits"] if w["minutes"] == 10080), None)
    return {
        "installed": True,
        "limits": [f"{window_text('5h', five, now)} · {window_text('7d', week, now)}"],
        "agents": agent_rows(scan["agents"], now),
        "fiveHour": window_used(five, now),
        "sevenDay": window_used(week, now),
        "windows": {"5h": window_raw(five, now), "7d": window_raw(week, now)},
    }


def agy_box(session_id, rows=None, prepare=False):
    import agy_scan

    if not os.path.isdir(agy_scan.HOME):
        return {"installed": False, "limits": [], "agents": []}
    if prepare:
        return agy_scan.conversations()
    import agy_usage

    if rows is None:
        rows = agy_scan.conversations()
    scan = agy_scan.scan(session_id, rows=rows)
    now = scan["nowMs"]
    usage = agy_usage.cached(max((r.get("modifiedAtMs") or 0 for r in rows), default=0)) or {}
    groups = usage.get("groups") or {}

    def window(g, key):
        x = g.get(key)
        return x and {"usedPercent": x.get("used"), "resetsAt": x.get("resetsAt")}

    def windows(g):
        return f"{window_text('5h', window(g, '5h'), now)} · {window_text('7d', window(g, '7d'), now)}"

    gemini = groups.get("gemini") or {}
    limits = [windows(gemini)]
    for name, g in groups.items():  # other model groups only once they are in use
        if name != "gemini" and any((x.get("used") or 0) > 0 for x in g.values()):
            limits.append(f"{name} {windows(g)}")
    box = {
        "installed": True,
        "limits": limits,
        "agents": agent_rows(scan["agents"], now),
        "fiveHour": window_used(window(gemini, "5h"), now),
        "sevenDay": window_used(window(gemini, "7d"), now),
        "windows": {"5h": window_raw(window(gemini, "5h"), now), "7d": window_raw(window(gemini, "7d"), now)},
        # every model group's windows (agy also runs Claude and GPT-OSS on its own quota), for agent-router
        "groups": {name: {"5h": window_raw(window(g, "5h"), now), "7d": window_raw(window(g, "7d"), now)}
                   for name, g in groups.items()},
    }
    if not groups and not agy_usage.AGY:
        box["hint"] = "quota needs agy on PATH"
    if groups:
        at = usage.get("lastSuccessAtMs", usage.get("atMs", 0) if not usage.get("failedAtMs") else 0)
        if not at:
            box["hint"] = "quota age unknown"
        elif now - at > 2 * agy_usage.REFRESH_S * 1000:
            box["hint"] = "quota from " + span(now - at) + " ago"
    return box


def claude_box(session_id):
    """This session's headless `claude -p` bench runs; its own subagents come from the engine."""
    import bench_scan

    return {"agents": agent_rows(bench_scan.runs(session_id, "claude"), time.time() * 1000)}


def box(fn, session_id, **kwargs):
    try:
        return fn(session_id, **kwargs)
    except Exception as e:
        return {"installed": True, "error": f"scan failed ({type(e).__name__})", "limits": [], "agents": []}


def main():
    import codex_scan

    codex_scan.prune_transcripts()
    session_id = sys.argv[1] if len(sys.argv) > 1 else None
    scanners = {"codex": codex_box, "agy": agy_box}
    # Query both databases before either scanner asks for the shared transcripts.
    prepared = {name: box(fn, session_id, prepare=True) for name, fn in scanners.items()}
    out = {name: data if isinstance(data, dict) else box(scanners[name], session_id, rows=data)
           for name, data in prepared.items()}
    out["claude"] = box(claude_box, session_id)
    out["atMs"] = int(time.time() * 1000)
    sys.stdout.buffer.write(json.dumps(out, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
