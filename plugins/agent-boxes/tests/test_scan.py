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
        self.assertEqual(set(codex.ours([self.row()], [self.call('codex exec "task"')])), {"run"})

    def test_parallel_codex_calls(self):
        calls = [self.call('codex exec "task"', 100000), self.call('codex exec "task"', 101000)]
        self.assertEqual(set(codex.ours([self.row("a", 102000), self.row("b", 103000)], calls)), {"a", "b"})

    def test_ambiguous_calls_stay_unassigned(self):
        self.assertEqual(set(codex.ours([self.row("a"), self.row("b")], [self.call('codex exec "task"')])), set())
        self.assertEqual(set(codex.ours([self.row()], [self.call('codex exec "task"'), self.call('codex exec "task"')])), set())

    def test_a_subagent_transcript_names_its_agent(self):
        sub = os.path.join("projects", "p", "sess", "subagents", "agent-a1b2.jsonl")
        self.assertEqual(codex.via(sub), "a1b2")
        self.assertIsNone(codex.via(os.path.join("projects", "p", "sess.jsonl")))

    def test_a_run_keeps_the_relay_that_launched_it(self):
        call = {**self.call('codex exec "task"'), "via": "a1b2"}
        self.assertEqual(codex.ours([self.row()], [call])["run"]["via"], "a1b2")
        rows = boxes.agent_rows([{"id": "run", "parentId": None, "task": "t", "startedAtMs": 0, "via": "a1b2"}], 1000)
        self.assertEqual(rows[0]["via"], "a1b2")

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
        self.assertEqual(set(codex.ours([self.row(prompt="implement exec support")], [call])), {"run"})

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
        with patch.object(codex, "session_calls", return_value=[]), patch.object(codex, "ours", return_value={"mine": {}}), \
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

    def test_parse_usage_json(self):
        data = {"groups": [
            {"name": "Gemini Models", "buckets": [
                {"window": "weekly", "remaining_fraction": 0.75, "reset_time": "2026-10-24T00:00:00Z"},
                {"window": "5h", "remaining_fraction": 1, "reset_time": "2026-10-18T11:30:00Z"}]},
            {"name": "Claude and GPT models", "buckets": [{"window": "5h", "remaining_fraction": True}]},
            {"name": "Other Models", "buckets": [{"window": "daily", "remaining_fraction": 0.5}]},
        ]}
        # an untouched window's rolling reset time is dropped; bad buckets and empty groups too
        self.assertEqual(usage.parse(data), {"gemini": {"7d": {"used": 25, "resetsAt": 1792800000.0},
                                                         "5h": {"used": 0}}})
        self.assertEqual(usage.parse(None), {})

    def test_refresh_reads_print_mode_json(self):
        out = json.dumps({"command": {"name": "usage", "data": {"groups": [
            {"name": "Gemini Models", "buckets": [{"window": "5h", "remaining_fraction": 0.5}]}]}}})
        done = type("Done", (), {"stdout": out})()
        with patch.object(usage, "AGY", "agy"), patch.object(usage.subprocess, "run", return_value=done) as run:
            usage.refresh()
        self.assertEqual(run.call_args[0][0], ["agy", "-p", "/usage", "--output-format", "json"])
        self.assertEqual(usage.read_cache()["groups"], {"gemini": {"5h": {"used": 50}}})

    def test_windows_check_skips_agys_updater(self):
        stamp = self.root / "last_check.timestamp"
        stamp.write_bytes(b"")
        os.utime(stamp, (0, 0))
        done = type("Done", (), {"stdout": "{}"})()
        for platform, moved in (("posix", False), ("nt", True)):
            with patch.object(os, "name", platform), patch.object(usage, "UPDATE_STAMP", str(stamp)),                     patch.object(usage, "AGY", "agy"), patch.object(usage.subprocess, "run", return_value=done):
                usage.usage_data()
            self.assertEqual(stamp.stat().st_mtime > 0, moved, platform)

    def test_refresh_waits_for_agy_activity(self):
        now = time.time() * 1000
        recent = {"lastAttemptAtMs": now - 5 * 60000}
        self.assertFalse(usage.stale(recent))
        self.assertFalse(usage.stale(recent, now - 6 * 60000))  # nothing ran since the attempt
        self.assertTrue(usage.stale(recent, now - 60000))
        self.assertFalse(usage.stale({"lastAttemptAtMs": now - 60000}, now))  # at most every MIN_S
        self.assertTrue(usage.stale({"lastAttemptAtMs": now - 61 * 60000}))
        self.assertTrue(usage.stale(None))

    def test_windows_refresh_has_no_window(self):
        with patch.object(os, "name", "nt"):
            flags = runpy.run_path(usage.__file__)["DETACH"]["creationflags"]
        self.assertTrue(flags & 0x08000000)  # CREATE_NO_WINDOW
        self.assertFalse(flags & 0x00000008)  # DETACHED_PROCESS would cancel it

    def test_failure_preserves_success_timestamp(self):
        with patch.object(usage.time, "time", return_value=100):
            usage.write_cache({"gemini": {"5h": {"used": 20}}})
        with patch.object(usage.time, "time", return_value=200):
            usage.write_cache(usage.read_cache()["groups"], failed=True)
        data = usage.read_cache()
        self.assertEqual((data["lastSuccessAtMs"], data["lastAttemptAtMs"]), (100000, 200000))

    def test_stale_quota_hint(self):
        now = int(time.time() * 1000)
        data = {"lastSuccessAtMs": now - 150 * 60000, "groups": {"gemini": {"5h": {"used": 20}}}}
        with patch.object(agy, "HOME", str(self.root)), patch.object(agy, "scan", return_value={"nowMs": now, "agents": []}), \
                patch.object(usage, "cached", return_value=data):
            self.assertEqual(boxes.agy_box("session")["hint"], "quota from 2h30m ago")

    def test_localappdata_fallback_is_windows_only(self):
        for platform, env, expected in (("posix", {"LOCALAPPDATA": "fake"}, None), ("nt", {}, None),
                                        ("nt", {"LOCALAPPDATA": "fake"}, os.path.join("fake", "agy", "bin", "agy.exe"))):
            with patch.object(os, "name", platform), patch.dict(os.environ, env, clear=True), \
                    patch.object(usage.shutil, "which", return_value=None):
                self.assertEqual(runpy.run_path(usage.__file__)["AGY"], expected)


