# dhimantAI Learning 0.39.22

Learn with **Instructor**, ask questions in **Doubt Solver**, and find your next course
in **Course Catalog**, all inside VS Code. Write, save, debug, and test code in
VS Code. Projects, tests and course terminals use the managed course container
on Windows, macOS and Linux. Google Colab is available for supported Python notebooks. **Colab supplies the runtime;
VS Code remains your coding workspace.**

The password eye buttons show or hide what you type in Sign in and Create account.
Passwords start masked and are masked again when you submit or retry.

**Forgot password?** on Sign in sends a reset link to the registered email.
Open it on the same computer and desktop profile to choose a new password, then
sign in. Requests use Supabase recovery with PKCE; the verifier is kept in
SecretStorage, and a recovery session never replaces the saved login.
Before releasing, allow `dhimantai://optficial.dhimantai-learning/password-reset**`
in each deployed Supabase Auth redirect allowlist (`GOTRUE_URI_ALLOW_LIST` for
self-hosted services). VS Code installations also need the equivalent `vscode://`
or `vscode-insiders://` entry. These are included in the local Supabase config.
Keep the recovery email template's Supabase confirmation link and verify actual
email delivery and return to the installed desktop in each release environment.

## Learning roadmaps and job-readiness certificates

Open **Course Catalog → Roadmap, grade & certificate** to see role prerequisites,
Micro/Minor/Major projects, extra topic challenges, interview practice, weekly mocks
and Help. Start an unlocked guided project with the supplied brief or your custom
requirements. Coach uses the same course container and project workflow.
**Project actions → Preview running application** opens supported web applications
and dashboards running in that container.

New certificates require independent assessment of projects, an unfamiliar observed
practical task and project defence. Every essential role criterion must pass.
Practice grades and local checkboxes cannot issue a certificate. Approved assigned
teachers use **Review Assigned Readiness Assessments**; historical certificates retain
their original evidence scope. Weekly written/practical mocks receive assessor feedback.

Deploy the matching database migration and API before this extension. See
[Skilling readiness and rollout](../../docs/skilling-job-readiness.md) for requirements,
assessment operations, preview ports and validation.

## Find a command

Run **dhimantAI: Search Commands** to open the Command Palette filtered to
available dhimantAI actions, then type part of the command name. New commands
appear automatically, with VS Code's normal availability rules and shortcuts.
You can also choose **Search commands** under **How courses, access and code help work**
at the bottom of Course Catalog, even before signing in. The extension's built-in
**Features → Commands** table is supplied by VS Code; this search uses its
existing Command Palette.

## Git and GitHub repositories

Run **dhimantAI: Git & GitHub** from the Command Palette or find it through
**dhimantAI: Search Commands**. The custom dhimantAI desktop also has a
**Git & GitHub** entry in its Learning sidebar.

- **Create GitHub repository** publishes the open folder through VS Code's
  built-in flow: sign in, choose a repository name and public/private visibility,
  and select initial files when prompted. Publishing creates the repository and
  uploads its commits.
- **Clone repository** accepts a Git URL or lets you choose a GitHub repository.
- **Push**, **Pull**, and **Fetch** upload commits, integrate remote changes, or
  download remote history without merging, respectively.
- **Initialize local repository**, **Create branch**, **Switch branch**, and
  **Add remote** use the editor's existing repository controls.
- **Open Source Control** lets you review, stage and commit changes before pushing.

