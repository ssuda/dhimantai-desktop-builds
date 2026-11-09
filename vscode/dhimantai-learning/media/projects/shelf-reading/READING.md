# Read a small Python project: shelf

This small, authored training repository is a command-line book catalogue. Use it
with **Read an Unfamiliar Codebase**, then continue with the larger Rich project.
You can also start with Rich directly. The repository's existing training history
and intentional search defect are preserved. Reading does not require fixing it.

Open Project Coach on the right. Use its steps to map folders, find an entry point,
follow a call, trace data, predict output and compare tests with real behaviour.
The sample data is in **books.json** in the project root; `shelf/storage.py` loads it.
**Runtime → Open course terminal** runs in the course container and this project directory.
Run the commands below there on Windows, macOS and Linux. The container supplies
Python and Git. The project must be inside its course folder.

```sh
python -m shelf --help
python -m shelf list
python -m shelf search dune
python -m shelf report --by decade
python -m unittest tests.test_search -v
```

Use Explorer for the first map, Quick Open for a named file, and workspace search
for an exact symbol or output message. Go to Definition and Find All References
can help when Python navigation is available; exact symbol search is the fallback.
For each trace record: caller → input → transformation → side effect → output.
Write predictions and source evidence in READING_NOTES.md, then run the example.

Some existing documents describe a separate bug-fixing capstone. This course asks
you to understand and explain the mismatch first. A successful command or passing
test does not mean every behaviour is correct or prove your understanding.
Local checkpoints record notes and assistance; they are not official submissions.
