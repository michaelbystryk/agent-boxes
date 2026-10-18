"""Finds this session's running agy (Antigravity CLI) conversations.

The session's transcripts name every `agy -p` command it ran; each is matched
to the conversation it started in ~/.gemini/antigravity-cli/conversation_summaries.db
by time and workspace, and those conversations and the sub-agents they spawn are
the session's.
"""
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bench_scan
import codex_scan

HOME = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli")
LOOKBACK_MS = codex_scan.LOOKBACK_MS
STALE_S = codex_scan.STALE_S
MATCH_BEFORE_MS = 5 * 1000
MATCH_AFTER_MS = 3 * 60 * 1000
IDLE = ("CASCADE_RUN_STATUS_IDLE", "")

def when_ms(s):
    return codex_scan.iso_time(s) * 1000


def session_calls(session_id):
    """The shared cache holds only matching fields, including workspace paths."""
    calls = []
    for c in codex_scan.session_commands(session_id):
        if c["kind"] == "agy":
            paths = c.get("cwd") or []
            paths = [paths] if isinstance(paths, str) else paths
            calls.append({**c, "dirs": {codex_scan.norm_path(p) for p in paths} - {None}})
        elif c["kind"] == "bench" and c["agent"] == "agy":
            # paired so it can't be mistaken for another call's run; listed by bench_scan instead
            calls.append({"atMs": c["atMs"], "kind": "agy", "bench": True,
                          "dirs": {codex_scan.norm_path(c["cwd"]), codex_scan.norm_path(c["repo"])} - {None}})
    return calls


def workspaces(uris):
    try:
        uris = json.loads(uris or "[]")
    except (TypeError, ValueError):
        return set()
    if not isinstance(uris, list):
        return set()
    out = set()
    for u in uris:
        if not isinstance(u, str):
            continue
        try:
            uri = urlsplit(u)
        except ValueError:
            continue
        if uri.scheme != "file":
            continue
        p = unquote(uri.path)
        if uri.netloc and uri.netloc.lower() != "localhost":
            p = "//" + unquote(uri.netloc) + p
        elif os.name == "nt" and re.match(r"^/[a-zA-Z]:/", p):
            p = p[1:]
        out.add(codex_scan.norm_path(p))
    return out - {None}


def conversations():
    db = os.path.join(HOME, "conversation_summaries.db")
    if not os.path.exists(db):
        return []
    con = None
    try:
        con = sqlite3.connect(Path(db).resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        cols = {r[1] for r in con.execute("pragma table_info(conversation_summaries)")}
        if not {"conversation_id", "last_modified_time"} <= cols:
            return []
        names = ("conversation_id", "title", "preview", "step_count", "last_modified_time", "workspace_uris",
                 "status", "agent_name", "parent_conversation_id", "not_fully_idle", "killed", "last_user_input_time", "model", "effort")
        cur = con.execute(
            "select " + ", ".join(n if n in cols else "NULL as " + n for n in names)
            + " from conversation_summaries"
        )
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    except sqlite3.Error:
        return []
    finally:
        if con is not None:
            con.close()
    since = time.time() * 1000 - LOOKBACK_MS
    for r in rows:
        r["inputAtMs"] = when_ms(r["last_user_input_time"])
        r["modifiedAtMs"] = when_ms(r["last_modified_time"])
    return [r for r in rows if r["modifiedAtMs"] > since]


def ours(rows, calls):
    """Conversation id -> the call that started it, for the session's calls and their sub-agents."""
    roots = [r for r in rows if not r["parent_conversation_id"]]
    claimed = codex_scan.pair_calls(
        roots, calls, "conversation_id", "inputAtMs",
        lambda a, b: bool(a["dirs"] & b["dirs"]),
        lambda c, r: bool(c["dirs"] & workspaces(r["workspace_uris"])),
        lambda c: MATCH_AFTER_MS,
    )
    grew = True
    while grew:
        grew = False
        for r in rows:
            if r["conversation_id"] not in claimed and r["parent_conversation_id"] in claimed:
                claimed[r["conversation_id"]] = claimed[r["parent_conversation_id"]]
                grew = True
    return claimed


def running(r, now_ms):
    if r["killed"]:
        return False
    if (r["status"] or "") in IDLE and not r["not_fully_idle"]:
        return False
    return now_ms - r["modifiedAtMs"] < STALE_S * 1000


def scan(session_id, rows=None):
    now_ms = int(time.time() * 1000)
    rows = conversations() if rows is None else rows
    active = rows and any(running(r, now_ms) for r in rows)
    mine = ours(rows, session_calls(session_id)) if active else {}
    agents = []
    for r in rows:
        call = mine.get(r["conversation_id"])
        # headless agy leaves its DB row idle mid-run, so bench.py runs are listed from their logs below
        if call is None or call.get("bench") or not running(r, now_ms):
            continue
        agents.append({
            "id": r["conversation_id"],
            "task": codex_scan.task_label(r["title"], r["preview"]),
            "parentId": r["parent_conversation_id"] or None,
            "nickname": r["agent_name"] or None,
            "model": r.get("model") or call.get("model"),
            "effort": r.get("effort") or call.get("effort"),
            "steps": r["step_count"] or 0,
            "startedAtMs": int(call["atMs"]),
        })
    agents += bench_scan.runs(session_id, "agy")
    agents.sort(key=lambda a: a["startedAtMs"])
    return {"nowMs": now_ms, "agents": agents}