class WindowTests(unittest.TestCase):
    def test_raw_window_for_the_router(self):
        now = 1_000_000_000
        self.assertIsNone(boxes.window_raw(None, now))
        self.assertEqual(boxes.window_raw({"usedPercent": 40, "resetsAt": 2_000_000}, now),
                         {"used": 40, "resetsAtMs": 2_000_000_000})
        # a window past its reset is empty and has no reset time
        self.assertEqual(boxes.window_raw({"usedPercent": 40, "resetsAt": 10}, now), {"used": 0})
        self.assertEqual(boxes.window_raw({"usedPercent": None}, now), {"used": None})


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


class BenchTests(Files):
    """llm-blender-bench runs, started as `python tools/bench.py run <agent> <task>`."""

    def setUp(self):
        super().setUp()
        import bench_scan
        self.bench = bench_scan
        self.repo = self.root / "repo"
        (self.repo / "tools").mkdir(parents=True)

    def launch(self, agent="agy", at=None):
        at = time.time() * 1000 if at is None else at
        command = f'cd "{self.repo}" && python tools/bench.py run {agent} T1_chest > out.txt 2>&1'
        return codex.parsed_calls(at, command, str(self.root))

    def run_log(self, agent, lines, n=1):
        d = self.repo / "benches" / agent / "T1_chest" / "runs" / str(n)
        d.mkdir(parents=True)
        (d / "prompt.md").write_text("brief")
        (d / "agent_log.jsonl").write_text("\n".join(json.dumps(x, separators=(",", ":")) for x in lines))
        return d

    def rows(self, agent, calls):
        with patch.object(codex, "session_commands", lambda _: calls):
            return self.bench.runs("s", agent)

    def test_launch_parses_to_the_bench_dir(self):
        [call] = self.launch(at=1000)
        self.assertEqual((call["kind"], call["agent"], call["task"]), ("bench", "agy", "T1_chest"))
        self.assertEqual(codex.norm_path(call["cwd"]), codex.norm_path(str(self.repo / "benches" / "agy" / "T1_chest")))
        self.assertEqual(codex.parsed_calls(1000, "python tools/bench.py review T1_chest", str(self.repo)), [])
        self.assertEqual(codex.parsed_calls(1000, "python tools/bench.py run gemini T1_chest", str(self.repo)), [])

    def test_codex_launch_is_a_codex_call(self):
        calls = self.launch("codex", 1000)
        with patch.object(codex, "session_commands", lambda _: calls):
            [call] = codex.session_calls("s")
        self.assertEqual((call["kind"], call["cwd"]), ("codex", calls[0]["cwd"]))

    def test_live_agy_run_and_its_last_command(self):
        calls = self.launch()
        self.run_log("agy", [
            {"event": "step_update", "step_update": {"step_index": 3, "step_type": "tool", "tool_name": "run_command",
                                                     "tool_info": {"parameters": {"CommandLine": "python -c \"\nprint(1)\""}}}},
            {"event": "step_update", "step_update": {"step_index": 4, "step_type": "agent_response"}},
        ])
        [row] = self.rows("agy", calls)
        self.assertEqual((row["task"], row["steps"], row["now"]), ("T1_chest run 1", 4, '$ python -c " print(1)"'))

    def test_claude_run_counts_tool_calls(self):
        calls = self.launch("claude")
        use = lambda name, i: {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": i}]}}
        self.run_log("claude", [use("Bash", {"command": "ls"}), {"type": "user"}, use("Read", {"file_path": "/x/a.png"})])
        [row] = self.rows("claude", calls)
        self.assertEqual((row["count"], row["now"]), ("2 tools", "Read a.png"))

    def test_finished_runs_drop_out(self):
        calls = self.launch()
        d = self.run_log("agy", [{"event": "result", "result": {"status": "SUCCESS"}}])
        self.assertEqual(self.rows("agy", calls), [])
        (d / "agent_log.jsonl").write_text(json.dumps({"event": "step_update", "step_update": {}}))
        self.assertEqual(len(self.rows("agy", calls)), 1)
        (self.repo / "results" / "T1_chest").mkdir(parents=True)
        (self.repo / "results" / "T1_chest" / "runs.json").write_text(
            json.dumps([{"agent": "agy", "run": 1, "run_dir": "benches/agy/T1_chest/runs/1"}]))
        self.assertEqual(self.rows("agy", calls), [])

    def test_an_older_run_is_not_this_call(self):
        self.run_log("agy", [{"event": "step_update", "step_update": {}}])
        old = self.repo / "benches" / "agy" / "T1_chest" / "runs" / "1" / "prompt.md"
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        self.assertEqual(self.rows("agy", self.launch()), [])

    def test_agy_db_row_of_a_bench_run_is_not_listed_twice(self):
        calls = self.launch()
        self.run_log("agy", [{"event": "step_update", "step_update": {"step_index": 1}}])
        now = time.time() * 1000
        row = {"conversation_id": "c", "inputAtMs": now + 1000, "modifiedAtMs": now, "parent_conversation_id": None,
               "workspace_uris": json.dumps([(self.repo / "benches" / "agy" / "T1_chest").as_uri()]),
               "killed": 0, "status": "CASCADE_RUN_STATUS_RUNNING", "not_fully_idle": 1, "title": "t", "preview": "",
               "agent_name": "", "step_count": 1}
        with patch.object(codex, "session_commands", lambda _: calls):
            agents = agy.scan("s", rows=[row])["agents"]
        self.assertEqual([a["nickname"] for a in agents], ["bench"])


if __name__ == "__main__":
    unittest.main()
