"""Unit tests for Jev decision log tail reader."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from jarvis.core.decision_log_read import read_recent_decisions


def _write_lines(path: Path, lines: list[str], *, bom: bool = False, partial_eof: bool = False) -> None:
    data = "\n".join(lines)
    if partial_eof and lines:
        # no trailing newline on last physical line
        pass
    else:
        data += "\n"
    raw = (("\ufeff" if bom else "") + data).encode("utf-8")
    path.write_bytes(raw)


class DecisionLogRecentTests(unittest.TestCase):
    def test_tail_n_rows(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "brain_decisions.jsonl"
            rows = [{"ts": f"2026-10-07T10:00:{i:02d}+00:00", "event": "chat", "n": i} for i in range(5)]
            _write_lines(p, [json.dumps(r) for r in rows])
            out = read_recent_decisions(path=p, limit=3)
            self.assertEqual(out["meta"]["returned"], 3)
            self.assertEqual(out["meta"]["order"], "newest_first")
            self.assertEqual(out["records"][0]["n"], 4)
            self.assertEqual(out["records"][-1]["n"], 2)

    def test_n_greater_than_rows(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.jsonl"
            _write_lines(p, [json.dumps({"ts": "2026-10-07T00:00:00+00:00", "event": "chat"})])
            out = read_recent_decisions(path=p, limit=50)
            self.assertEqual(out["meta"]["returned"], 1)

    def test_default_and_max_caps(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.jsonl"
            lines = [json.dumps({"ts": "2026-10-07T00:00:00+00:00", "event": "chat", "i": i}) for i in range(300)]
            _write_lines(p, lines)
            default = read_recent_decisions(path=p)
            self.assertEqual(default["meta"]["requested"], 20)
            self.assertEqual(default["meta"]["returned"], 20)
            capped = read_recent_decisions(path=p, limit=999)
            self.assertEqual(capped["meta"]["requested"], 200)
            self.assertEqual(capped["meta"]["returned"], 200)

    def test_malformed_and_partial_eof(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.jsonl"
            good = json.dumps({"ts": "2026-10-07T01:00:00+00:00", "event": "chat", "ok": True})
            p.write_bytes((good + "\n{broken\n" + good + "\nPARTIAL").encode("utf-8"))
            out = read_recent_decisions(path=p, limit=10)
            self.assertGreaterEqual(out["meta"]["skipped_malformed"], 1)
            self.assertTrue(out["meta"]["skipped_partial_eof"])

    def test_bom(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.jsonl"
            row = json.dumps({"ts": "2026-10-07T02:00:00+00:00", "event": "chat"})
            _write_lines(p, [row], bom=True)
            out = read_recent_decisions(path=p, limit=1)
            self.assertEqual(out["meta"]["returned"], 1)
            self.assertEqual(out["records"][0]["event"], "chat")

    def test_empty_and_missing(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            empty = Path(td) / "empty.jsonl"
            empty.write_bytes(b"")
            out = read_recent_decisions(path=empty, limit=5)
            self.assertEqual(out["meta"]["returned"], 0)
            missing = Path(td) / "nope.jsonl"
            out2 = read_recent_decisions(path=missing, limit=5)
            self.assertEqual(out2["meta"]["error"], "missing_file")

    def test_filters(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "log.jsonl"
            rows = [
                {"ts": "2026-10-07T10:00:00+00:00", "event": "chat", "last_user_msg": "alpha"},
                {"ts": "2026-10-07T11:00:00+00:00", "event": "chat_stream", "last_user_msg": "beta gamma"},
                {"ts": "2026-10-07T12:00:00+00:00", "event": "chat", "last_user_msg": "delta"},
            ]
            _write_lines(p, [json.dumps(r) for r in rows])
            ev = read_recent_decisions(path=p, limit=10, event="chat_stream")
            self.assertEqual(ev["meta"]["returned"], 1)
            self.assertEqual(ev["records"][0]["last_user_msg"], "beta gamma")
            since = read_recent_decisions(path=p, limit=10, since="2026-10-07T11:30:00+00:00")
            self.assertEqual(since["meta"]["returned"], 1)
            kw = read_recent_decisions(path=p, limit=10, keyword="gamma")
            self.assertEqual(kw["meta"]["returned"], 1)


if __name__ == "__main__":
    unittest.main()
