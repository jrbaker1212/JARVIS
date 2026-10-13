"""Path guard for Nexy's only write path: C:\\Users\\jrbak\\nexey-memory.

Rules (all enforced here, not by the model):
  * filename must be a bare name matching YYYY-MM-DD.md (no dirs, no '..', no drive)
  * the resolved real path (symlinks/junctions followed) must sit directly in ROOT
  * the target, if it exists, must not be a link/reparse point
  * writes are append-only, UTF-8, <= MAX_BYTES per call, timestamped
"""
from __future__ import annotations

import datetime as _dt
import os
import re
from pathlib import Path

DEFAULT_ROOT = r"C:\Users\jrbak\nexey-memory"
MAX_BYTES = 20 * 1024
_NAME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\.md$")
_KINDS = {"learned", "decided", "observed", "got-wrong", "note"}


class MemoryGuardError(ValueError):
    pass


def _root(root: str | os.PathLike | None = None) -> Path:
    r = Path(root or os.environ.get("NEXEY_MEMORY_ROOT") or DEFAULT_ROOT)
    r.mkdir(parents=True, exist_ok=True)
    real = Path(os.path.realpath(r))
    if _is_link(r) or _is_link(real):
        raise MemoryGuardError("memory root is a link/junction; refusing")
    return real


def _is_link(p: Path) -> bool:
    try:
        if p.is_symlink():
            return True
        is_junction = getattr(os.path, "isjunction", None)
        if is_junction and is_junction(p):
            return True
        st = os.lstat(p)
        attrs = getattr(st, "st_file_attributes", 0)
        return bool(attrs & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except FileNotFoundError:
        return False


def resolve_memory_file(filename: str, root: str | os.PathLike | None = None) -> Path:
    if not isinstance(filename, str) or not filename:
        raise MemoryGuardError("filename required")
    name = filename.strip()
    if any(c in name for c in ("/", "\\", ":", "\x00")) or ".." in name:
        raise MemoryGuardError("filename must be a bare YYYY-MM-DD.md name (no paths)")
    m = _NAME_RE.match(name)
    if not m:
        raise MemoryGuardError("filename must match YYYY-MM-DD.md")
    try:
        _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError as e:
        raise MemoryGuardError(f"invalid date: {e}") from None
    base = _root(root)
    candidate = base / name
    if _is_link(candidate):
        raise MemoryGuardError("target is a link/junction; refusing")
    real = Path(os.path.realpath(candidate))
    if os.path.normcase(str(real.parent)) != os.path.normcase(str(base)):
        raise MemoryGuardError("resolved path escapes nexey-memory; refusing")
    return real


def today_name() -> str:
    return _dt.date.today().isoformat() + ".md"


def append_entry(content: str, filename: str | None = None, kind: str = "note",
                 root: str | os.PathLike | None = None) -> dict:
    if not isinstance(content, str) or not content.strip():
        raise MemoryGuardError("content required")
    data = content.replace("\r\n", "\n").strip()
    if len(data.encode("utf-8")) > MAX_BYTES:
        raise MemoryGuardError(f"content exceeds {MAX_BYTES} bytes")
    if "\x00" in data:
        raise MemoryGuardError("binary content refused")
    kind = (kind or "note").strip().lower()
    if kind not in _KINDS:
        kind = "note"
    path = resolve_memory_file(filename or today_name(), root)
    stamp = _dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    header = "" if path.exists() else f"# Nexey memory - {path.stem}\n"
    entry = f"{header}\n## {stamp} - {kind}\n\n{data}\n"
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o644)
    try:
        os.write(fd, entry.encode("utf-8"))
    finally:
        os.close(fd)
    return {"ok": True, "file": path.name, "bytes": len(entry.encode("utf-8")), "at": stamp}


def read_file(filename: str | None = None, root: str | os.PathLike | None = None,
              max_chars: int = 20000) -> str:
    path = resolve_memory_file(filename or today_name(), root)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")[-max_chars:]


def list_files(root: str | os.PathLike | None = None) -> list[dict]:
    base = _root(root)
    out = []
    for p in sorted(base.iterdir(), reverse=True):
        if p.is_file() and _NAME_RE.match(p.name) and not _is_link(p):
            out.append({"file": p.name, "bytes": p.stat().st_size})
    return out
