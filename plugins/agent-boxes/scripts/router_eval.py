"""Compares in-loop and delegated work from the router's history.

Reads <claude dir>/agent-boxes/router-history.jsonl, joins each routed prompt's events by
promptId (route, turn, outcome), and prints one row per category and way it ran: how many,
the median time, and how the next reply or /route pass|fail graded them.

    python router_eval.py [history.jsonl] [--policy N] [--json]
"""
import json
import os
import statistics
import sys


def history_path():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "agent-boxes", "router-history.jsonl")


def prompts(lines, policy=None):
    """Each routed prompt with the facts the history holds on it."""
    out = {}
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        pid = e.get("promptId") if isinstance(e, dict) else None
        if not pid:
            continue
        p = out.setdefault(pid, {"id": pid})
        kind = e.get("event")
        if kind == "route":
            p.update(category=e.get("category"), policy=e.get("policy"), inLoop=e.get("inLoop"),
                     suggested=e.get("suggested"), mainModel=e.get("mainModel"))
        elif kind == "turn":
            p.update(ran=e.get("ran"), ms=e.get("ms"), spawns=e.get("spawns"))
        elif kind == "outcome":
            # A user's /route pass|fail outranks a guess from the next reply.
            if e.get("source") == "user" or p.get("source") != "user":
                p.update(outcome=e.get("outcome"), source=e.get("source"))
    rows = [p for p in out.values() if "category" in p]
    if policy is not None:
        rows = [p for p in rows if p.get("policy") == policy]
    return rows


GOOD = ("pass", "accept")
BAD = ("fail", "rework")


def summary(rows):
    groups = {}
    for p in rows:
        groups.setdefault((p.get("category") or "?", p.get("ran") or "unfinished"), []).append(p)
    table = []
    for (category, ran), ps in sorted(groups.items()):
        ms = [p["ms"] for p in ps if isinstance(p.get("ms"), (int, float))]
        graded = [p for p in ps if p.get("outcome") in GOOD + BAD]
        table.append({
            "category": category,
            "ran": ran,
            "n": len(ps),
            "medianS": round(statistics.median(ms) / 1000) if ms else None,
            "good": sum(p["outcome"] in GOOD for p in graded),
            "bad": sum(p["outcome"] in BAD for p in graded),
            "ungraded": len(ps) - len(graded),
        })
    return table


def main(argv):
    path, policy, as_json = history_path(), None, False
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--policy" and rest:
            policy = int(rest.pop(0))
        elif a == "--json":
            as_json = True
        else:
            path = a
    if not os.path.exists(path):
        print(f"no history at {path}")
        return 1
    with open(path, encoding="utf-8") as f:
        table = summary(prompts(f.read().splitlines(), policy))
    if as_json:
        print(json.dumps(table, indent=2))
        return 0
    print(f"{'category':<10} {'ran':<11} {'n':>4} {'median':>7} {'good':>5} {'bad':>4} {'ungraded':>9}")
    for r in table:
        median = f"{r['medianS']}s" if r["medianS"] is not None else "-"
        print(f"{r['category']:<10} {r['ran']:<11} {r['n']:>4} {median:>7} {r['good']:>5} {r['bad']:>4} {r['ungraded']:>9}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
