"""Verify Shelf milestones in the course container, using the installed starter's Git history."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path.cwd()
START = sys.argv[2]
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", GIT_NO_REPLACE_OBJECTS="1",
           GIT_OPTIONAL_LOCKS="0", GIT_CEILING_DIRECTORIES=str(ROOT.parent), LC_ALL="C")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(args, cwd=ROOT):
    return subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=12)


# Shared across all Git reads in a checkpoint, including reads after the tests run.
# macOS bind mounts can cache a missing, atomically replaced HEAD for five seconds.
git_delays = iter((0.1, 0.2, 0.4, 0.8, 1.5, 2, 2, 2))


def wait_for_git():
    delay = next(git_delays, None)
    if delay is None:
        return False
    time.sleep(delay)
    return True


def read_git(*args):
    while True:
        result = run(["git", *args])
        if result.returncode == 0:
            return result.stdout
        transient = ("not a git repository", "bad object head", "stale file handle", "input/output error",
                     "unknown error occurred while reading the configuration files")
        if not any(message in result.stderr.lower() for message in transient) or not wait_for_git():
            raise ValueError("Could not read the Shelf Git history. " + result.stderr.strip()[:400])


def git(*args):
    return read_git(*args).strip()


def checkout_revision():
    # A desktop bind mount can briefly lose HEAD or show the previous checkout
    # after Git atomically renames a ref. Poll only Git metadata, never learner tests.
    expected = sys.argv[3] if len(sys.argv) > 3 else None
    while True:
        status = read_git("status", "--porcelain=v2", "--branch", "--untracked-files=no")
        fields = dict(line[2:].split(" ", 1) for line in status.splitlines() if line.startswith("# branch."))
        head, branch = fields.get("branch.oid", ""), fields.get("branch.head", "")
        if branch == "(detached)":
            branch = "HEAD"
        if branch and re.fullmatch(r"[0-9a-f]{40,64}", head):
            revision = hashlib.sha256((branch + "\0" + head).encode()).hexdigest()
            if not expected or expected == revision:
                return head, branch
        if not wait_for_git():
            break
    raise ValueError("The course container could not see the saved Shelf checkout. Check that the project folder "
                     "contains the repository and that Git has finished switching branches, then verify again.")


def tests(cwd):
    return run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"], cwd)


def green(result):
    return result.returncode == 0 and re.search(r"^Ran [1-9]\d* tests? in ", result.stderr, re.M) and result.stderr.rstrip().endswith("OK")


def git_source(revision):
    return git("show", revision + ":shelf/search.py") + "\n"


def culprit():
    return git("log", "-1", "--format=%H", "-S", "if wanted in getattr(book, field)", START, "--", "shelf/search.py")


def fixture(folder):
    # Only the authored project package, test modules and data are needed.
    for name in ("shelf", "tests"):
        source = ROOT / name
        require(not source.is_symlink(), "Use regular package and test directories.")
        for file in source.rglob("*.py"):
            require(not file.is_symlink() and file.resolve().is_relative_to(source), "Use regular project and test files for verification.")
            dest = folder / file.relative_to(ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, dest)
    shutil.copyfile(ROOT / "books.json", folder / "books.json")


def checked_tests(folder):
    result = tests(folder)
    require(green(result), "Run the project tests and resolve failures, errors or skipped tests.")
    return re.search(r"^Ran (\d+) tests? in ", result.stderr, re.M)[1]


def issue_cases(folder):
    for args, titles in [(["dune"], ["Dune", "Children of Dune"]),
                         (["le guin", "--by", "author"], ["The Left Hand of Darkness", "A Wizard of Earthsea", "The Dispossessed"]),
                         (["  CHILDREN   of dune "], ["Children of Dune"])]:
        result = run([sys.executable, "-B", "-m", "shelf", "search", *args], folder)
        require(result.returncode == 0 and [line.split(" (")[0] for line in result.stdout.splitlines()] == titles,
                "Check the title, author and whitespace cases from issue #12.")


def verify(step, folder):
    head, branch = checkout_revision()
    if step == "history":
        sha = culprit()
        return "Traced the change to shelf/search.py at " + sha[:7], [sha]
    if step == "map":
        # Observe the actual Python modules called by the search command.
        trace = run([sys.executable, "-B", "-c", """
