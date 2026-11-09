# Read a larger Python project: Rich

Rich formats terminal text, tables, progress bars and more. This is the complete
source tree of [Textualize/rich v14.3.4](https://github.com/Textualize/rich/tree/ee8378c3bbbd7c75abc2f55c6c19e83b218ae81d),
pinned to `ee8378c3bbbd7c75abc2f55c6c19e83b218ae81d`. Its MIT license is in LICENSE.
The local Git repository begins with a source snapshot; it does not contain upstream
commit history. The separate `reading/` examples, this guide, notes and project marker
were added by dhimantAI. Original library, examples and tests are preserved.

Use this with **Read an Unfamiliar Codebase**. You can begin here or first practice
with **shelf**. Basic functions, imports, classes and lists are enough to begin.

## Start

Open Project Coach in the right panel. All Python runs use the course container.
Choose **Runtime → Set up course** if needed. The project must be inside that course
folder. No Python installation on your computer is required.

On step 1 choose **Run this step**. Setup installs the pinned dependencies in
`.dhimantai-local/deps` inside the project mount, using Python in the container.
This first setup needs network access. If it times out, inspect the output and
retry explicitly. Subsequent reading runs and tests need no network or API key.

From **Runtime → Open terminal**, the equivalent commands are:

```sh
python -m reading.run setup
python -m reading.run text
python -m reading.run markup
python -m reading.run table
python -m reading.run protocol
python -m reading.run test-console
python -m reading.run test-markup
python -m reading.run test-table
```

## How to navigate

Start with a question, not the first line of the first file. Use Explorer to map
`rich/`, `tests/`, `examples/` and `docs/`. **Quick Open** finds a named file.
**Go to Symbol in Editor** finds a method in a long file. **Go to Definition** and
**Find All References** help follow calls when Python navigation is available;
otherwise use workspace search for the exact method name. No local interpreter
is needed for Quick Open, text search or Coach's links to relevant definitions.

Trace one path: caller → inputs → transformation → returned/yielded values → output.
Before each run, write a prediction in READING_NOTES.md. Afterward, record what the
output and test assertions actually support. Coach can explain a difficult part
or suggest a smaller example; you remain free to change steps or explore files.

Coach receives only the listed public excerpts when you send a message. For a long
file, place the cursor near the function you want to discuss; shared context shows
its starting line. The whole repository is available in VS Code, but Coach does
not silently receive it all. If a required file is absent from shared context,
use the authored route or explain the missing connection in your question.

The supplied path covers plain text → markup → rendering protocol → tables →
upstream tests → an independent trace. Tests are observations, not a course grade.
Record assistance and uncertainty. No local checkpoint awards course completion.
