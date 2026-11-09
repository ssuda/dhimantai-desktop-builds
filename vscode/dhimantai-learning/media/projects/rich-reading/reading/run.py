"""Run the pinned source and selected tests in the course container.

The launcher keeps extra packages in an ignored directory. It never installs a
second Rich: imports must resolve to the source tree the student is reading.
"""
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEPS = ROOT / ".dhimantai-local" / "deps"
sys.path.insert(0, str(DEPS))
sys.path.insert(0, str(ROOT))


def ready():
    for line in (ROOT / "reading" / "requirements.txt").read_text().splitlines():
        name, version = line.split("==")
        try:
            if importlib.metadata.version(name) != version:
                return False
        except importlib.metadata.PackageNotFoundError:
            return False
    return True


def main():
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode == "setup":
        if not ready():
            subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                            "--timeout", "10", "--retries", "0", "--upgrade", "--target", str(DEPS),
                            "-r", str(ROOT / "reading" / "requirements.txt")], check=True, timeout=25)
        if not ready():
            raise RuntimeError("Dependencies were not installed. Inspect setup output and retry.")
        import rich
        if Path(rich.__file__).resolve() != ROOT / "rich" / "__init__.py":
            raise RuntimeError("Rich did not load from this source tree.")
        print("Ready: Rich loads from", rich.__file__)
        print("Library source, focused tests and reading examples are available.")
        return
    if not ready():
        raise RuntimeError("Run step 1 setup in the course container first.")
    tests = {
        "test-console": ["tests/test_console.py::test_print", "tests/test_console.py::test_print_multiple", "tests/test_console.py::test_print_empty"],
        "test-markup": ["tests/test_markup.py", "tests/test_text.py::test_from_markup"],
        "test-table": ["tests/test_table.py"],
    }
    if mode in tests:
        os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
        import pytest
        raise SystemExit(pytest.main(["-q", "--color=no", *tests[mode]]))
    from . import examples
    demos = {"text": examples.plain_text, "markup": examples.markup,
             "table": examples.table, "protocol": examples.protocol}
    if mode not in demos:
        raise ValueError("Choose setup, text, markup, table, protocol, test-console, test-markup or test-table.")
    demos[mode]()


if __name__ == "__main__":
    main()
