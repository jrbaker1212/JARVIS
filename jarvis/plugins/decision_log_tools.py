"""jevlog: read-only tail of Nexy's Jev decision JSONL (training / audit log).

Writes go through jarvis/core/decision_log.py; this plugin only reads the end of
data/brain_decisions.jsonl efficiently (reverse seek), never locks or mutates the file.
"""
from __future__ import annotations

from ..core.decision_log_read import format_decision_log_result, read_recent_decisions
from ..core.permissions import Permission
from .base import PluginInfo, tool


def register(registry):
    @tool(
        name="decision_log_recent",
        description=(
            "READ-ONLY: return the most recent rows from Nexy's Jev decision log "
            "(data/brain_decisions.jsonl — model turns, tool calls, replies). "
            "Use instead of read_file on that path (read_file only sees the oldest "
            "part of large files). Newest rows first. Default 20 rows, max 200."
        ),
        permission=Permission.SAFE,
        parameters={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "How many recent rows to return (1-200, default 20).",
                },
                "since": {
                    "type": "string",
                    "description": "ISO-8601 timestamp; only rows with ts >= since.",
                },
                "event": {
                    "type": "string",
                    "description": "Filter by event field (e.g. chat_stream, chat).",
                },
                "keyword": {
                    "type": "string",
                    "description": "Case-insensitive substring filter anywhere in the row JSON.",
                },
            },
        },
    )
    def decision_log_recent(
        limit: int = 20,
        since: str | None = None,
        event: str | None = None,
        keyword: str | None = None,
    ) -> str:
        since = (since or "").strip() or None
        event = (event or "").strip() or None
        keyword = (keyword or "").strip() or None
        result = read_recent_decisions(
            limit=limit,
            since=since,
            event=event,
            keyword=keyword,
        )
        return format_decision_log_result(result)

    decision_log_recent._tool.offload = True  # type: ignore[attr-defined]

    registry.add_pending("decision_log_tools")
    registry.register_plugin(
        PluginInfo(
            name="decision_log_tools",
            description="Read-only tail of the Jev decision JSONL log.",
            permissions_needed=[Permission.SAFE],
        )
    )
