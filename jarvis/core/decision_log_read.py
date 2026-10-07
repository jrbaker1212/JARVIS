"""Read-only tail of Jev decision JSONL (brain_decisions.jsonl).

Efficient reverse chunked read — never loads the whole file.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _default_log_path() -> Path:
    try:
        return Path(__file__).resolve().parents[2] / "data" / "brain_decisions.jsonl"
    except (IndexError, RuntimeError, OSError):
        return Path("/tmp") / "brain_decisions.jsonl"


LOG_PATH = _default_log_path()

_DEFAULT_LIMIT = 20
_MAX_LIMIT = 200
_CHUNK = 65536
# When filtering, scan at most this many complete lines from the file end.
_MAX_FILTER_SCAN_LINES = 8000
_MAX_OUTPUT_CHARS = 28_000
_MAX_FIELD_CHARS = 700

_ORDER = "newest_first"


def _strip_bom(text: str) -> str:
    return text[1:] if text.startswith("\ufeff") else text


def _truncate_value(val: Any, budget: list[int]) -> Any:
    """Truncate strings/lists/dicts for tool output; mutates budget[0] (chars remaining)."""
    if budget[0] <= 0:
        return "[output cap reached]"
    if isinstance(val, str):
        if len(val) <= _MAX_FIELD_CHARS:
            budget[0] -= len(val)
            return val
        out = val[:_MAX_FIELD_CHARS] + "...[field truncated]"
        budget[0] -= len(out)
        return out
    if isinstance(val, list):
        out: list[Any] = []
        for item in val[:20]:
            if budget[0] <= 0:
                out.append("...")
                break
            out.append(_truncate_value(item, budget))
        if len(val) > 20:
            out.append(f"...[{len(val) - 20} more items]")
        return out
    if isinstance(val, dict):
        out: dict[str, Any] = {}
        for k, v in list(val.items())[:30]:
            if budget[0] <= 0:
                out["..."] = "..."
                break
            out[k] = _truncate_value(v, budget)
        if len(val) > 30:
            out["..."] = f"{len(val) - 30} more keys"
        return out
    s = json.dumps(val, ensure_ascii=False)
    if len(s) > _MAX_FIELD_CHARS:
        s = s[:_MAX_FIELD_CHARS] + "...[field truncated]"
    budget[0] -= len(s)
    return val if len(s) <= _MAX_FIELD_CHARS else s


def _prepare_record(rec: dict[str, Any]) -> tuple[dict[str, Any], int]:
    budget = [_MAX_OUTPUT_CHARS]
    trimmed = _truncate_value(rec, budget)
    truncated = 0
    if isinstance(trimmed, dict):
        for k, v in rec.items():
            tv = trimmed.get(k)
            if isinstance(v, str) and isinstance(tv, str) and tv != v:
                truncated += 1
    return trimmed if isinstance(trimmed, dict) else {"value": trimmed}, truncated


def _row_matches(
    rec: dict[str, Any],
    *,
    since: str | None,
    event: str | None,
    keyword: str | None,
) -> bool:
    if since:
        ts = rec.get("ts") or ""
        if ts < since:
            return False
    if event and rec.get("event") != event:
        return False
    if keyword:
        kw = keyword.lower()
        blob = json.dumps(rec, ensure_ascii=False).lower()
        if kw not in blob:
            return False
    return True


def _read_tail_line_bytes(path: Path, max_lines: int) -> tuple[list[bytes], bool]:
    """Return up to max_lines complete lines (oldest-first in slice). Drops partial EOF line."""
    partial_eof = False
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        if size == 0:
            return [], partial_eof

        data = b""
        pos = size
        while pos > 0 and data.count(b"\n") < max_lines + 1:
            step = min(_CHUNK, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data

        if not data.endswith(b"\n"):
            partial_eof = True
            if b"\n" in data:
                data = data[: data.rfind(b"\n") + 1]
            else:
                return [], partial_eof

        parts = data.split(b"\n")
        if parts and parts[-1] == b"":
            parts.pop()
        return parts[-max_lines:], partial_eof


def _expand_scan_line_bytes(path: Path, scan_lines: int) -> tuple[list[bytes], bool]:
    """Read up to scan_lines from file end (oldest-first). Same partial-EOF rule."""
    return _read_tail_line_bytes(path, scan_lines)


def read_recent_decisions(
    *,
    limit: int | None = None,
    path: Path | None = None,
    since: str | None = None,
    event: str | None = None,
    keyword: str | None = None,
) -> dict[str, Any]:
    """Tail the decision log. Records in meta['order'] (newest_first)."""
    log_path = Path(path) if path else LOG_PATH
    req = max(1, min(_MAX_LIMIT, int(limit if limit is not None else _DEFAULT_LIMIT)))

    meta: dict[str, Any] = {
        "path": str(log_path),
        "requested": req,
        "returned": 0,
        "order": _ORDER,
        "skipped_blank": 0,
        "skipped_malformed": 0,
        "skipped_partial_eof": False,
        "skipped_filter": 0,
        "truncated_fields": 0,
        "output_truncated": False,
    }
    records_out: list[dict[str, Any]] = []

    if not log_path.is_file():
        meta["error"] = "missing_file"
        return {"meta": meta, "records": records_out}

    filtering = bool(since or event or keyword)
    scan = req if not filtering else min(_MAX_FILTER_SCAN_LINES, max(req * 40, 200))

    raw_lines, partial = _expand_scan_line_bytes(log_path, scan)
    meta["skipped_partial_eof"] = partial

    parsed: list[tuple[dict[str, Any] | None, bytes]] = []
    for raw in raw_lines:
        if not raw.strip():
            meta["skipped_blank"] += 1
            continue
        try:
            text = _strip_bom(raw.decode("utf-8", errors="replace").strip())
        except Exception:  # noqa: BLE001
            meta["skipped_malformed"] += 1
            continue
        if not text:
            meta["skipped_blank"] += 1
            continue
        try:
            rec = json.loads(text)
        except json.JSONDecodeError:
            meta["skipped_malformed"] += 1
            continue
        if not isinstance(rec, dict):
            meta["skipped_malformed"] += 1
            continue
        parsed.append((rec, raw))

    matches: list[dict[str, Any]] = []
    for rec, _raw in parsed:
        if _row_matches(rec, since=since, event=event, keyword=keyword):
            matches.append(rec)
        elif filtering:
            meta["skipped_filter"] += 1

    selected = matches[-req:]
    if _ORDER == "newest_first":
        selected = list(reversed(selected))

    total_chars = 0
    for rec in selected:
        prepared, n_trunc = _prepare_record(rec)
        meta["truncated_fields"] += n_trunc
        blob = json.dumps(prepared, ensure_ascii=False)
        if total_chars + len(blob) > _MAX_OUTPUT_CHARS:
            meta["output_truncated"] = True
            break
        records_out.append(prepared)
        total_chars += len(blob)

    meta["returned"] = len(records_out)
    return {"meta": meta, "records": records_out}


def format_decision_log_result(result: dict[str, Any]) -> str:
    meta = result.get("meta") or {}
    if meta.get("error") == "missing_file":
        return f"Decision log not found at {meta.get('path')}."

    head = (
        f"Jev decision log ({meta.get('path')}): {meta.get('returned', 0)} row(s), "
        f"{meta.get('order', _ORDER)}."
    )
    skips = []
    if meta.get("skipped_malformed"):
        skips.append(f"{meta['skipped_malformed']} malformed")
    if meta.get("skipped_blank"):
        skips.append(f"{meta['skipped_blank']} blank")
    if meta.get("skipped_filter"):
        skips.append(f"{meta['skipped_filter']} filtered out")
    if meta.get("skipped_partial_eof"):
        skips.append("partial last line skipped")
    if meta.get("truncated_fields"):
        skips.append(f"{meta['truncated_fields']} field(s) truncated")
    if meta.get("output_truncated"):
        skips.append("output char cap hit")
    if skips:
        head += " Skipped: " + ", ".join(skips) + "."

    lines = [head]
    for i, rec in enumerate(result.get("records") or [], 1):
        ts = rec.get("ts", "?")
        ev = rec.get("event", "?")
        model = rec.get("model", "")
        tools = rec.get("tool_calls") or []
        tool_names = ", ".join(
            t.get("name", "?") for t in tools if isinstance(t, dict)
        ) or "(none)"
        lines.append(
            f"\n--- #{i} {ts} | event={ev} | model={model} | tools={tool_names} ---"
        )
        if rec.get("last_user_msg"):
            lines.append(f"user: {rec['last_user_msg']}")
        if rec.get("reply_text"):
            lines.append(f"reply: {rec['reply_text']}")
        if rec.get("error"):
            lines.append(f"error: {rec['error']}")
        if tools:
            lines.append(f"tool_calls: {json.dumps(tools, ensure_ascii=False)[:1200]}")

    return "\n".join(lines)
