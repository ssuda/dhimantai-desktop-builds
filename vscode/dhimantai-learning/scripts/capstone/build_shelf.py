"""Build the "shelf" capstone: a small real repository with a teammate's history and a regression to find.

    python3 scripts/capstone/build_shelf.py media/capstone/shelf.bundle

The learner clones the bundle (dhimantAI: Start the Capstone Project). Commit 5 of 7 quietly breaks
case-insensitive search; the existing tests do not notice. They reproduce the bug report, write a test that
fails on the old code, find the commit that caused it, fix it on a branch, commit, and write a PR note.
check.py in the repository is the judge. The history is rebuilt identically every time (fixed dates and authors).
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

MODELS = '''"""A book on the shelf."""
from dataclasses import dataclass, field


@dataclass
class Book:
    title: str
    author: str
    year: int
    tags: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data):
        return cls(title=data["title"], author=data["author"], year=int(data["year"]), tags=list(data.get("tags", [])))

    def to_dict(self):
        return {"title": self.title, "author": self.author, "year": self.year, "tags": self.tags}
'''

STORAGE = '''"""Read and write the shelf as JSON."""
import json
from pathlib import Path

from .models import Book


def load(path):
    path = Path(path)
    if not path.exists():
        return []
    return [Book.from_dict(item) for item in json.loads(path.read_text(encoding="utf-8"))]


def save(path, books):
    Path(path).write_text(json.dumps([book.to_dict() for book in books], indent=2) + "\\n", encoding="utf-8")
'''

SEARCH_V1 = '''"""Find books by a field."""


def normalize(text):
    """Compare text the way people type it: ignore case and surrounding spaces."""
    return " ".join(text.split()).casefold()


def search(books, query, field="title"):
    """Books whose field contains the query, in shelf order."""
    return [book for book in books if normalize(query) in normalize(getattr(book, field))]


def page(results, number, size=10):
    """One page of results. Pages start at 1."""
    start = (number - 1) * size
    return results[start:start + size]
'''

# Commit 5: a reasonable-looking speed-up that stops normalizing the book's side of the comparison.
SEARCH_V2 = '''"""Find books by a field."""


def normalize(text):
    """Compare text the way people type it: ignore case and surrounding spaces."""
    return " ".join(text.split()).casefold()


def search(books, query, field="title"):
    """Books whose field contains the query, in shelf order."""
    wanted = normalize(query)  # normalize the query once, not once per book
    return [book for book in books if wanted in getattr(book, field)]


def page(results, number, size=10):
    """One page of results. Pages start at 1."""
    start = (number - 1) * size
    return results[start:start + size]
'''

REPORT_V1 = '''"""Summaries of the shelf."""
from collections import Counter


def by_author(books):
    """Number of books per author, most first, then by name."""
    counts = Counter(book.author for book in books)
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))
'''

REPORT_V2 = REPORT_V1 + '''

def by_decade(books):
    """Number of books per decade, oldest first, e.g. ("1960s", 2)."""
    counts = Counter(f"{book.year // 10 * 10}s" for book in books)
    return sorted(counts.items())
'''

CLI_V1 = '''"""Command line: python3 -m shelf <command>."""
import argparse
import sys

from . import search as finder
from .models import Book
from .storage import load, save

DEFAULT = "books.json"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="shelf", description="Keep track of your books.")
    parser.add_argument("--file", default=DEFAULT, help="shelf file (default: books.json)")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add", help="add a book")
    add.add_argument("title"); add.add_argument("author"); add.add_argument("year", type=int)
    add.add_argument("--tag", action="append", default=[])
    commands.add_parser("list", help="list every book")
    find = commands.add_parser("search", help="find books")
    find.add_argument("query"); find.add_argument("--by", choices=["title", "author"], default="title")
    find.add_argument("--page", type=int, default=1)
    args = parser.parse_args(argv)

    books = load(args.file)
    if args.command == "add":
        books.append(Book(args.title, args.author, args.year, args.tag))
        save(args.file, books)
        print(f"Added {args.title}.")
    elif args.command == "list":
        for book in books:
            print(f"{book.title} ({book.year}) by {book.author}")
    elif args.command == "search":
        found = finder.page(finder.search(books, args.query, args.by), args.page)
        if not found:
            print("No books found.")
        for book in found:
            print(f"{book.title} ({book.year}) by {book.author}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''

CLI_V2 = CLI_V1.replace('''    find.add_argument("--page", type=int, default=1)
    args = parser.parse_args(argv)''', '''    find.add_argument("--page", type=int, default=1)
    report = commands.add_parser("report", help="summaries")
    report.add_argument("--by", choices=["author", "decade"], default="author")
    args = parser.parse_args(argv)''').replace('''from . import search as finder''', '''from . import report as summary
from . import search as finder''').replace('''            print(f"{book.title} ({book.year}) by {book.author}")
    return 0''', '''            print(f"{book.title} ({book.year}) by {book.author}")
    elif args.command == "report":
        rows = summary.by_author(books) if args.by == "author" else summary.by_decade(books)
        for name, count in rows:
            print(f"{name}: {count}")
    return 0''')

MAIN = '''from .cli import main

raise SystemExit(main())
'''

BOOKS = '''[
  {"title": "Dune", "author": "Frank Herbert", "year": 1965, "tags": ["sci-fi"]},
  {"title": "The Left Hand of Darkness", "author": "Ursula K. Le Guin", "year": 1969, "tags": ["sci-fi"]},
  {"title": "A Wizard of Earthsea", "author": "Ursula K. Le Guin", "year": 1968, "tags": ["fantasy"]},
  {"title": "Children of Dune", "author": "Frank Herbert", "year": 1976, "tags": ["sci-fi"]},
  {"title": "The Dispossessed", "author": "Ursula K. Le Guin", "year": 1974, "tags": ["sci-fi"]},
  {"title": "Kindred", "author": "Octavia E. Butler", "year": 1979, "tags": ["fiction"]}
]
'''

TEST_MODELS = '''import unittest

from shelf.models import Book


class BookTest(unittest.TestCase):
    def test_round_trip(self):
        data = {"title": "Kindred", "author": "Octavia E. Butler", "year": 1979, "tags": ["fiction"]}
        self.assertEqual(Book.from_dict(data).to_dict(), data)

    def test_year_from_text(self):
        self.assertEqual(Book.from_dict({"title": "t", "author": "a", "year": "1999"}).year, 1999)


if __name__ == "__main__":
    unittest.main()
'''

TEST_STORAGE = '''import tempfile
import unittest
from pathlib import Path

from shelf.models import Book
from shelf.storage import load, save


class StorageTest(unittest.TestCase):
    def test_save_then_load(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "books.json"
            save(path, [Book("Dune", "Frank Herbert", 1965)])
            self.assertEqual(load(path), [Book("Dune", "Frank Herbert", 1965)])

    def test_missing_file_is_an_empty_shelf(self):
        self.assertEqual(load("/nonexistent/books.json"), [])


if __name__ == "__main__":
    unittest.main()
'''

# The teammate's tests only use lowercase titles, so commit 5 passes them.
TEST_SEARCH = '''import unittest

from shelf.models import Book
from shelf.search import page, search

BOOKS = [Book("dune", "frank herbert", 1965), Book("kindred", "octavia e. butler", 1979),
         Book("children of dune", "frank herbert", 1976)]


class SearchTest(unittest.TestCase):
    def test_finds_part_of_a_title(self):
        self.assertEqual([b.title for b in search(BOOKS, "dune")], ["dune", "children of dune"])

    def test_by_author(self):
        self.assertEqual(len(search(BOOKS, "herbert", field="author")), 2)

    def test_no_match(self):
        self.assertEqual(search(BOOKS, "zzz"), [])

    def test_pages_start_at_one(self):
        self.assertEqual(page(list(range(25)), 3, size=10), [20, 21, 22, 23, 24])


if __name__ == "__main__":
    unittest.main()
'''

TEST_REPORT_V1 = '''import unittest

from shelf.models import Book
from shelf.report import by_author

BOOKS = [Book("a", "Le Guin", 1969), Book("b", "Herbert", 1965), Book("c", "Le Guin", 1974)]


class ReportTest(unittest.TestCase):
    def test_by_author(self):
        self.assertEqual(by_author(BOOKS), [("Le Guin", 2), ("Herbert", 1)])


if __name__ == "__main__":
    unittest.main()
'''

TEST_REPORT_V2 = TEST_REPORT_V1.replace('from shelf.report import by_author', 'from shelf.report import by_author, by_decade').replace(
    '''        self.assertEqual(by_author(BOOKS), [("Le Guin", 2), ("Herbert", 1)])
''', '''        self.assertEqual(by_author(BOOKS), [("Le Guin", 2), ("Herbert", 1)])

    def test_by_decade(self):
        self.assertEqual(by_decade(BOOKS), [("1960s", 2), ("1970s", 1)])
''')

README = '''# shelf

Keep track of the books you own from the command line. Python 3.10+, no dependencies.

```sh
python3 -m shelf list
python3 -m shelf search dune
python3 -m shelf search "le guin" --by author
python3 -m shelf report --by decade
python3 -m shelf add "Parable of the Sower" "Octavia E. Butler" 1993 --tag fiction
```

Run the tests with `python3 -m unittest discover -s tests -t .`.
'''

ISSUE = '''# Issue #12: search misses books it used to find

**Reported by:** Meera (a shelf user)

Since last week, `python3 -m shelf search dune` prints "No books found." My shelf has "Dune" and
"Children of Dune", and this search used to list both. Searching by author also seems broken:
`python3 -m shelf search "le guin" --by author` finds nothing.

I am on the latest version.
'''

CAPSTONE = '''# Capstone: fix issue #12 like a working engineer

You have joined the team that maintains **shelf**. A user filed [ISSUE.md](ISSUE.md). Fix it the way you would at
work: understand the code first, prove the bug with a test, find what caused it, fix it with the smallest change,
and explain it for a reviewer. Tutor can coach you, but nobody will write the fix for you.

## Steps

1. **Read before you change.** Run `python3 -m shelf list` and `python3 -m unittest discover -s tests -t .`.
   Open `shelf/cli.py` and follow `search` from the command line to the function that decides what matches.
2. **Reproduce.** Run the exact commands from the issue. Write down what you expected and what happened.
3. **Prove it with a test.** Add a test to `tests/test_search.py` that fails *because of this bug*. Run it and watch it fail.
4. **Find when it broke.** Use `git log --oneline` and `git log -p shelf/search.py`, or `git bisect` with your test.
   Note the short hash of the commit that introduced the bug.
5. **Fix it on a branch.** `git switch -c fix-search-case`. Make the smallest change that fixes the bug without
   losing what that commit was trying to do. Run every test.
6. **Commit.** One commit, with a message that says what changed and mentions `#12`.
7. **Write the pull request.** Create `PR.md` with three sections: `## Cause` (include the short hash of the commit
   that introduced the bug), `## Fix` and `## Test`. Commit it too.

## Check your work

```sh
python3 check.py
```

The checker runs the project's tests, runs acceptance checks for issue #12, and puts the old `search.py` back
temporarily to confirm **your test fails on the buggy code**. A test that passes either way does not prove anything.
It also checks your branch, your commit message, a clean working tree and your PR note.
'''

CHECK = r'''"""The capstone judge: python3 check.py. Reports every check; exits 0 only when all of them pass."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
START = "start"  # the tag where the capstone began
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"\n     {detail}" if detail and not ok else ""))


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def tests(folder):
    return subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                          cwd=folder, capture_output=True, text=True, timeout=120)