import runpy, sys
def observe(frame, event, _):
    if event == 'call' and (frame.f_globals.get('__name__'), frame.f_code.co_name) in {
        ('__main__', '<module>'), ('shelf.cli', 'main'), ('shelf.search', 'search')}:
        print(frame.f_code.co_filename)
sys.setprofile(observe)
sys.argv = ['shelf', 'search', 'dune']
runpy.run_module('shelf', run_name='__main__', alter_sys=True)
"""])
        route = [path for path in ("shelf/__main__.py", "shelf/cli.py", "shelf/search.py")
                 if str(ROOT / path) in trace.stdout.splitlines()]
        require(trace.returncode == 0 and len(route) == 3,
                "Follow the search command from the package entry point through the CLI to its matching function.")
        count = checked_tests(ROOT)
        return "Traced " + " -> ".join(route) + " and ran " + count + " tests", [" -> ".join(route)]
    if step == "reproduce":
        fixture(folder)
        (folder / "shelf/search.py").write_text(git_source(START))
        result = run([sys.executable, "-B", "-m", "shelf", "search", "dune"], folder)
        require(result.returncode == 0 and result.stdout.strip() == "No books found.", "Reproduce the lowercase title search against the starter.")
        matches = [book["title"] for book in json.loads((folder / "books.json").read_text()) if "dune" in book["title"].casefold()]
        require(matches, "The project fixture must contain titles matching dune.")
        return "Starter search for dune printed No books found; expected " + ", ".join(matches), [result.stdout.strip() + " -> " + ", ".join(matches)]
    if step == "regression":
        fixture(folder)
        search = folder / "shelf/search.py"
        search.write_text(git_source(START))
        broken = tests(folder)
        failures = re.findall(r"^FAIL: (test_\w+) \(", broken.stderr, re.M)
        require(broken.returncode == 1 and failures and not re.search(r"^ERROR:|skipped=", broken.stderr, re.M),
                "Add a regression test that fails an assertion on the original search code.")
        search.write_text(git_source(culprit() + "^"))
        require(green(tests(folder)), "The same test must pass with the original case-insensitive behavior restored.")
        return "Regression failed on the bug and passed on the working version: " + failures[0], failures
    if step in ("fix", "commit"):
        require(branch not in ("HEAD", "main", "master"), "Put the repair on a project branch.")
        checked_tests(ROOT)
        issue_cases(ROOT)
        if step == "fix":
            return "Title, author, whitespace and project tests passed on " + branch, [branch]
        paths = git("diff", "--name-only", START, "HEAD").splitlines()
        require("shelf/search.py" in paths and any(p.startswith("tests/") and p.endswith(".py") for p in paths)
                and "#12" in git("log", "--format=%B", START + "..HEAD")
                and not git("status", "--porcelain", "--", "shelf", "tests"),
                "Commit your repair and regression test, mention #12 in the commit history, and save any remaining source or test changes.")
        return "Verified committed repair and regression on " + branch + " at " + head[:7], [head]
    if step in ("review", "final"):
        require(git("rev-parse", "start") == START, "Restore the original Shelf start tag before final verification.")
        # The course-container edition updated the command in the opening docstring.
        starter_checker = read_git("show", START + ":check.py")
        container_checker = starter_checker.replace("The capstone judge: python3 check.py.", "The capstone judge: python check.py.", 1)
        require((ROOT / "check.py").read_text() in (starter_checker, container_checker),
                "Restore the supplied check.py before final verification.")
        result = run([sys.executable, "-B", "check.py"])
        require(result.returncode == 0 and "11 of 11 checks passed." in result.stdout, result.stdout.strip() or result.stderr.strip() or "The final checker failed.")
        if step == "final":
            print(result.stdout.strip())
        return "All 11 final checks passed at " + head[:7], [head]
    raise ValueError("Unknown Shelf milestone.")


try:
    with tempfile.TemporaryDirectory() as tmp:
        summary, answers = verify(sys.argv[1], Path(tmp))
        if sys.argv[1] != "final":
            print(json.dumps({"summary": summary, "answers": answers}))
except (OSError, ValueError, subprocess.SubprocessError) as error:
    print(str(error))
    sys.exit(1)
