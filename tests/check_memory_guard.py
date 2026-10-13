"""Standalone proof the nexey-memory guard refuses escapes (no pytest needed).
Run: venv\\Scripts\\python.exe tests\\check_memory_guard.py"""
import os, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis.utils import memory_guard as G

fails = 0
def expect_refused(label, fn):
    global fails
    try:
        fn(); print("FAIL (allowed):", label); fails += 1
    except G.MemoryGuardError as e:
        print("refused ok:", label, "->", e)

with tempfile.TemporaryDirectory() as td:
    td = Path(td); root = td / "nexey-memory"; root.mkdir()
    for bad in ["../evil.md", "..\\evil.md", "C:\\Windows\\x.md", "/etc/x.md", "sub/2026-10-13.md",
                "2026-10-13.txt", "2026-10-13.md.exe", "notes.md", "2026-13-40.md",
                "2026-10-13.md:ads", "2026-10-13.ps1", "\\\\?\\C:\\x\\2026-10-13.md"]:
        expect_refused(repr(bad), lambda b=bad: G.append_entry("hi", filename=b, root=root))
    expect_refused("oversize", lambda: G.append_entry("x" * (G.MAX_BYTES + 1), filename="2026-10-13.md", root=root))
    outside = td / "outside.md"; outside.write_text("x")
    if subprocess.run(["cmd", "/c", "mklink", str(root / "2026-10-14.md"), str(outside)], capture_output=True).returncode == 0:
        expect_refused("file symlink to outside", lambda: G.append_entry("pwn", filename="2026-10-14.md", root=root))
    else:
        print("skip: file symlink (no SeCreateSymbolicLink privilege - so Nexy can't create one either)")
    real = td / "elsewhere"; real.mkdir(); link = td / "junction-root"
    if subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(real)], capture_output=True).returncode == 0:
        expect_refused("junction as root", lambda: G.append_entry("pwn", filename="2026-10-13.md", root=link))
        inner = root / "j"; subprocess.run(["cmd", "/c", "mklink", "/J", str(inner), str(real)], capture_output=True)
        expect_refused("path through inner junction", lambda: G.append_entry("pwn", filename="j\\2026-10-13.md", root=root))
    G.append_entry("first", filename="2026-10-13.md", kind="learned", root=root)
    G.append_entry("second", filename="2026-10-13.md", kind="got-wrong", root=root)
    t = (root / "2026-10-13.md").read_text(encoding="utf-8")
    assert "first" in t and "second" in t, t
    print("append ok:", len(t), "chars;", [f["file"] for f in G.list_files(root)])
    assert outside.read_text() == "x" and not any(real.iterdir())
print("RESULT:", "PASS" if fails == 0 else f"{fails} FAILURES")
sys.exit(1 if fails else 0)
