import type {NotebookCell} from './tutorNotebook';

// A terminal cell starts one of these native programs inside the selected course runtime.
export const terminalPrograms = {
  bash: {group:'Shells', label:'Bash', command:'exec bash -i'},
  zsh: {group:'Shells', label:'Zsh', command:[
    'for rc in "${ZDOTDIR:-$HOME}"/.zsh{env,rc} "${ZDOTDIR:-$HOME}"/.z{profile,login}; do',
    '  if [ -f "$rc" ]; then exec zsh -il; fi',
    'done',
    'exec zsh -fil', // A new course home should open at a prompt, without the Zsh first-run wizard.
  ].join('\n')},
  psql: {group:'Database clients', label:'PostgreSQL (psql)', command:'exec psql -X -P pager=off'},
  mysql: {group:'Database clients', label:'MySQL', command:'exec mysql'},
  db2: {group:'Database clients', label:'IBM Db2', command:'if [ -x /usr/local/bin/db2-course-shell ]; then exec /usr/local/bin/db2-course-shell; fi\nif ! command -v db2 >/dev/null && [ -r ~/sqllib/db2profile ]; then . ~/sqllib/db2profile; fi\nexec db2'},
  oracle: {group:'Database clients', label:'Oracle', command:'if command -v sqlplus >/dev/null; then exec sqlplus /nolog; fi\nexec sql /nolog'},
  sqlite: {group:'Database clients', label:'SQLite', command:'if command -v sqlite3 >/dev/null; then exec sqlite3; fi\nexec python3 -m sqlite3'},
  rust: {group:'Language REPLs', label:'Rust (Evcxr)', command:'exec evcxr'},
  go: {group:'Language REPLs', label:'Go (Yaegi)', command:'if command -v rlwrap >/dev/null; then exec rlwrap yaegi; fi\nexec yaegi'},
  ipython: {group:'Language REPLs', label:'IPython', command:'exec ipython'},
  irb: {group:'Language REPLs', label:'Ruby (IRB)', command:'exec irb'},
  node: {group:'Language REPLs', label:'Node.js', command:'exec node -i'},
  python: {group:'Language REPLs', label:'Python', command:'exec python3 -i'},
} as const;

export type TerminalProgram = keyof typeof terminalPrograms;
export function isTerminalProgram(value: unknown): value is TerminalProgram {
  return typeof value === 'string' && Object.hasOwn(terminalPrograms, value);
}

// The original terminal cells opened psql and did not store a program.
export function savedTerminalProgram(language: unknown): TerminalProgram {
  return isTerminalProgram(language) ? language : 'psql';
}

export interface InstructorTerminal {kind:'zsh'|'postgres'|'db2'; auto_open:boolean}

// Older published configurations predate terminal declarations for these two courses.
export function instructorTerminal(course:{title:string; instructor_terminal?:InstructorTerminal}): InstructorTerminal | undefined {
  if (course.instructor_terminal) return course.instructor_terminal;
  if (course.title === 'Terminal and Linux Basics') return {kind:'zsh',auto_open:true};
  if (course.title === 'PostgreSQL Administration (DBA)') return {kind:'postgres',auto_open:false};
}

export function defaultTerminalProgram(kind?:InstructorTerminal['kind']) {
  return kind === 'postgres' ? 'psql' : kind;
}

function starterId(program: TerminalProgram) {
  return (program === 'psql' ? 'postgres' : program) + '-console';
}

export function isStarterTerminal(cell: NotebookCell, program: TerminalProgram) {
  const base = cell.id.replace(/-\d+$/, '');
  return cell.kind === 'terminal' && (base === starterId(program) || program === 'zsh' && base === 'bash-console');
}

export function missingTerminal(cells:NotebookCell[], program:TerminalProgram): NotebookCell | undefined {
  const base = starterId(program);
  // A learner may already have switched the starter to a different program.
  if (cells.some(cell => isStarterTerminal(cell, program)
      || cell.kind === 'terminal' && savedTerminalProgram(cell.packet?.language) === program)) return;
  const ids = new Set(cells.map(cell => cell.id));
  let id = base;
  for (let suffix = 2; ids.has(id); suffix++) id = base + '-' + suffix;
  return {id, kind:'terminal', text:'', packet:{language:program}};
}

/**
 * A shell exits with its last command's status, so `exit` after a typo returns 127.
 * Only a program that failed before the learner typed anything is a startup failure.
 */
export function terminalClosedMessage(label:string, exitCode:number|null, stderr:string, typed:boolean): string | undefined {
  if (typed || exitCode === 0 || exitCode === null) return;
  return exitCode === 127 ? label + ' is unavailable in this course runtime.' : stderr || label + ' exited with status ' + exitCode + '.';
}
