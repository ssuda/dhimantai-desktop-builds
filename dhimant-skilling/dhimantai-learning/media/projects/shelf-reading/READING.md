# Read a small Python project: shelf

This small, authored training repository is a command-line book catalogue. Use it
with **Read an Unfamiliar Codebase**, then continue with the larger Rich project.
You can also start with Rich directly. The repository's existing training history
and intentional search defect are preserved. Reading does not require fixing it.

Open Project Mentor on the right. Use its steps to map folders, find an entry point,
follow a call, trace data, predict output and compare tests with real behaviour.

## Milestone 1 · Map the repository

1. Open [READING_NOTES.md](READING_NOTES.md). Under **Repository map and question**, write
   one bullet each for `shelf/`, `tests/` and `books.json`. Use `- path — its purpose`.
   Line numbers are optional.
2. Predict the available commands, then choose **Run this step** to run `python -m shelf --help`.
   You can also run it in **Project tools → Runtime → Open course terminal**.
3. In the checkpoint, name one command shown in the help and describe what it does.
   Choose **Complete milestone**. To save an unfinished checkpoint, choose **Save draft**.

## Later milestones

Milestone 2 introduces `python -m shelf list`. Each milestone's **Run this step**
button runs its own example or focused tests in the course container.

<details>
<summary>Check your result after predicting the search output</summary>

In the starter, `list` includes **Dune** and `search dune` prints **No books found.**
Milestone 4, **Predict a search**, asks you to trace that difference in `shelf/search.py`.

</details>

Use Explorer for the first map, Quick Open for a named file, and workspace search
for an exact symbol or output message. Go to Definition and Find All References
can help when Python navigation is available; exact symbol search is the fallback.
For each trace record: caller → input → transformation → side effect → output.
Write predictions and source evidence in READING_NOTES.md, then run the example.

Some existing documents describe a separate bug-fixing capstone. This course asks
you to understand and explain the mismatch first. A successful command or passing
test does not mean every behaviour is correct or prove your understanding.
Local checkpoints record notes and assistance; they are not official submissions.
