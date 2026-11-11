# Course Research Agent

Build a Python agent that searches a small collection of fictional course documents,
reads relevant documents and answers using exact quotations with sources. These
documents are learning fixtures, not dhimantAI policies.

Open this folder in VS Code with dhimantAI Learning. Choose **Open Project Coach**
to resume the milestones in the right-hand Coach panel. Start with the brief,
then implement search, document reading, dispatch, the loop and evidence checks.
The editor stays available at every step. Coach help is optional.

Execution uses the managed course container, which supplies Python 3.10+.
Start a Course Project sets up the course
runtime and creates this repository inside its mounted course folder. The starter
uses only the standard library. Open **Runtime → Open course terminal** in Coach and run
all commands below there. The terminal opens in the project folder inside the
container and supplies Python and Git. These commands are the same on Windows,
macOS and Linux.

```sh
python -m unittest checks.test_setup -v
python -m course_agent --scenario submission --trace
python -m unittest discover -s checks -t . -v
```

Setup checks pass initially. The application reports the next unimplemented piece;
implementation checks intentionally fail until you build it. `tests/test_my_agent.py`
is yours to extend. Public checks are editable local feedback, not official grades.

`course_agent/__main__.py` loads data and calls `agent.run_agent`. The loop asks a
model for an action, `tools.dispatch` validates it, and the search/read modules
produce observations. `answers.supported_answer` checks the final quotations.
Function docstrings specify exact contracts. Each milestone explains its check.

Scripted scenarios simulate model replies to test your orchestration reproducibly.
After the core works, choose **Milestone 9 → Run live model** in Project Coach.
Sign in to the platform and enter your question. Your Python agent runs in the course
container; its model requests use managed server-side DeepSeek access. You do not
need a personal API key. Model requests and replies stay temporary; usage metadata
is retained for limits and monitoring. The allowance is six calls per run and
36 calls per learner per rolling 24 hours. Failures consume their reserved call.
Unavailable platform access leaves live verification pending; it does not turn a
scripted simulation into a live result.

For advanced users with their own provider access, a direct run in the course
container terminal is optional:

```sh
python -m course_agent --live --question "How do I submit my project?" --trace
```

This optional direct mode uses DeepSeek. Set
`DEEPSEEK_API_KEY` in the selected runtime's environment; optionally set
`DEEPSEEK_MODEL` (default `deepseek-flash`). Never paste a key into Coach or commit
it. The adapter does not load env files. A run can make up to six paid requests,
each with a 20-second timeout and no automatic retries. See the
[provider JSON output contract](https://api-docs.deepseek.com/guides/json_mode/).
Missing access is a setup limitation; scripted checks do not demonstrate live
model quality. Compare several live runs and inspect actual tool use and answers.

The extractive contract checks exact quotations from documents read in that run.
It does not establish relevance or general semantic support. Add cases that reveal
these limits and explain what a broader answer policy would need.

Record your design, evidence, known limits and assistance in `EXPLANATION.md`.
At **Milestone 10**, run the full checks, save your files and choose **Prepare final
handoff**. Institute learners confirm **Submit project for teacher review**; this
saves a frozen copy for their assigned Python teacher. Refresh submission status
to see the receipt and teacher feedback. A missing teacher assignment is shown
explicitly. Independent learners save a local JSON handoff to share themselves;
that export is not an institute submission.

The handoff includes public Python source and tests (including your custom tests),
the supplied JSON fixtures, README, EXPLANATION, and your assistance report. It
excludes chat, environment files, private folders and Git history. Local checks
are reported evidence; teacher review does not automatically award a course grade.
Saving a Coach checkpoint remains a separate local action and never submits work.