Git, GitHub and GitHub Authentication are built into VS Code; no additional
Marketplace extension is needed for these actions. Install Git on the computer
where VS Code's Git extension runs, and keep these built-in extensions enabled.
GitHub sign-in is handled by the editor when needed. dhimantAI does not store
GitHub credentials or publish anything when this menu is opened.
See [VS Code's repository guide](https://code.visualstudio.com/docs/sourcecontrol/repos-remotes).

## Appearance

Learning panels have no theme of their own: Course Catalog, Instructor, Doubt
Solver and Study take every colour from the app's active color theme, including
high-contrast themes. The dhimantAI desktop defaults the whole app to Light Modern;
choosing another theme changes the learning panels with it. Spacing, shape and
progress bars are shared across the panels (`src/uiTheme.ts`).

## Start with Course Catalog

**Course Catalog is the welcome page.** It opens once after installation or the
upgrade to this welcome experience. Browse course outlines, start a free first
chapter, and see course prices and bundles. Sign in or create an account to join.
Use **My courses** to return to your courses and Practice exercises in the Explorer.
If code or a learning notebook is already open, welcome waits for a later empty
window so you can continue your work.

For joined courses, **Continue** opens that course in Instructor with its chapter
and topic outline. Covered titles have a tick and strikethrough; remaining topics
show Not started or In progress. Course Catalog and the course tree also show
chapter totals. This reads the same saved Instructor progress used across sessions;
coverage means taught, while assessment and any Needs review notes remain separate.
Updated content is labelled Revisit, and unavailable progress is never shown as zero.
This needs the matching backend version; older services show Progress unavailable.

The catalog has two direct learning actions:

- **Instructor** opens its own notebook tab for guided explanations, questions,
  notes, code, and feedback.
- **Doubt Solver** opens a separate notebook tab. Type your question
  or attach a photo or PDF, then work through it with the agent.

The **Engineering Essentials** courses appear together below the other
courses. Terminal and Linux, VS Code, and Git are free; the others include a
free first chapter. They are short courses on the terminal and Linux, VS Code, Git, reading code,
debugging, testing, review, and more. Filter them by a suggested path, such as **Before a first
project**.
Challenges with one right answer run in Practice with hidden tests; the others
are written and get Instructor feedback. Both use the same **Stuck?** help steps.

The separate **Projects** section has cards for reading shelf, reading Rich,
building a Course Research Agent, and fixing a shelf repository bug. Each card
includes a description, difficulty, estimated time and learning outcomes.
Choose **Start Project** to begin that project in your course container. Time
estimates exclude initial runtime setup. Catalog search also finds projects.

Switch between the Instructor and Doubt Solver tabs while keeping each notebook's
lesson, conversation, unsent drafts, and runtime state. Clicking either action
again activates its existing tab. Close each tab independently; opening Practice
also keeps both learning tabs open. Hidden notebooks keep their sessions and mute
their speaker until visible again.

Both Instructor and Doubt Solver let you run new and restored code cells once connected,
including after reconnection. Turning AI assistance off still allows explicit code runs.
The notebook scrolls as one page: the title, course picker, and lesson list scroll
away with the lesson, leaving the full window available for explanations and code.

Click **dhimantAI** in the status bar to return to Course Catalog at any time.
The Command Palette also offers **dhimantAI: Open Course Catalog**,
**dhimantAI: Open Instructor Notebook**, and **dhimantAI: Open Doubt Solver**.
These learning actions stay available if the catalog cannot load; use
**Refresh courses & purchases** to retry. Returning launches preserve your work
without repeatedly opening the welcome page.

## Study mode (temporarily disabled on desktop)

Study is hidden from Learn, Course Catalog and the Command Palette. Saved command
links report that it is temporarily unavailable without opening the reader or
fetching its catalog. The reader implementation and its persistence tests remain
for re-enabling after course selection and reading materials are validated.
The following describes the retained implementation, not an available desktop action.

Open **Course Catalog → Study**, or choose **Study** on a joined course that has
an accessible PDF or EPUB. Only chapters with a published document appear in the
picker; Markdown-only chapters and bundled Markdown companions are excluded.
The actual file is displayed, with no Markdown fallback. EPUB uses the shared
Flutter reader engine; PDF uses the bundled PDF.js compatibility build. The
reader supports chapter selection, pagination, EPUB text size or PDF zoom, and a
locally saved position per account and document version. Books are limited to 64 MB.
Select a passage for **Explain selection**, or use **Summarize chapter**, **Quiz
chapter**, and **Ask**. Quiz feedback appears after an answer is chosen. These are
practice activities; they do not award completion or independent mastery.

The course control opens VS Code's searchable picker. **Back to book** keeps the
reading position. Summary sections can be folded, and quizzes show one question
at a time with Previous/Next, answer feedback, a practice score, review, and retry.
Study starts with a two-line composer; use its expand control for a longer draft.
Enter adds a line; only the send button sends. The arrow becomes a Stop button during a response.
Use **+** to attach photos or PDFs; the selected files accompany the question.
Written responses clear the field and attachments; failed requests
keep the draft. Unfinished drafts stay with their Study action until the chapter
changes, and **Clear draft** removes them. Text and crop references are separated
from explanations. Diagrams use a light canvas with theme-aware borders so dark
labels remain legible while preserving the authored colors.

Reading requires sign-in and the matching backend with the document catalog
endpoint. PDF/EPUB locations use the existing syllabus fields, so this change
needs no database migration. Missing or unreadable documents show an explanation
instead of falling back to Markdown. AI help is available when the chapter also
has an authorized teaching source. The first help action connects to the same LiveKit Study agent used by
Flutter. The speaker icon inside the input starts muted. Study shows
authored questions before live speech, without speech transcription or replay.
When requested, explanations include an unanswered practice question; hints and
feedback continue through the same input. Opening a chapter alone does not start a session.

## Learn to read, debug, and test code

**Get help** offers the same five actions in Practice, Instructor, and Doubt Solver:
Explain problem, Explain code, Explain errors, Explain failed tests, and Next step.
They share the notebook coaching API, selected code, current run and test evidence,
and inline replies. Problem help also works before adding code. Help does not
submit an answer to Instructor or award progress. Private notes stay private.

Release the matching coaching backend before extension 0.36.5. From the repository
root, run `bash deploy/deploy.sh staging check-notebook-help` against the target
service before publishing the VSIX. This read-only check validates all five request
shapes without calling a model. Older servers reject `notebook_context`; updating
the extension alone does not fix that deployment mismatch.

Practice includes beginner explanations of debugging, unit tests, and functional
tests. Ask the agent to help read unfamiliar code, understand requirements, plan
a solution, write test cases, or interpret a failing test. Run and test your code
inside VS Code, using the runtime you selected.

Notebook debugging opens VS Code's real debugger when a supported adapter and
runtime are available. Pause at a breakpoint, inspect variables and the call
stack, then choose **Discuss paused state** to share that captured state with the
agent. The agent uses that evidence to guide your next step. Passing examples
and assisted work do not by themselves establish independent mastery.

## Notebooks and runtimes

The shared learning notebook is the default for Practice, Instructor lessons and Doubt Solver.
Native Jupyter remains an explicit option under **DhimantAI: Practice Editor**. Open a lesson or exercise
from **DhimantAI Practice** in the left Explorer, or choose **dhimantAI: New Course
Notebook**. The extension prepares the course container. Setup verifies a small
program before reporting ready. The terminal stays closed unless you open it.

Use the notebook's single **Runtime** dropdown for **Course container**,
**Open course terminal**, and **Set up / rebuild course**. Notes,
code, feedback, and questions stay in the notebook; a separate assistant panel does not
open automatically. Use the separate **Ask Instructor** / **Answer Instructor** message bar below the learning
notebook. The input starts at two lines and can be expanded or collapsed without losing the draft.
Enter adds a new line; only the send button sends. The message bar scrolls with the
page and has no Run action or cell number. Native Jupyter notebooks still use their
Ask Instructor popup; they do not yet have this message bar. The **⋯** menu holds save, open, restart, and observation options.
Return to Course Catalog with the **dhimantAI** status-bar entry for courses,
signup, sign-in, and purchases.

Practice notebook headings and editor tabs use the question label selected in the
Explorer. Existing saved Practice notebooks pick up the current label when reopened,
preserving your notes and code.

In a native Practice `.ipynb`, **Ask Instructor** saves your full question as a **You**
cell immediately, then adds the reply or failure notice directly below it. Earlier
exchanges remain in order when you select, edit or run other cells. They are saved
in that notebook on this computer and remain readable when you reopen it.
**Ask about This Notebook** and its keyboard shortcut use the same notebook interaction
for all native notebooks; they do not open a right-side assistant panel. Model follow-up context is limited to recent
messages for the selected code cell during the open session; earlier code/run
versions are labelled historical, and private notes are excluded.

Practice uses the Flutter app's **Practice AI tutor** flow: **Explain problem**,
**Explain code**, **Explain errors**, **Explain failed tests**, and **Next step**.
Explain code starts at the selected line. The latest reply offers up to three
contextual follow-ups and **Go to line** when a line is relevant. Editing code or
inputs, rerunning, or restarting the runtime retires earlier follow-ups. Failed-test
help uses the current sample's input, expected value, actual result and error; it
asks for fresh tests when the evidence is missing or belongs to an earlier draft.

Conversation cards stay expanded across replies, cell changes and notebook reopening.
Collapse and delete controls are available when the learner chooses to use them.
**Clear conversation** keeps the question, code, private notes and assistance history.
Instructor controls pause while a response is loading. In the Practice panel, the speaker
opts into spoken explanations of replies, with pause, resume and replay. It starts
off and stops when the tab is hidden. Live Instructor lessons retain their teaching audio.
Guided strategies and contextual reply suggestions require the matching worker update.

For a standalone `.ipynb`, **Ask about This Notebook** adds the question and
Instructor reply directly to the notebook. Linked Doubt Solver notebooks use Doubt
Solver instead. The notebook's **Select Kernel** control selects the runtime.
The **dhimantAI Practice** kernel uses the course container, including
for notebooks outside the course folder: select the matching course when asked.
Google Colab remains available through its extension for supported Python notebooks.
Course source files use **Run code** in the course terminal.

## Course runtimes

First setup takes several minutes, depending on downloads and computer speed.
The progress notification shows each setup stage; **Output → dhimantAI** shows
the build details. Start setup before running code with **Set up / rebuild course**
in the existing runtime dropdown. Later runs reuse the prepared runtime.

Opening a course notebook prepares its workstation automatically. Choose **Set up / rebuild course** in the runtime dropdown to rebuild it. DhimantAI writes the course **Dockerfile** and dependencies, downloads and verifies the official Podman installer when needed, starts the local Podman machine, builds the container, checks package imports and dependency compatibility, and executes a small program in the course language. Follow operating-system installation prompts; first setup needs internet access. A failed startup triggers one automatic repair: rebuild the course recipe, recreate its owned container, verify it and retry the waiting run. Course files and the saved notebook remain on disk. If repair also fails, the error remains visible with **Retry setup** and **Show setup log**; execution never falls back to this computer. Browsing the catalog or editing a source file does not start an installation. The first course source-file run prepares the container if needed; setup failures never silently switch to host tools.

**Resources.** A Podman machine created by dhimantAI (macOS and Windows) is kept small: 2 CPUs, 2 GB of memory and a 30 GB disk image that only uses what it stores. An existing Podman machine is used as it is and never resized. Each course container is capped at 1.5 GB of memory (3 GB for PyTorch courses) and 1,024 processes, so a runaway program cannot take over the computer. When VS Code closes, course containers stop, and a Podman machine that dhimantAI started stops too when nothing else runs in it. The next run starts them again.

**Open Course Runtime** also opens a local notebook and selects the **dhimantAI Course · Podman** kernel. Python opens a starter notebook. **Build an LLM from Scratch** opens the first of seven authored labs with CPU PyTorch and NumPy installed. The left Explorer view continues to show your Practice courses and exercises. Course files live under the **dhimantai.exercisesFolder** setting (by default, `~/dhimantAI/courses`). Your saved edits survive a rebuild.

Use **dhimantAI: Open Course Dockerfile** to inspect or edit the recipe for the active course. Add Python dependencies to the adjacent `requirements.txt`, then choose **Open Course Runtime** again to rebuild. The extension supplies a Python baseline for courses without a dependency profile and installs supported language tools when an exercise needs them. **dhimantAI: Open Course Terminal** opens the terminal described below. Use a trusted local VS Code window.

### Course terminal

Choose **Runtime → Open course terminal**, or **Terminal → New Terminal** in a course/project workspace. The default profile is **dhimantAI Course Container** on Windows, macOS and Linux. Choose a course when none is active. The extension prepares or starts its container and attaches directly with `podman exec -it`; no SSH server, keys or port setup is needed. The default shell is **zsh with [Oh My Zsh](https://github.com/ohmyzsh/ohmyzsh)** and the Git plugin, with a clear `/course $` prompt. The framework is pinned in the extension’s shell recipe and automatic framework updates are disabled. Course source-file runs reuse this terminal and return to its prompt when finished. A busy terminal asks you to finish its current command before running another program.

Commands run inside the container in `/course`, the course folder saved on your computer. The course language brings its toolchain: Python/pip, JavaScript or TypeScript/npm, Java/Maven, C/Make/CMake, Go, or Rust/Cargo. Bash and Zsh cells can install dependencies, build projects, run tests and start programs using the same tools. `sudo` applies inside this learner-owned container; for example, `sudo apt-get install <package>` installs a Linux tool and `sudo python -m pip install <package>` makes a Python library available to the course kernel. Use project manifests and normal build/run commands in a shell cell for projects with multiple files.

`$HOME` is `/course/.home`: shell history, `.zshrc`, custom plugins and home-directory tools persist across container rebuilds. Existing `.zshrc` edits are preserved. Keep project dependency manifests and lockfiles under `/course`. System-wide installs survive a container restart but must be recorded in the Dockerfile or requirements to survive a rebuild. The course Dockerfile remains editable.

**Java Programming** selects the Java runtime. Its original 24-chapter course
uses Java 17, complete `Main` programs in notebook cells, and a packaged project
in the course terminal. No textbook is required. Find available courses with
**Open Course Catalog**; catalog
availability follows the selected DhimantAI environment.

**Windows setup.** For the WSL 2 setup, use 64-bit Windows 10 build 19043 or later, or Windows 11, with virtualization enabled. Follow the installer’s WSL 2 and restart prompts. If automatic installation is unavailable, complete Podman Desktop’s onboarding, including the engine and machine. Restart VS Code and choose **Runtime → Set up / rebuild course**, then **Open course terminal**. [Official Windows installation guide](https://podman-desktop.io/docs/installation/windows-install)

## Colab TPU in VS Code

For **Build an LLM from Scratch**, right-click the course in **DhimantAI Practice**
and choose **Open Course with Colab Runtime**. This requires VS Code 1.101 or later and offers
to install Google's official **Colab** extension (`google.colab`, with Microsoft
Jupyter). Podman is not required. It works with **courseContainers** turned off.

Start with **00-colab-tpu**, then select **Colab → New Colab Server → TPU** in the
kernel picker (choose **Select Another Kernel** first if needed). Sign in with
your Google account when Colab prompts. Run the setup cell and check for **TPU
verified**. Choose **Open Course with Colab Runtime** again to open any of the seven labs.
Each notebook needs its own kernel selection and setup after a restart.

Colab copies live in the course's `colab/` directory and preserve existing edits.
They use the current Colab image's TorchTPU backend, verify a computation on a TPU,
and create lesson tensors and model parameters on that device. A missing or
unusable TPU stops setup; it does not fall back to CPU. These are small teaching
examples using one device, not multi-device training or a speed benchmark. Local
CPU notebooks remain in `notebooks/`. Do not install their CPU PyTorch requirements
on the Colab kernel.

For another local Python notebook, choose **Use Colab Kernel** in its toolbar.
This selects the connection without changing your code: move model parameters
and tensors to the appropriate device yourself. Google manages runtime
availability, quotas and usage. Local datasets need an explicit **Upload to
Colab**; save remote checkpoints to Drive or download them before **Colab: Remove
Server**. Notebook edits stay local, and coding questions use Instructor or Doubt Solver in VS Code. [Official Colab guide](https://github.com/googlecolab/colab-vscode/wiki/User-Guide)
· [TorchTPU setup](https://torchtpu.readthedocs.io/en/latest/get_started_on_a_vm/)

## Instructor lessons and Doubt Solver

Choose **Instructor** in Course Catalog, select the book icon in **DhimantAI Practice**,
or run **dhimantAI: Open Instructor Notebook**. Instructor always opens the lesson list.
Choose your course or subject, then an available lesson; only then does Instructor
connect and start teaching that lesson. Locked lessons remain visible but cannot
be started. If courses cannot load, retry or open Course Catalog.
Choose **Doubt Solver** in Course Catalog or **dhimantAI: Open Doubt Solver**
to start with a specific question. The notebook’s **⋯** menu switches between them.
Doubt Solver has its own conversation. Each Instructor lesson also has its own saved
conversation, code and drafts; changing modes or lessons restores the selected
document and clears live runtime state. Documents remain isolated by account and
environment. Older mixed Instructor/Doubt notebooks stay on disk and are not loaded
automatically into either mode. Learn in one editor:
explanations, questions, your notes, editable code, run output, feedback, and lesson
recaps stay together. **Ask Instructor** and **Review with Instructor** continue this same
lesson. No separate assistant panel opens, including for standalone native notebooks.

Use **＋ Note** for a private note: an explanation, prediction or reflection just
for you. Notes are saved on this computer and never sent to Instructor or Doubt Solver, including
when code observation is enabled. To discuss one, select **Share with Instructor** on that note.
The learning notebook's separate message bar is labelled **Ask Instructor** or
**Your answer to Instructor**, with the current question shown when answering. **Ask Instructor**
and **Answer Instructor** send messages; **Run** executes code in the selected runtime.
The **＋** button attaches photos/PDFs with previews and removal before sending.
Speaker/output and the visibly disabled microphone sit beside the message action.
Voice input is not supported by the receive-only session.

Instructor automatically receives bounded, temporary context from the active learning
notebook: public lesson/conversation cells, code and current reported runs. Private
notes, unsent message drafts and unrelated files are excluded. Hidden tabs stop
sharing; each snapshot replaces earlier context, and edited code loses its old run
evidence. This synchronizes context without generating a model reply. Explicit
questions and help actions use the existing response path; automatic hints remain off.
Practice includes the same public context with each requested response.
The interface has no sharing banner or extra confirmation step.

Practice accepts up to four photos or PDFs (2 MB each, 2.75 MB in total) with a question.
The native notebook popup retains its paperclip attachment action; the learning
notebook uses **＋**. The service transcribes attachments for Instructor. Native `.ipynb`
questions continue to use written replies; the new message bar and audio are in the
learning notebook interface, not an added runnable Jupyter cell.

Use **＋ Code**
to add Python, JavaScript, TypeScript, C, Java, Go, Rust, Bash, Zsh, SQL, or PostgreSQL lab cells. Language-tagged
examples from Instructor are editable too. **Run** executes only when you request it,
using the course container.
Python cells share executed definitions until **Restart runtime**, closing the
notebook, or an account change. JavaScript, TypeScript, C, Java, Go and Rust run complete programs
per embedded cell. Include the definitions each such program needs. Execution uses the
extension's language tools, independently of a native Jupyter kernel selection.

Cells share a local notebook folder. Start a cell with `%%writefile src/helper.py`
followed by its contents to create a project file; use Bash or Zsh cells for builds,
package installation and project tests. Shell cells retain their working directory
and exported variables; shell-local functions and aliases belong in a script that
you source. **Program input** holds arguments, text input and uploaded text/code
files. **Notebook files…** opens these files for editing. Re-uploading revised
content updates an input file; rerunning unchanged input preserves edits made by cells.
Restarting clears variables and databases while retaining files on this computer.

Output streams while a cell runs. **Stop** interrupts execution. With **Accept input
while running** enabled, use **Send input** or **End input** below the running cell;
turn it off when a program should read supplied stdin through EOF. Native notebook
cells offer **Input** while running and prompt for Python `input()`. Python displays
support tables, HTML and inline plots. Embedded HTML is sandboxed without scripts.

SQL cells share their database until the runtime restarts. PostgreSQL lab cells run
as the lab database administrator, with `psql`, `pg_ctl`, backup and restore tools;
SQL and shell cells in that lab use the same database. Sample tests and grading
continue to create fresh environments, independently of exploratory notebook state.

PostgreSQL's generated template stays on the container filesystem under
`/tmp/dhimantai-postgres-<uid>/template`, avoiding ownership and permission limitations
of host-mounted course folders. Image-provided templates and explicit
`DHIMANTAI_PG_TEMPLATE` overrides are still supported. Failed startup attempts clean
up their temporary clusters and return an actionable `PG_*` error without internal
paths or a Python traceback. Support can inspect the last bounded diagnostic in
`/tmp/dhimantai-postgres-<uid>/startup.log` inside the container. A new explicit Run
retries initialization; no background retry loop runs. SQL predictions are labeled
as unexecuted, and only successful runs display the executed-output heading.

Published course images contain these helpers. Rebuild and publish the matching
SQL/DBA runtime releases as well as the extension for installed clients to receive
the fix; an extension-only update does not replace helpers in a published image.

**Tab** accepts the selected completion; in the embedded editor it also requests
suggestions after a word and indents on a blank line. **Ctrl+Space** requests suggestions.
Cells forward completion requests to installed VS Code language extensions.
The extension pack includes [Bash IDE](https://github.com/bash-lsp/bash-language-server/blob/main/vscode-client/README.md)
for Bash and common shell syntax; Zsh cells also use common shell and notebook-file
suggestions, without promising Zsh-specific language analysis. Native notebooks use
[VS Code Tab completion](https://code.visualstudio.com/docs/editing/intellisense#_tab-completion),
respecting your editor settings. Completion never executes the typed command.

**Review with Instructor** asks for a prediction, runs your current code, and discusses
that result with Instructor. Press again to skip the prediction. **Ask Instructor** shares
the selected source and any current run. Editing invalidates earlier run evidence;
earlier output remains visibly marked. Neither action submits an answer or awards
mastery. The message bar’s **Answer Instructor**, or a task’s **Submit to Instructor**, sends an answer to the
active question. Assisted textbook attempts retain their assistance provenance.

Select **Ask for a video** to request a lesson from the DhimantAI catalog. Videos are embedded inside the learning room. **Pause and ask** pauses the player and focuses the question box; sending a question also waits for the player's pause and the Instructor's timestamp acknowledgement. **Resume video** resumes explicitly. If embedded playback fails, **Retry inline video** reloads the player and you can continue asking questions here. The extension does not open an external YouTube page.

Notes, source edits, predictions, and written lesson content autosave on this
computer, separately for each account and service. Hiding the notebook preserves
the session. Reopening restores the document, but starts a fresh lesson session;
old question cards do not regain submission authority. Runs and outputs are
temporary. In **⋯**, **Save a copy** exports an `.ipynb`; **Open saved notebook** restores a copy
created here. Mixed-language exports retain each cell's language; an external
Jupyter environment needs appropriate kernels to execute them.

In **⋯**, **Let Instructor follow code edits and runs** controls automatic notebook context. It is on by default. **Offer hints when I’m stuck** is optional and off by default. Turn off
observation to pause background sharing; explicit help still shares the selected
cell. The **AI Assistance** setting disables code help and observation while
leaving Run available. Voice, videos, and **Ask a doubt** use this same surface.
Switching Instructor/Doubt Solver creates a fresh live session while keeping the notes.

Instructor help and checkpoint-bound answers require the matching agent worker update.
Live observation requires its `on_editor_activity` RPC. Practice notebook history
requires the matching API update. Installing the VSIX alone does not update either
service. Local execution is not a verified assessment.

## Practice in VS Code

Choose **Open Course Catalog** in the Command Palette or the Practice
Explorer header. You can search courses and preview their level, prerequisites
and published lesson outline before creating an account.

Choose **Sign up** to open the account-creation page in VS Code. Enter your
name, email, password and password confirmation together in the form. Choose
**Sign in** to open the email-and-password page, or switch between the two pages
using the link below the form. Authentication does not use Command Palette prompts.
If email confirmation is required, follow the email link and return to sign in.
Errors appear in the form so you can correct them and retry.

Once signed in, select **Join course** in the catalog. Joined courses appear in
**DhimantAI Practice**. Opening a preview or creating an account does not automatically
enroll you. Account pages and the catalog use the selected **Dhimantai: Environment**.

Open **Explorer → DhimantAI Practice** and sign in with your learner account.
Expand a course and chapter. **Textbook Questions** and **Institution Questions**
contain the published coding exercises, grouped by topic.

### One real notebook per task

Selecting a coding question opens one real Jupyter notebook (`.ipynb`) in VS Code's
own notebook editor, saved in the exercise's course folder (or this computer's
extension storage without course containers). Everything for the task is in that
notebook: the task, your code cell, an **I expect it to print** cell, and below
them every Instructor reply and the latest sample-test results, as cells. Reopening the
task reopens your file; it is never replaced.

- **Editing** comes from the official extensions installed with dhimantAI:
  Pylance for Python (in the cells directly) and rust-analyzer, Go, Java,
  C/C++ and TypeScript for the other languages. For those, dhimantAI keeps a
  hidden mirror file of your program (all code cells, in order) in a
  `.dhimantai/` folder beside the notebook, so their errors, completions, hover,
  signature help and Go to Definition appear in your cells. The mirror needs the
  language's toolchain on this computer for full analysis.
- **Running** uses the **dhimantAI Practice** kernel. Python, shell and SQL cells
  execute individually with shared notebook state. Other supported languages join
  preceding cells of the same language into one program. Course notebooks use the
  course container. The first Run waits for setup and any automatic startup repair
  (Podman, its machine and the course image; your computer may ask for
  approval), then runs the same cell without a second click. This keeps state in the selected runtime.
  Supported Python notebooks can also use the Colab kernel.
  The **Run with** cell under your code holds the program's arguments (split
  like a terminal command) and typed input. **More → Run with arguments or input** fills
  it from a sample test or lets you write your own; the task's sample files sit
  beside the program.
- **Help** stays next to your code: **Check samples**, **Ask Instructor**, and **More**.
  VS Code's Run button executes the cell in the selected runtime. **More** holds
  hints, predictions, run arguments/input and optional **Review my code**.
  Questions and feedback stay in the notebook. There is no required submission step.

Set **dhimantai.practiceEditor** to `panel` to use the earlier Practice panel instead.

### The Practice panel (earlier editor)

With `panel`, selecting a question opens its **Practice notebook** with the question and one editable solution cell.
Practice is ready automatically, with no Connect or End session controls. Closing
either notebook ends its session; a failed connection offers an explicit Retry.
Each solution cell keeps **Run** and **Run sample tests** in view. **More** holds predictions, investigations and **Review my code**. Practice asks
Instructor in one place, the box under the task. When you are stuck, **one help button climbs a
ladder**: a guiding question, then a hint, then where to look, then a worked example on a
different problem. Each step unlocks only after you try the last one and run your code again; once
every sample passes, the next stuck moment starts with a question again. The service enforces
the same order with a signed token, and it checks every Instructor reply: a reply that writes your
solution code is rewritten, and if it still contains code, a question is sent instead
(`agent/course_projects/answer_guard.py`). The five explanation actions (Explain problem, code,
errors, failed tests, Next step) are under **More ways to ask**. Beside the help button,
**Last 5 solved: N without help** shows the measure that matters, your independence over
time. It is kept on this computer per account, and **dhimantAI: Export My Practice Record**
saves it as counts and times only, with no code or conversation
(`docs/vscode-five-student-study.md`).

**Run sample tests** runs the published samples on your code and shows each expected and
actual output. **Step through** (Python) shows each line as it runs, with its values and
what has been printed so far. After the samples pass, **Try a new input** gives you fresh
input: predict exactly what your program prints, then Run, with no help during the attempt.
These tools run your code; they never ask Instructor. Add notes and
experiments in any of the seven supported languages. Task feedback uses the
exercise's language and selected source. Opening and editing work without Podman;
execution prepares and uses the course container. Setup must succeed before code or tests can run.

Open **Engineering skills** below a code cell. Its selector explains each skill in
plain language and gives one first exercise, even with AI off. **Practise this skill
with Instructor** starts guided practice; requirements work can begin before any code is
written. Instructor introduces unfamiliar terms, uses a small example, asks for a
prediction or explanation, then discusses evidence from the learner's work. Current
Practice follow-ups keep the selected skill without repeating the introduction.

The progression covers understanding requirements, problem decomposition and data
structures, reading unfamiliar code, debugging, unit and functional testing,
refactoring and code review, Git collaboration, documentation and checking AI
suggestions, security/reliability, and performance measurement. It targets sound
decisions and reliable changes; it does not promise a productivity multiplier or
award mastery for using a tool. The scope is informed by
[SWEBOK's engineering knowledge areas](https://www.computer.org/education/bodies-of-knowledge/software-engineering/topics),
[Google's code review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
and [OWASP's secure code review guidance](https://owasp.github.io/DevSecOpsGuideline/2-Process/2-2-Develop/2-2-3-Secure-Code-Review/).

**Debugging** finds why actual behavior differs from expected behavior. **Testing**
checks behavior against an explicit expectation. For example, a test can detect that
doubling 2 returned 5 instead of 4; debugging investigates the cause. Definitions of
breakpoints, stepping, assertions and test types appear beside the relevant tools.

Open **Debugging and test tools** within Engineering skills to record the expected behavior,
one hypothesis, and an experiment that could disprove it. Use **Run** or Python's
**Step through** to gather evidence, then **Discuss my investigation** for a focused
hint. After a fix, rerun the failing input and keep it as a regression case.

In an Instructor or Practice code cell, **Add a test case** lets you write up to six cases with
standard input, your expected output, and the requirement or bug each case checks.
Choose typical, boundary, or regression cases; use invalid inputs only when the task
defines their behavior. **Run my tests** runs this cell as a complete program for each
case, using the selected runtime. Include its definitions and print the result.
Blank input and expected output are allowed; comparisons ignore trailing whitespace.
**Discuss this case** asks Instructor to help evaluate the case and its expectation.
Use **Use this input in Run** to reproduce a case with Run or Step through and discuss
that current execution in your investigation.

Investigation notes and test cases save locally with the notebook. Results are temporary
and clear when code, cases, or runtime change. Running these cases works with AI off;
Discuss actions require AI assistance and retain assistance provenance. A match checks
your expectation, which may itself need correcting; it is not a verified grade or proof
of mastery. In a native linked notebook, use **Ask about This Notebook** to ask
Instructor to investigate a bug or help design tests. Guided coaching stages require the matching API and
Instructor worker update; custom test execution works locally with the extension.

**Help me read this code** teaches how to approach unfamiliar code: identify its
purpose and entry point, follow one input through calls and branches, notice side
effects, predict behavior and explain it back. Only the selected cell is shared;
Instructor asks for missing callees instead of assuming it has read the entire project.
In native files, use VS Code's Go to Definition and Find All References to explore.

**Help me write a unit test** starts with one function's contract and teaches arrange,
act and assert. Instructor can help with one small test scaffold, while leaving the
solution and expected-result reasoning to the learner. Put the definitions, tests
and runner in a separate, complete code cell and select **Run test code** there.
It runs that cell in a fresh process in the selected runtime, showing stdout,
diagnostics and exit status. It does not use another cell's Python memory. For
example, a Python `unittest` script must call its runner; simply declaring a pytest
test function does not execute it. Read the actual test count and failure summary;
a clean exit is not a test-pass verdict. [Python unittest guide](https://docs.python.org/3/library/unittest.html)
and [Node test runner](https://nodejs.org/api/test.html) explain their runner conventions.

**Help me write a functional test** starts from observable behavior and guides the
learner through a requirement, input, expected output and **Run my tests**. These
stdin/output cases exercise the cell as a complete program. They do not exercise
a browser or a multi-service application. **Discuss this case** includes a bounded
current result, when available. Editing the code, case or runtime clears it.
Both test runners work with AI off. Test-authoring help and code-reading guidance
require the matching API/Instructor worker update and retain assistance provenance.

### Native debugging from a cell

Choose **Help me start debugging** for step-by-step guidance, then **Debug in VS Code**.
The extension copies this cell and its standard input into a separate debug folder
and starts a real language debugger through VS Code. It adds a starter breakpoint
and opens the file beside the notebook. The cell must be a complete program;
other cells and the shared Python kernel are not included. Existing `launch.json`
files and unrelated debug sessions are left alone.

Set a breakpoint before a suspected change, predict a variable's next value, use
**Step Over**, and compare **Variables**. Use **Step Into** and **Call Stack** to follow
a call; add Watch expressions yourself. **Discuss paused state** explicitly shares
the captured line, up to eight stack frames and twelve bounded local values with
Instructor or Doubt Solver. It does not continuously share debugger state, collect Watch results
or evaluate expressions. Stepping, resuming, changing values or editing invalidates
the observation. This context is temporary help, never a completed run or assessment.

After **Stop debugger**, **Bring changes back** copies your edited debug file into
the original cell. If the notebook changed meanwhile, automatic import is rejected
so both versions are preserved. Run the failing test and relevant regression cases
again. Source copies stay on your computer. Raw debugger snapshots are not saved in
notebooks; written Instructor feedback follows the notebook's normal local autosave.

The course container supplies language tools and debugpy. VS Code supplies debugger
adapters: Python Debugger, the built-in JavaScript debugger, Debugger for Java,
Go, and C/C++. Missing adapters must be installed/enabled before retrying.
Native debugging works with AI off; **Discuss paused state** requires AI assistance
and the matching worker/API update. The older Python **Step through** remains a
recorded trace, separately from this live debugger.

**Review my code** is optional Instructor feedback, available under **More**. It sends
your code and explanation to the AI service just like asking a question. Feedback appears beside your attempt in the notebook. The saved
attempt retains whether help was used. This is source feedback, not a graded
server submission or independent mastery. Drafts, output and conversation history
are not uploaded for durable storage. Each published task reopens its own local
notebook; saved copies can only be imported into their matching Practice task.

Choose **Generate an exercise…** under a chapter for fresh practice. Pick any
supported language, difficulty, and optional focus. The generated problem opens
in the same notebook with an empty solution cell. **Saved Practice Notebooks**
(the history icon in the Practice view or the command palette) reopens generated
and published exercises, including locally saved code and Instructor conversations,
for the current account and environment. **Save a copy** also exports a portable
notebook. Generated exercises are not published to the question bank. History can
recover earlier interactive Practice notebooks still present in local extension
storage; it cannot recover deleted files or unsaved standalone notebooks.

New generated tasks explicitly read standard input and print standard output.
Before opening one, the service independently reviews the input contract, derives
a private reference program without seeing the proposed expected output, and runs
it through the restricted execution service. A mismatch, invalid contract, failed
run or unavailable validator stops generation. Only validated generated samples
become runnable tests; older services must be updated before generating new tasks.
Previously saved notebooks can still be reopened without inventing tests for them.
When no runnable samples exist, the notebook explains this and offers Run and My
tests. Matching a sample is not a complete grade or proof of independent mastery.

Instructor checks for contradictory exercise answers before reviewing learner code,
uses bounded arithmetic and self-contained Python assignment traces as supporting
evidence, and gives the latest run precedence over earlier errors. Explicit false
numeric equalities in a reply receive one repair attempt; persistent failures are
withheld. The model still interprets the task's semantics, so these checks reduce
content errors without certifying every generated problem as correct.

These content checks need the matching API update and its configured
`PROGRAM_EDITOR_SSH_CONFIG` restricted runner (see
`deploy/project-worker/README.md` in the source checkout).
Generated reference programs are temporary; learner runs stay on the selected
course container. Failed learner runs are labelled **Run failed**.

## Course projects with Coach

At the final milestone, **Submit Project** runs the full checker in your course container
and saves the result, source digest, commit details and assistance on this computer.
Course Catalog and **My courses** show local completion, failed checks and changes since
submission. Reading projects require a checkpoint explanation and remain labelled as
self-reported reading completion. Passing public checks is not a grade or proof of mastery.

Use **Project actions → View saved results** for the latest 20 attempts. **Publish to
GitHub** and **Create pull request** are optional: commit and review your work first,
then choose the destination in VS Code. Publishing includes Git history. The existing
teacher-review handoff remains separate from local completion and GitHub sharing.

After preparing a project, dhimantAI shows its name and saved folder before opening
it. Choose **Open in New Window** to keep your original workspace open, or **Open in
Current Window** to replace it. Cancel leaves the saved project available to reopen.
The project name appears in the workspace window title and Explorer. The workspace
file is stored in extension storage, outside the project's source repository.

**dhimantAI: Start a Course Project** includes two code-reading routes for
**Read an Unfamiliar Codebase**: **Rich**, a complete pinned upstream Python source
snapshot, and **shelf**, a smaller guided introduction. Start at either scale.
Coach teaches repository mapping, Quick Open, symbol search, call/data tracing,
output prediction and reading tests. Rich has ten steps; shelf has seven.
The course card's **Read a project** action opens the same chooser.

Rich v14.3.4 retains its original source, docs, tests and MIT license. Course examples
live separately in `reading/`. Its first explicit setup run installs pinned packages
inside the container; later examples and focused tests need no API key or network.
Long-file links jump to relevant symbols, and questions share bounded excerpts around
the cursor with their actual line numbers. The source snapshot does not include upstream
Git history. A successful example run does not assess the student's understanding.

**dhimantAI: Start a Course Project → Build a Course Research Agent** creates an
independent Python repository. Ten milestones guide the learner through search,
document reading, validated tool dispatch, the agent loop, quotation evidence,
failure handling, testing, live-model comparison and handoff. The existing Coach
opens in the right panel; **Open Project Coach** resumes it when needed.

Each step links relevant files and runs public checks in the managed course container.
When a check fails, Coach shows the first captured Python cause and affected project
file/line above **Show check output**. Long output keeps a bounded traceback excerpt
and the ending test result. Summaries work with AI assistance off; unrecognized errors
remain available in the output. Results from changed files stay labelled **Earlier files**.
Runtime setup and **Open course terminal** stay in the runtime dropdown. The default
terminal profile in course/project folders is **dhimantAI Course Container**.
The terminal supplies the same Python and Git commands on Windows, macOS and Linux. New projects
are created inside the managed course folder. There is no host Python option or fallback.
The container supplies Python 3.10+. Implementation tasks are intentionally unfinished.
Setup checks pass immediately; the learner builds the functions needed by later checks.

Questions explicitly share bounded public file excerpts and current check output.
Edits invalidate earlier evidence. Local checkpoints keep notes, the current step and
assistance counts; chat and outputs are temporary. These are learning aids, not official
grades or submissions. Scripted scenarios test orchestration; a separate live milestone
uses the provided DeepSeek adapter and the learner's runtime credentials.

Project chat in extension 0.38.0 requires the matching `/notebook-coach/project` backend.
The authored flow and validation boundaries are documented in the repository at
`docs/course-project-coach.md`.

## Capstone: fix a real bug in a real repository

**dhimantAI: Start a Course Project → Fix a real repository bug** clones a small Python project, *shelf*, with a
teammate's seven-commit history and a user's bug report (issue #12). You read the code,
reproduce the bug, write a test that fails because of it, find the commit that caused it
(`git log -p` or `git bisect`), fix it on a branch, commit with `#12`, and write `PR.md`
(Cause, Fix, Test). Open **dhimantAI: Open Course Terminal**, run
`cd /course/shelf-capstone`, then `python check.py`. The judge runs in the container: it also restores the
old `search.py` to confirm your test really catches the bug. The container supplies
Git and Python 3.10+. Use `python -m unittest discover -s tests -t .` there to run tests.
The same commands apply on Windows, macOS and Linux. The repository is built reproducibly by `scripts/capstone/build_shelf.py` into
`media/capstone/shelf.bundle`; a unit test fails if the two drift apart.

Coach supports this fourth project as well as both reading projects and the Course
Research Agent. Its seven milestones follow the capstone workflow, including Git,
regression tests, debugging and the PR note. Existing Shelf clones open without a
migration or changes to learner files. Coach shares bounded public excerpts,
learner-added Python tests, current check/checkpoint state and a visible Git summary.
Git changes invalidate earlier capstone check evidence. Run checks and `check.py`
in the managed course container through the existing Coach controls. This support
requires the matching backend schema accepting the `shelf` project and Git context.

## Notebook workflow

1. Open a course or Practice notebook inside VS Code. For an existing export,
   choose **Download for VS Code** in the app and open the `.ipynb` in VS Code.
2. Select **dhimantAI Practice** and choose the course container when asked.
   Supported Python notebooks can also use Colab through Google's VS Code extension.
3. Write, run, and save your notebook in VS Code. A Colab kernel executes your
   cells remotely; it does not move editing to the Colab website.
4. Return to the Practice question and choose **Attach work for feedback**.
   Explain your approach and report any help used. **Review my work** shares
   source for live feedback only. Notebook outputs and execution metadata are
   removed. Instructor conversations can also discuss work you explicitly share.

From Instructor, download the notebook with the selected question and code, then choose **Open in VS Code**. The link identifies this local export. If the notebook was renamed or saved outside Downloads, VS Code asks you to select it. VS Code confirms after the notebook opens. You can also use **File → Open File**.

For a downloaded notebook, select **dhimantAI Practice** to use the course container and choose its course when asked. **Open Copy in Course** can also copy it to that course folder. Use VS Code notebook output settings to wrap wide output.

To check a prediction in Practice, save it in the notebook prediction cell before choosing **Run Cell**. The notebook compares it locally with the selected cell’s text output. Asking about that run shares a bounded text excerpt for the reply. After you attach and submit your work in Practice, **Exercise summary** shows the source review and a next practice step.

Predict every output line in order, including printed labels. Use Enter between
lines in the notebook prediction field, Shift+Enter in the notebook chat, or `\n` in
the Run prediction popup. Feedback distinguishes an omitted prediction from a
wrong value or an extra predicted line. A successful run, a matching prediction,
and passing published samples are separate observations; none establishes
overall correctness or independent mastery. When no samples are published,
check your own examples against the question requirements.

Formatting feedback recognizes equivalent single numbers (such as `2` and `2.0`)
and omitted numeric labels. Changed words, signs, container types, and distinct
large numbers remain differences. An extra blank output line also counts as a
line; the final newline alone is optional.

## Coding help is part of Instructor and Doubt Solver

Instructor teaches the lesson and helps with its code in the same conversation.
Doubt Solver answers conceptual and coding questions in its own conversation.
Practice uses Instructor for task explanations, debugging, hints and review. There is
no separate Instructor mode or assistant to switch to.

In a Practice `.ipynb`, **Ask Instructor** records the full prompt before requesting
help, then places the reply or failure notice below that prompt. These cells stay
in the saved notebook. Switching cells changes the code context for the next
question; it does not replace earlier exchanges. Follow-up requests include up to
eight recent messages for the selected code cell, with earlier code/run versions
marked as historical. Private notes are excluded from that history.

**Ask about This Notebook** uses this inline conversation for ordinary and linked
`.ipynb` files too. A linked Doubt Solver notebook retains its Doubt Solver context.
There is no separate assistant panel. Saved question/reply cells remain readable
after reopening the file; model follow-up context is temporary for the open session.

Explanations support headings, lists, code, tables and safe SVG diagrams. Quoted
source, output and errors remain literal. The learner writes the correction;
matching one sample does not establish overall correctness or mastery.

Copilot is disabled by default through `chat.disableAIFeatures`. In the custom
desktop, the active course permits it only when explicitly listed in
`src/courseCopilot.ts` as teaching AI-assisted coding (currently **Use AI Coding
Help with Verification**). Other courses, the catalog and unrelated editors keep
it disabled. Instructor and Doubt Solver remain available. The course switch is
local to the editor window and does not overwrite user or workspace preferences.
An optional compatible Copilot Chat installation and its own sign-in are separate.
Stock VS Code keeps the contributed default and respects explicit user settings.
Older versions wrote `chat.disableAIFeatures: true` into user/workspace settings;
those saved preferences are preserved, but no longer forcibly rewritten.
This is a learning-interface policy, not proof of independent assessment work.

## Session refresh and connection failures

When an authenticated action finds fewer than 60 seconds left on the access
token, the extension refreshes it. Temporary network failures, timeouts, rate
limits and server errors get up to three attempts, with one- and two-second
delays and a 30-second deadline per request. Concurrent actions share the refresh.
If refresh still fails, your sign-in stays saved: reconnect and retry the action.
An explicitly rejected or revoked session still requires signing in again.
**Output → dhimantAI** records the UTC time, attempt and failure category without
tokens, response bodies or personal data. Signing out deliberately clears the
saved session even when offline.

Developer check: `npm run compile && node out/test/integration/runTest.js suiteAuthRefresh`
exercises offline recovery, bounded retries, redacted diagnostics, revocation,
concurrent requests, sign-out races and service changes in a real VS Code host
with controlled HTTP responses.

## Optional teach-back in VS Code

In the notebook assistant, explain your approach, a bug fix or a concept with one example in the chat and ask Instructor to check your reasoning. Instructor receives your code and any current run evidence when you send your explanation. Continue with a follow-up question whenever you are ready.

Instructor checks your reasoning, addresses one gap and asks a focused follow-up. After a sound explanation, it can suggest a small variation to try independently. You may skip teach-back and continue coding, running or testing. Explanation feedback does not award mastery; independent work and explicit Practice submissions remain separate evidence.

## Suggest the next line

In a linked notebook code cell, place the cursor on a blank line or at the end of the preceding line. Choose **Suggest Next Line** from the editor context menu. First say what the next line should do; Instructor then uses the current cell, including unsaved edits. Press **Tab** to insert the preview or **Escape** to dismiss it. Moving the cursor or changing the code clears the suggestion. If one line would give away the exercise, Instructor can respond with a hint.

## Spoken explanations in desktop and VS Code

The learning notebook keeps speaker/output controls beside its message action. The
Practice panel uses opt-in spoken explanations; live Instructor/Doubt Solver use lesson audio.
Speech explains the idea; there is no Read aloud action for displayed text or documents.
Coach generates a separate explanation and rejects copied screen text before sending it
to TTS, with no fallback to reading the reply. This requires the matching backend update. Native
`.ipynb` questions use written replies in the notebook; they do not open a separate
audio or assistant panel.

## Exercise folders from earlier versions

Earlier versions opened each exercise as a folder of files. Opening such a folder now
reopens that exercise in its **Practice notebook**, starting from the code in the
folder. Your files are left in place. **Send to open session**, server submissions,
editor heartbeats and learning-event uploads are retired. Legacy write APIs reject
before authentication or transport.

## Development and validation

- `npm test`: local runner, rendering, evidence, coaching and update tests.
- `npm run compile && node out/test/integration/runTest.js suiteSkillPractice`: real extension-host checks for learner cases, native test-code execution, skill routing and rejection of forged debugger observations, using a contract-only notebook-help service.
- `node out/test/integration/runTest.js suiteNativeDebugger`: real JavaScript/TypeScript adapters, breakpoints, stdin, locals, call stack, stepping, stale-observation rejection and conflict-safe import. Set `VSCODE_TEST_DEBUG_EXTENSIONS` to an isolated adapter directory; add `DHIMANTAI_NATIVE_PYTHON=1` and optionally `DHIMANTAI_NATIVE_PYTHON_PATH` for Python. `DHIMANTAI_NATIVE_COURSE_CONFIG` may name a JSON fixture containing `bin`, `name` and `root` for an already prepared, disposable course container with loopback port mapping. These are real runtime checks, not live Instructor acceptance.
- `npm run compile && node out/test/integration/runTest.js suiteLearningVideo`: automated native check using the production room bundle and live Token Embeddings YouTube player. Asserts decoded audio/video, both question/pause paths, explicit resume, and server-requested pause. Catalog, auth and Instructor transport are fixtures; real Instructor answers need a signed-in staging check. For acceptance with the sandbox enabled, use `scripts/check-vscode-video-runtime.cjs` with an explicit native executable; `@vscode/test-electron` adds sandbox-disabling flags. In the source checkout, see `scripts/video-runtime.md` for runtime repair and distribution notes and `test/integration/learningVideo-check.md` for acceptance results.
- `npm run compile && node out/test/integration/runTest.js suiteCoachPlayback`: real WebRTC/worklet playback in a VS Code test host. Select **Start audio check** in its panel to satisfy the browser's user-gesture requirement. The probe compares the unattached track with the fixed playback path, then checks pause, buffered resume, completion, replay and silent-stream rejection without an account or microphone.
- `npm run test:b2c`: individual signup, confirmation, recovery and catalog enrollment in a real VS Code test host.
- `npm run test:signup`: email-only account pages, validation, retry, confirmation, cancellation and service changes in a real VS Code test host against a local auth fixture.
- `npm run test:colab`: local notebook preparation and kernel handoff in VS Code 1.106.3, with a simulated Colab provider. A real Google sign-in and TPU runtime remain a separate acceptance check.
- `npm run test:vscode`: notebook-first startup, Practice from the Explorer, Instructor notebook handoff and rejection of legacy upload paths.
- `npm run test:coach-chat`: compatibility alias for the inline history suite below.
- `npm run compile && node out/test/integration/runTest.js suiteCourseRecovery`: real first-run setup, automatic restart and repair of a deliberately damaged disposable course container, preserving learner files. Requires Podman.
- `npm run test:coach-history`: drives real VS Code composers and cell clicks, checks visible Markdown through cell switches, edits, Python execution, failed requests and notebook reopening, and verifies Practice keeps the right panel closed. Uses controlled API replies, not staging AI acceptance. Set `VSCODE_TEST_EXECUTABLE` to test a particular VS Code executable and `DHIMANTAI_UX_OUT` to retain screenshots and the build receipt.
- `npm run test:courses` opens Python and Build an LLM from Scratch in a desktop VS Code test profile. It requires Podman and downloads course dependencies on the first build.
- `npm run package` builds the VSIX. Keep references to developer-only files as plain repository paths in this README: `scripts/` and `test/` are excluded from the VSIX and have no public content URL.
- `VSCODE_TEST_LANGUAGE_EXTENSIONS=/path/to/isolated/extensions node out/test/integration/runTest.js suitePracticeNotebook`
  also checks completion against Bash IDE when it is installed in that directory.
- `python3 scripts/check-notebook-cells.py IMAGE` checks all seven programming languages,
  Bash/Zsh, live input, files, HTML/plots and SQL/DBA state in a disposable Podman
  container. Supply a course image with those language tools, PostgreSQL and Matplotlib.
- `DHIMANTAI_SQL_TEST_IMAGE=IMAGE node --test out/test/sqlRuntimeRecovery.test.js`
  exercises initialization failure/retry, dataset recovery, shared SQL state and
  WHERE/HAVING results against PostgreSQL 17 with a read-only course home.

Model keys remain on the service. Local runtime files remain learner-owned.

## Individual signup and catalog rollout

Deploy `20261106010000_individual_learners_course_catalog.sql` before enabling the
new extension and deploy the matching course API. Signup checks the catalog RPC
before creating an auth identity. The migration enables separate individual
profiles and enrollments, and initially curates **Python** and **Build an LLM from
Scratch** from the existing shared Upskill syllabus. A course appears only when it
has at least one approved, active lesson in that environment. Institution question
banks are excluded. Individual learners receive the first chapter free; later
chapters require a one-time course or bundle purchase through **Pricing & Purchases**.
Apply `20261106120000_learning_course_purchases.sql` and configure Razorpay and
approved prices using `docs/vscode-course-payments.md` in the repository.
There is no automatic renewal. Refresh purchases after completing browser checkout.

Manage catalog metadata in `learning_catalog_courses` and explicit lesson links
in `learning_catalog_chapters` using an authorized service/admin workflow. Newly
added syllabus rows are not automatically added to the catalog. Set
`is_published=false` to withdraw a course and its access; set
`self_enrollment_enabled=false` to close new enrollment while retaining access for
learners who already joined. Enrollments do not award progress or mastery.

Run `python3 agent/tests/run_individual_learner_catalog_sql.py` from the repository
root to validate profile and enrollment permissions in disposable PostgreSQL.
Live email delivery and signup settings must be verified on the selected service
after deployment.
