# Course Research Agent

Build a Python agent that searches a small collection of fictional course documents,
reads relevant documents and answers using exact quotations with sources. These
documents are learning fixtures, not dhimantAI policies.

Open this folder in VS Code with dhimantAI Learning. Choose **Open Project Coach**
to resume the milestones in the right-hand Coach panel. Start with the brief,
then implement search, document reading, dispatch, the loop and evidence checks.
The editor stays available at every step. Coach help is optional.

Execution uses the managed course container, which supplies Python 3.10+.
No local Python installation is used. Start a Course Project sets up the course
runtime and creates this repository inside its mounted course folder. The starter
uses only the standard library. Open **Runtime → Open terminal** in Coach and run
all commands below there. Git remains available through VS Code on your computer.

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
After the core works, use **Runtime → Open terminal** in Coach for a live model run:

```sh
python -m course_agent --live --question "How do I submit my project?" --trace
```

Live mode uses DeepSeek, matching the platform's provider convention. Set
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
Saving a Coach checkpoint stores local progress and assistance metadata. Chat and
run output are temporary. No checkpoint is submitted or graded automatically.
