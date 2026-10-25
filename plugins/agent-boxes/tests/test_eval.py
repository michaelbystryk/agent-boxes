import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import router_eval  # noqa: E402


def lines(*events):
    return [json.dumps(e) for e in events]


class EvalTests(unittest.TestCase):
    def test_joins_a_prompts_events_and_prefers_the_users_grade(self):
        rows = router_eval.prompts(lines(
            {"event": "route", "promptId": "a", "category": "shader", "policy": 2, "inLoop": True},
            {"event": "turn", "promptId": "a", "ran": "in-loop", "ms": 4000, "spawns": 0},
            {"event": "outcome", "promptId": "a", "outcome": "pass", "source": "user"},
            {"event": "outcome", "promptId": "a", "outcome": "unknown", "source": "reply"},
        ))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["ran"], rows[0]["outcome"]), ("in-loop", "pass"))

    def test_adds_up_a_prompts_turns_and_one_delegated_turn_makes_it_delegated(self):
        rows = router_eval.prompts(lines(
            {"event": "route", "promptId": "a", "category": "shader", "policy": 2},
            {"event": "turn", "promptId": "a", "ran": "in-loop", "ms": 1000},
            {"event": "turn", "promptId": "a", "ran": "delegated", "ms": 5000},
            {"event": "turn", "promptId": "a", "ran": "in-loop", "ms": 2000},
        ))
        self.assertEqual((rows[0]["ran"], rows[0]["ms"], rows[0]["turns"]), ("delegated", 8000, 3))

    def test_groups_by_category_and_how_it_ran(self):
        rows = router_eval.prompts(lines(
            {"event": "route", "promptId": "a", "category": "shader", "policy": 2},
            {"event": "turn", "promptId": "a", "ran": "in-loop", "ms": 2000},
            {"event": "outcome", "promptId": "a", "outcome": "rework", "source": "reply"},
            {"event": "route", "promptId": "b", "category": "shader", "policy": 2},
            {"event": "turn", "promptId": "b", "ran": "delegated", "ms": 9000},
            {"event": "outcome", "promptId": "b", "outcome": "accept", "source": "reply"},
            {"event": "route", "promptId": "c", "category": "shader", "policy": 1},
            {"event": "spawn", "agentId": "x"},
            "not json",
        ))
        table = router_eval.summary([r for r in rows if r.get("policy") == 2])
        self.assertEqual([(t["ran"], t["n"], t["medianS"], t["good"], t["bad"]) for t in table],
                         [("delegated", 1, 9, 1, 0), ("in-loop", 1, 2, 0, 1)])


if __name__ == "__main__":
    unittest.main()