run = tests(ROOT)
check("All project tests pass", run.returncode == 0, run.stderr.strip().splitlines()[-1] if run.stderr.strip() else "")

sys.path.insert(0, str(ROOT))
try:
    from shelf.models import Book
    from shelf.search import search
    books = [Book("Dune", "Frank Herbert", 1965), Book("Children of Dune", "Frank Herbert", 1976),
             Book("A Wizard of Earthsea", "Ursula K. Le Guin", 1968)]
    check("Issue #12: 'dune' finds Dune and Children of Dune",
          [b.title for b in search(books, "dune")] == ["Dune", "Children of Dune"])
    check("Issue #12: 'le guin' finds Ursula K. Le Guin by author", len(search(books, "le guin", field="author")) == 1)
    check("Search still ignores extra spaces and case in the query", len(search(books, "  CHILDREN   of dune ")) == 1)
except Exception as error:  # report, do not crash the judge
    check("Search can be imported and called", False, repr(error))

changed = [p for p in git("diff", "--name-only", START, "--", "tests").stdout.split() if p.endswith(".py")]
check("You added or changed a test", bool(changed), "Add a test for issue #12 under tests/.")
if changed:
    with tempfile.TemporaryDirectory() as folder:
        copy = Path(folder) / "shelf-copy"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "__pycache__"))
        old = git("show", START + ":shelf/search.py").stdout
        (copy / "shelf" / "search.py").write_text(old, encoding="utf-8")
        before = tests(copy)
        check("Your test fails on the buggy code (it really catches the bug)", before.returncode != 0,
              "With the old search.py every test still passes, so your test would not have caught issue #12.")

branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
check("You work on a branch, not main", branch not in ("main", "master", "HEAD"), f"Current branch: {branch}")
messages = git("log", "--format=%s%n%b", START + "..HEAD").stdout
check("At least one commit mentions #12", "#12" in messages, "Mention #12 in your commit message.")
check("Working tree is clean (everything committed)", git("status", "--porcelain").stdout.strip() == "",
      "Commit or remove your remaining changes.")

pr = ROOT / "PR.md"
text = pr.read_text(encoding="utf-8") if pr.exists() else ""
sections = {name: re.search(rf"^## {name}\s*\n(.+?)(?=^## |\Z)", text, re.S | re.M) for name in ("Cause", "Fix", "Test")}
check("PR.md has Cause, Fix and Test sections", all(m and len(m.group(1).strip()) >= 20 for m in sections.values()),
      "Write at least a sentence under each heading.")
culprit = git("log", "--format=%h %H", START, "-S", "if wanted in getattr(book, field)", "--", "shelf/search.py").stdout.split()
cause = sections["Cause"].group(1) if sections["Cause"] else ""
check("Cause names the commit that introduced the bug",
      any(re.search(r"\b" + h[:7], cause) for h in culprit[1::2]) if culprit else False,
      "Use git log or git bisect to find the commit, then quote its short hash.")

