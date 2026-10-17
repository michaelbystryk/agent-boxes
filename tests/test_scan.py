"""Scanner regressions; run with python -E -m unittest tests/test_scan.py -v."""
import json
import os
import runpy
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import agy_scan as agy
import agy_usage as usage
import boxes
import codex_scan as codex


def record(prompt="one", command=None):
    return (json.dumps({"type": "assistant", "timestamp": "2026-10-17T12:00:00Z",
                        "message": {"content": [{"type": "tool_use", "name": "Bash",
                                                "input": {"command": command or 'codex exec "' + prompt + '"'}}]}})
            + "\n").encode()


def event(kind, at, **payload):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
    return (json.dumps({"timestamp": stamp, "payload": {"type": kind, **payload}}) + "\n").encode()


class Files(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        for module, key, value in (
            (codex, "STATE", str(self.state)), (codex, "_TRANSCRIPTS", {}),
            (codex, "_COMMANDS", {}), (codex, "_READ_BUDGET", None),
            (usage, "STATE", str(self.state)), (usage, "CACHE", str(self.state / "agy_usage.json")),
            (usage, "LOCK", str(self.state / "agy_usage.lock")), (usage, "_LOCKS", {}),
        ):
            p = patch.object(module, key, value)
            p.start()
            self.addCleanup(p.stop)

    def poll(self, path):
        codex._TRANSCRIPTS.clear()
        codex._READ_BUDGET = None
        return codex.transcript_data(str(path), 0)


class TranscriptTests(Files):
    def test_append_and_unchanged_poll(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record())
        self.assertEqual(self.poll(path)["offset"], path.stat().st_size)
        with path.open("ab") as f:
            f.write(record("two"))
        self.assertEqual([c["prompt"] for c in self.poll(path)["calls"]], ["one", "two"])
        cache = next(self.state.glob("transcript-*.json"))
        mtime = cache.stat().st_mtime_ns
        with patch.object(codex, "save_transcript") as save:
            self.poll(path)
            save.assert_not_called()
        self.assertEqual(cache.stat().st_mtime_ns, mtime)

    def test_truncate(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record() + record("two"))
        self.poll(path)
        path.write_bytes(record("new"))
        self.assertEqual([c["prompt"] for c in self.poll(path)["calls"]], ["new"])

    def test_replace_with_larger_file(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record())
        self.poll(path)
        replacement = self.root / "replacement"
        replacement.write_bytes(record("replacement is larger") + record("next"))
        os.replace(str(replacement), str(path))
        self.assertEqual([c["prompt"] for c in self.poll(path)["calls"]], ["replacement is larger", "next"])

    def test_truncate_then_regrow(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record())
        self.poll(path)
        path.write_bytes(record("different head") + record("new second record"))
        self.assertEqual([c["prompt"] for c in self.poll(path)["calls"]], ["different head", "new second record"])

    def test_each_identity_field_invalidates(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record())
        self.poll(path)
        cache = next(self.state.glob("transcript-*.json"))
        saved = json.loads(cache.read_text())
        for key, value in (("ino", -1), ("born", -1), ("headHash", "changed"), ("version", 1)):
            with self.subTest(key=key):
                cache.write_text(json.dumps({**saved, key: value}))
                self.assertEqual(codex.load_transcript(str(cache), path.stat(), str(path)), {})

    def test_partial_last_line(self):
        path = self.root / "chat.jsonl"
        first, second = record(), record("two")
        path.write_bytes(first + second[:50])
        self.assertEqual(self.poll(path)["offset"], len(first))
        with patch.object(codex, "save_transcript") as save:
            self.assertEqual(len(self.poll(path)["calls"]), 1)
            save.assert_not_called()
        with path.open("ab") as f:
            f.write(second[50:])
        self.assertEqual(len(self.poll(path)["calls"]), 2)

    def test_byte_budget_checkpoint(self):
        path = self.root / "chat.jsonl"
        raw = record()
        path.write_bytes(raw * 8)
        with patch.object(codex, "TRANSCRIPT_BYTES", len(raw) * 3 + 20):
            data = self.poll(path)
            self.assertEqual(data["offset"], len(raw) * 3)
            self.assertEqual(len(data["calls"]), 3)
            self.assertEqual(self.poll(path)["offset"], len(raw) * 6)
            self.assertEqual(len(self.poll(path)["calls"]), 8)

    def test_time_budget_checkpoint(self):
        path = self.root / "chat.jsonl"
        raw = record()
        path.write_bytes(raw * 2)
        with patch.object(codex.time, "monotonic", side_effect=[0, 0, 3]):
            self.assertEqual(self.poll(path)["offset"], len(raw))
        self.assertEqual(len(self.poll(path)["calls"]), 2)

    def test_oversized_record_across_budgets(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(b"x" * 2000 + b"\n" + record())
        with patch.object(codex, "RECORD_BYTES", 300), patch.object(codex, "TRANSCRIPT_BYTES", 700):
            data = self.poll(path)
            self.assertEqual(data["offset"], 0)
            self.assertEqual(data["skipOffset"], 700)
            for _ in range(4):
                data = self.poll(path)
            self.assertEqual(data["offset"], path.stat().st_size)
            self.assertEqual(len(data["calls"]), 1)

    def test_cache_has_only_matching_fields(self):
        path = self.root / "chat.jsonl"
        path.write_bytes(record(command='KEY=inline-secret codex exec "' + 'x' * 300 + '"'))
        self.poll(path)
        raw = next(self.state.glob("transcript-*.json")).read_text()
        self.assertNotIn("inline-secret", raw)
        call = json.loads(raw)["calls"][0]
        self.assertLessEqual(len(call["prompt"]), codex.PROMPT_CHARS)
        self.assertLessEqual(set(call), {"atMs", "cwd", "prompt", "brief", "kind"})

    def test_prune_old_caches_and_temps(self):
        for name in ("transcript-old.json", "transcript-old.123.tmp", "agy_usage.json.123.tmp"):
            p = self.state / name
            p.write_text("{}")
            os.utime(str(p), (0, 0))
        fresh = self.state / "transcript-new.123.tmp"
        fresh.write_text("{}")
        codex.prune_transcripts()
        self.assertEqual(list(self.state.iterdir()), [fresh])


class AttributionTests(Files):
    def call(self, command, at=100000):
        return codex.exec_calls(at, command, str(self.root))[0]

    def row(self, key="run", at=101000, prompt="task"):
        return {"id": key, "created_at_ms": at, "source": "exec", "cwd": str(self.root),
                "first_user_message": prompt}

    def test_one_call_one_run(self):
        self.assertEqual(codex.ours([self.row()], [self.call('codex exec "task"')]), {"run"})

    def test_parallel_codex_calls(self):
        calls = [self.call('codex exec "task"', 100000), self.call('codex exec "task"', 101000)]
        self.assertEqual(codex.ours([self.row("a", 102000), self.row("b", 103000)], calls), {"a", "b"})

    def test_ambiguous_calls_stay_unassigned(self):
        self.assertEqual(codex.ours([self.row("a"), self.row("b")], [self.call('codex exec "task"')]), set())
        self.assertEqual(codex.ours([self.row()], [self.call('codex exec "task"'), self.call('codex exec "task"')]), set())

    def agy_row(self, key, at):
        return {"conversation_id": key, "inputAtMs": at, "parent_conversation_id": None,
                "workspace_uris": json.dumps([self.root.as_uri()])}

    def test_back_to_back_agy(self):
        calls = [{"atMs": at, "dirs": {codex.norm_path(str(self.root))}} for at in (100000, 160000)]
        got = agy.ours([self.agy_row("a", 101000), self.agy_row("b", 161000)], calls)
        self.assertEqual(got, {"a": calls[0], "b": calls[1]})

    def test_parallel_agy_paired_in_order(self):
        calls = [{"atMs": at, "dirs": {codex.norm_path(str(self.root))}} for at in (100000, 101000)]
        got = agy.ours([self.agy_row("b", 103000), self.agy_row("a", 102000)], calls)
        self.assertEqual(got, {"a": calls[0], "b": calls[1]})

    def test_inline_exec_and_quoted_boundaries(self):
        call = self.call('codex exec "implement exec support; & | done"')
        self.assertEqual(call["prompt"], "implement exec support; & | done")
        self.assertEqual(codex.exec_calls(1, 'echo "codex exec task"'), [])
        self.assertEqual(len(codex.exec_calls(1, 'codex exec "one"; codex exec "two"')), 2)

    def test_relative_cd_equal_forms(self):
        for flag in ("--cd=rel", "-C=rel", '--cd="rel"', '--cd "rel"'):
            self.assertEqual(self.call('codex exec ' + flag + ' task')["cwd"], str(self.root / "rel"))

    def test_multiline_and_unclosed_prompt(self):
        self.assertEqual(self.call('codex exec "first\nsecond exec line"')["prompt"], "first second exec line")
        self.assertNotIn("prompt", self.call('codex exec "first\nsecond'))

    def test_all_value_flags(self):
        flags = " ".join(flag + " value" for flag in codex.VALUE_FLAGS if flag not in ("-C", "--cd"))
        self.assertEqual(self.call('codex exec ' + flags + ' "the prompt"')["prompt"], "the prompt")

    def test_authors_stdin_form(self):
        (self.root / "brief.txt").write_text("implement exec support")
        command = 'codex exec -m M -c k=v -s S --skip-git-repo-check -C "' + str(self.root) + '" -o out.txt - < brief.txt'
        call = self.call(command)
        self.assertEqual(call["brief"], "implement exec support")
        self.assertEqual(codex.ours([self.row(prompt="implement exec support")], [call]), {"run"})

    def test_brief_is_read_from_the_shell_cwd_not_codex_cd(self):
        sub = self.root / "rel"
        sub.mkdir()
        (sub / "brief.txt").write_text("codex dir brief")
        (self.root / "brief.txt").write_text("shell dir brief")
        call = self.call('DIR=rel codex exec --cd="$DIR" - < brief.txt')
        self.assertEqual(call["cwd"], str(sub))
        self.assertEqual(call["brief"], "shell dir brief")

    def test_unexpandable_cd_is_unknown_not_wrong(self):
        self.assertIsNone(self.call('codex exec -C $dir task')["cwd"])
        self.assertIsNone(self.call('codex exec -C "$(pwd)/x" task')["cwd"])

    def test_tilde_cd_expands_to_home(self):
        self.assertEqual(self.call('codex exec -C ~/repo task')["cwd"],
                         os.path.normpath(os.path.expanduser("~/repo")))

    def test_heredoc_continuations_only_outside_body(self):
        command = "codex exec \\\n-m M - <<'EOF'\nkeep\\\nthis\ncodex exec fake\nEOF\ncodex exec next"
        calls = codex.exec_calls(1, command)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["brief"], "keep\\ this codex exec fake")
        self.assertEqual(calls[1]["prompt"], "next")

    def test_seven_digit_timestamps(self):
        self.assertEqual(agy.when_ms("2026-10-17T12:00:00.1234567Z"), agy.when_ms("2026-10-17T12:00:00.123456Z"))
        self.assertEqual(agy.when_ms("not a date"), 0)

    def test_file_uris_on_both_platforms(self):
        with patch.object(os, "name", "posix"):
            self.assertEqual(agy.workspaces('["file:///home/me/a%20b", "https://example.com/x"]'), {"/home/me/a b"})
            self.assertEqual(agy.workspaces('["file:///C:/repo"]'), {"/C:/repo"})
        with patch.object(os, "name", "nt"):
            self.assertEqual(agy.workspaces('["file:///C:/repo", "file://server/share/a%20b"]'),
                             {"c:\\repo", "\\\\server\\share\\a b"})


class RolloutTests(Files):
    def test_nonoverlapping_tail_reaches_full_budget(self):
        path = self.root / "rollout.jsonl"
        start = event("task_started", 100)
        last = event("token_count", 200, info={"total_token_usage": {}}, rate_limits={"plan_type": "pro"})
        filler = event("message", 150, text="x" * 1000)
        path.write_bytes(start + filler * (1900000 // len(filler)) + last)
        budget = [2 * 1024 * 1024]
        life, info, limits, last_at, limits_at = codex.read_tail(str(path), budget)
        self.assertEqual((life, last_at, limits_at), ("task_started", 200, 200))
        self.assertEqual(2 * 1024 * 1024 - budget[0], path.stat().st_size)

    def thread(self, path, now):
        return {"id": "mine", "rollout_path": str(path), "updated_at_ms": (now - 3600) * 1000,
                "created_at_ms": (now - 4000) * 1000, "source": "exec", "cwd": str(self.root),
                "first_user_message": "task", "title": "task", "agent_path": None,
                "agent_nickname": None, "model": "m", "reasoning_effort": None, "tokens_used": 0}

    def test_old_mtime_and_unknown_lifecycle_stay_visible(self):
        now = int(time.time())
        path = self.root / "rollout.jsonl"
        path.write_bytes(event("message", now, text="still running"))
        os.utime(str(path), (now - 3600, now - 3600))
        row = self.thread(path, now)
        calls = [{"atMs": row["created_at_ms"], "cwd": str(self.root), "prompt": "task"}]
        with patch.object(codex, "session_calls", return_value=calls), patch.object(codex, "quota_paths", return_value=[]):
            self.assertEqual(len(codex.scan("session", [row])["agents"]), 1)
            path.write_bytes(event("task_complete", now))
            self.assertEqual(codex.scan("session", [row])["agents"], [])

    def test_fresher_quota_beats_own_thread(self):
        now = int(time.time())
        own, newer = self.root / "own.jsonl", self.root / "newer.jsonl"
        for path, at, used in ((own, now - 60, 10), (newer, now - 10, 30)):
            path.write_bytes(event("token_count", at, rate_limits={"primary": {"window_minutes": 300, "used_percent": used}}))
        row = self.thread(own, now)
        with patch.object(codex, "session_calls", return_value=[]), patch.object(codex, "ours", return_value={"mine"}), \
                patch.object(codex, "quota_paths", return_value=[str(own), str(newer)]):
            result = codex.scan("session", [row])
        self.assertEqual(result["limits"][0]["usedPercent"], 30)
        self.assertEqual(result["limitsAtMs"], (now - 10) * 1000)


class UsageTests(Files):
    def test_lock_ownership(self):
        token = usage.take_lock()
        self.assertTrue(token)
        try:
            self.assertIsNone(usage.take_lock())
            usage.unlock("someone-else")
            self.assertIsNone(usage.take_lock())
            os.utime(usage.LOCK, (0, 0))
            self.assertIsNone(usage.take_lock())
        finally:
            usage.unlock(token)
        second = usage.take_lock()
        self.assertTrue(second)
        usage.unlock(token)
        self.assertIsNone(usage.take_lock())
        usage.unlock(second)

    def test_drop_empty_windows(self):
        self.assertEqual(usage.parse(["GEMINI MODELS", "Weekly Limit", "Refreshes in 2h"], 0), {})
        result = usage.parse(["GEMINI MODELS", "Weekly Limit", "Five Hour Limit", "[###] 75%",
                              "CLAUDE/GPT MODELS", "[###] 90%", "Weekly Limit"], 0)
        self.assertEqual(result, {"gemini": {"5h": {"used": 25}}})

    def test_failure_preserves_success_timestamp(self):
        with patch.object(usage.time, "time", return_value=100):
            usage.write_cache({"gemini": {"5h": {"used": 20}}})
        with patch.object(usage.time, "time", return_value=200):
            usage.write_cache(usage.read_cache()["groups"], failed=True)
        data = usage.read_cache()
        self.assertEqual((data["lastSuccessAtMs"], data["lastAttemptAtMs"]), (100000, 200000))

    def test_stale_quota_hint(self):
        now = int(time.time() * 1000)
        data = {"lastSuccessAtMs": now - 34 * 60000, "groups": {"gemini": {"5h": {"used": 20}}}}
        with patch.object(agy, "HOME", str(self.root)), patch.object(agy, "scan", return_value={"nowMs": now, "agents": []}), \
                patch.object(usage, "cached", return_value=data):
            self.assertEqual(boxes.agy_box("session")["hint"], "quota from 34m ago")

    def test_localappdata_fallback_is_windows_only(self):
        for platform, env, expected in (("posix", {"LOCALAPPDATA": "fake"}, None), ("nt", {}, None),
                                        ("nt", {"LOCALAPPDATA": "fake"}, os.path.join("fake", "agy", "bin", "agy.exe"))):
            with patch.object(os, "name", platform), patch.dict(os.environ, env, clear=True), \
                    patch.object(usage.shutil, "which", return_value=None):
                self.assertEqual(runpy.run_path(usage.__file__)["AGY"], expected)

    def test_pty_kills_and_reaps_before_close(self):
        p = usage.PosixPty.__new__(usage.PosixPty)
        p.pid, p.fd = 123, 456
        order = []
        with patch.object(signal, "SIGKILL", 9, create=True), \
                patch.object(os, "killpg", side_effect=lambda *a: order.append("kill"), create=True), \
                patch.object(os, "waitpid", side_effect=lambda *a: order.append("reap")), \
                patch.object(os, "close", side_effect=lambda *a: order.append("close")):
            p.terminate(force=True)
        self.assertEqual(order, ["kill", "reap", "close"])



class BornTests(unittest.TestCase):
    def test_posix_append_keeps_the_cache(self):
        # On POSIX st_ctime moves on every append, so it must not be part of a file's identity.
        class Stat:
            st_ctime = 1.0
        with patch.object(codex.os, "name", "posix"):
            self.assertIsNone(codex.born(Stat()))


class SubstitutionTests(unittest.TestCase):
    def test_prompt_is_cut_at_shell_substitution(self):
        call = codex.parsed_calls(1000, 'codex exec "$(cat brief.md)"', "/r")[0]
        self.assertEqual(codex.prompts(call), [])
        call = codex.parsed_calls(1000, 'codex exec "fix the $NAME bug"', "/r")[0]
        self.assertEqual(codex.prompts(call), ["fix the"])


if __name__ == "__main__":
    unittest.main()
