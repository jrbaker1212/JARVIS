import os
import subprocess
import sys
from pathlib import Path

import pytest

from jarvis.utils import memory_guard as G


@pytest.fixture()
def root(tmp_path):
    r = tmp_path / "nexey-memory"
    r.mkdir()
    return r


@pytest.mark.parametrize("bad", [
    "../evil.md", "..\\evil.md", "C:\\Windows\\x.md", "/etc/x.md", "sub/2026-10-13.md",
    "2026-10-13.txt", "2026-10-13.md.exe", "notes.md", "2026-13-40.md", "2026-10-13.MD ",
    "2026-10-13.md:ads", "..", "2026-10-13.ps1",
])
def test_bad_names_refused(root, bad):
    with pytest.raises(G.MemoryGuardError):
        G.append_entry("hi", filename=bad, root=root)


def test_append_ok(root):
    G.append_entry("first", filename="2026-10-13.md", kind="learned", root=root)
    G.append_entry("second", filename="2026-10-13.md", kind="got-wrong", root=root)
    text = (root / "2026-10-13.md").read_text(encoding="utf-8")
    assert "first" in text and "second" in text and "got-wrong" in text
    assert [f["file"] for f in G.list_files(root)] == ["2026-10-13.md"]


def test_size_cap(root):
    with pytest.raises(G.MemoryGuardError):
        G.append_entry("x" * (G.MAX_BYTES + 1), filename="2026-10-13.md", root=root)


def _mklink(link: Path, target: Path, junction: bool):
    if os.name != "nt":
        os.symlink(target, link, target_is_directory=junction)
        return True
    flag = "/J" if junction else ""
    r = subprocess.run(["cmd", "/c", "mklink", flag, str(link), str(target)] if flag else
                       ["cmd", "/c", "mklink", str(link), str(target)], capture_output=True)
    return r.returncode == 0


def test_file_symlink_refused(root, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("x")
    if not _mklink(root / "2026-10-14.md", outside, junction=False):
        pytest.skip("no symlink privilege")
    with pytest.raises(G.MemoryGuardError):
        G.append_entry("pwn", filename="2026-10-14.md", root=root)
    assert outside.read_text() == "x"


def test_junction_root_refused(tmp_path):
    real = tmp_path / "elsewhere"
    real.mkdir()
    link = tmp_path / "nexey-memory-link"
    if not _mklink(link, real, junction=True):
        pytest.skip("cannot create junction")
    with pytest.raises(G.MemoryGuardError):
        G.append_entry("pwn", filename="2026-10-13.md", root=link)