passed = sum(results)
print(f"\n{passed} of {len(results)} checks passed." + ("  Ready for review." if passed == len(results) else ""))
sys.exit(0 if passed == len(results) else 1)
'''

GITIGNORE = '__pycache__/\n*.pyc\n'

HISTORY = [
    ('Asha Rao', 'asha@shelf.dev', '2026-09-01T10:00:00+05:30', 'Store books as JSON', {
        'shelf/__init__.py': '', 'shelf/models.py': MODELS, 'shelf/storage.py': STORAGE, 'books.json': BOOKS,
        'tests/__init__.py': '', 'tests/test_models.py': TEST_MODELS, 'tests/test_storage.py': TEST_STORAGE,
        '.gitignore': GITIGNORE}),
    ('Asha Rao', 'asha@shelf.dev', '2026-09-03T15:20:00+05:30', 'Search books by title or author', {
        'shelf/search.py': SEARCH_V1, 'tests/test_search.py': TEST_SEARCH}),
    ('Vikram Shah', 'vikram@shelf.dev', '2026-09-08T11:05:00+05:30', 'Add the command line', {
        'shelf/cli.py': CLI_V1, 'shelf/__main__.py': MAIN}),
    ('Vikram Shah', 'vikram@shelf.dev', '2026-09-12T17:40:00+05:30', 'Report how many books each author has', {
        'shelf/report.py': REPORT_V1, 'tests/test_report.py': TEST_REPORT_V1}),
    ('Asha Rao', 'asha@shelf.dev', '2026-09-19T09:30:00+05:30', 'Speed up search on large shelves', {
        'shelf/search.py': SEARCH_V2}),
    ('Vikram Shah', 'vikram@shelf.dev', '2026-09-24T14:10:00+05:30', 'Report books per decade', {
        'shelf/report.py': REPORT_V2, 'tests/test_report.py': TEST_REPORT_V2, 'shelf/cli.py': CLI_V2}),
    ('Asha Rao', 'asha@shelf.dev', '2026-09-30T12:00:00+05:30', 'Document usage; add issue #12 and the capstone brief', {
        'README.md': README, 'ISSUE.md': ISSUE, 'CAPSTONE.md': CAPSTONE, 'check.py': CHECK}),
]


def build(bundle):
    with tempfile.TemporaryDirectory() as folder:
        repo = Path(folder) / 'shelf'
        repo.mkdir()
        env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
        run = lambda *args, **extra: subprocess.run(['git', *args], cwd=repo, check=True, capture_output=True,
                                                     env={**env, **extra})
        run('init', '-q', '-b', 'main')
        for author, email, date, message, files in HISTORY:
            for name, content in files.items():
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text(content, encoding='utf-8')
            run('add', '-A')
            run('commit', '-q', '-m', message, GIT_AUTHOR_NAME=author, GIT_AUTHOR_EMAIL=email, GIT_AUTHOR_DATE=date,
                GIT_COMMITTER_NAME=author, GIT_COMMITTER_EMAIL=email, GIT_COMMITTER_DATE=date)
        run('tag', START_TAG)
        # Preserve the original training history/start tag used by existing learner repositories.
        (repo / '.gitignore').write_text(GITIGNORE + '/.vscode/\n/.idea/\n', encoding='utf-8')
        (repo / 'CAPSTONE.md').write_text(CAPSTONE + '\nLocal editor settings in .vscode/ and .idea/ are ignored; commit your project changes.\n', encoding='utf-8')
        run('add', '.gitignore', 'CAPSTONE.md')
        run('commit', '-q', '-m', 'Ignore local editor settings', GIT_AUTHOR_NAME='Asha Rao', GIT_AUTHOR_EMAIL='asha@shelf.dev',
            GIT_COMMITTER_NAME='Asha Rao', GIT_COMMITTER_EMAIL='asha@shelf.dev',
            GIT_AUTHOR_DATE='2026-10-01T10:00:00+05:30', GIT_COMMITTER_DATE='2026-10-01T10:00:00+05:30')
        # Update the current guides without rewriting the training history or start tag.
        terminal = ('Open **dhimantAI: Open Course Terminal**, then run `cd /course/shelf-capstone` '
                    '(or `cd /course/shelf-reading` for the reading project).\n'
                    'Run all project, Git and test commands there. The course container supplies Python\n'
                    'and Git, with identical commands on Windows, macOS and Linux.\n')
        for name in ('README.md', 'CAPSTONE.md', 'ISSUE.md', 'check.py', 'shelf/cli.py'):
            content = (repo / name).read_text(encoding='utf-8').replace('python3', 'python')
            if name == 'README.md':
                content = content.replace('Python 3.10+, no dependencies.',
                                          'The course container supplies Python 3.10+ and Git.')
                content = content.replace('\n\n```sh', '\n\n' + terminal + '\n```sh', 1)
            if name == 'CAPSTONE.md':
                content = content.replace('\n## Steps\n', '\n## Course terminal\n\n' + terminal + '\n## Steps\n')
            (repo / name).write_text(content, encoding='utf-8')
        run('add', 'README.md', 'CAPSTONE.md', 'ISSUE.md', 'check.py', 'shelf/cli.py')
        run('commit', '-q', '-m', 'Use the course container terminal for project commands',
            GIT_AUTHOR_NAME='Asha Rao', GIT_AUTHOR_EMAIL='asha@shelf.dev',
            GIT_COMMITTER_NAME='Asha Rao', GIT_COMMITTER_EMAIL='asha@shelf.dev',
            GIT_AUTHOR_DATE='2026-10-02T10:00:00+05:30', GIT_COMMITTER_DATE='2026-10-02T10:00:00+05:30')
        bundle = Path(bundle).resolve()
        bundle.parent.mkdir(parents=True, exist_ok=True)
        run('bundle', 'create', str(bundle), '--all')


START_TAG = 'start'

if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else 'media/capstone/shelf.bundle')
