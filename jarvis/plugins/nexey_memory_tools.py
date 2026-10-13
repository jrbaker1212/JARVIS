"""nexey-memory: Nexy's ONLY write path. Dated markdown journal in C:\\Users\\jrbak\\nexey-memory."""
from __future__ import annotations

from ..utils import memory_guard as G
from .base import PluginInfo, tool


def register(registry):
    tog = registry.cfg.plugins.get("nexey_memory_tools")
    root = getattr(tog, "root", None) if tog is not None else None

    @tool(
        name="memory_write",
        description=(
            "Append a timestamped entry to your own memory journal (nexey-memory). This is the ONLY "
            "place you may write. Use it the day something matters: what you learned, decided, "
            "observed, or got wrong. Plain markdown only. filename defaults to today's YYYY-MM-DD.md."
        ),
        parameters={
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "Plain markdown text, max ~20KB"},
                "kind": {"type": "string", "enum": ["learned", "decided", "observed", "got-wrong", "note"]},
                "filename": {"type": "string", "description": "Optional YYYY-MM-DD.md (defaults to today)"},
            },
            "required": ["content"],
        },
    )
    def memory_write(content: str, kind: str = "note", filename: str | None = None) -> str:
        try:
            r = G.append_entry(content, filename=filename, kind=kind, root=root)
            return f"saved to nexey-memory/{r['file']} ({r['bytes']} bytes at {r['at']})"
        except G.MemoryGuardError as e:
            return f"refused: {e}"

    @tool(
        name="memory_read",
        description="Read one of your nexey-memory journal files (defaults to today's).",
        parameters={"type": "object", "properties": {"filename": {"type": "string"}}},
    )
    def memory_read(filename: str | None = None) -> str:
        try:
            return G.read_file(filename, root=root) or "(empty)"
        except G.MemoryGuardError as e:
            return f"refused: {e}"

    @tool(
        name="memory_list",
        description="List your nexey-memory journal files, newest first.",
        parameters={"type": "object", "properties": {}},
    )
    def memory_list() -> str:
        files = G.list_files(root=root)
        return "\n".join(f"{f['file']} ({f['bytes']} bytes)" for f in files) or "(no entries yet)"

    registry.add_pending("nexey_memory_tools")
    registry.register_plugin(PluginInfo(name="nexey_memory_tools", description="Nexy's dated markdown memory (only write path)."))
