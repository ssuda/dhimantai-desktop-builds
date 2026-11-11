import { StringDecoder } from 'node:string_decoder';

export interface ProjectCheckDiagnostic { cause: string; file?: string; line?: number }

function cause(type: string, detail: string) {
  const explanations: Record<string, string> = {
    NotImplementedError: 'This part is not implemented yet',
    AssertionError: 'A check did not match its expected result',
    SyntaxError: 'Python could not read this code',
    IndentationError: 'Python could not read the indentation',
    TabError: 'The indentation mixes tabs and spaces',
    ModuleNotFoundError: 'Python could not find a required module',
    NameError: 'A name is used before it is defined',
    TypeError: 'A value or argument has an unexpected type',
  };
  return (explanations[type] || type) + (detail ? ': ' + detail.slice(0, 240) : '.');
}

type Frame = {file: string; line: number};

/**
 * A traceback frame as a project-relative path, or undefined for the standard library, installed packages and
 * anything outside the project. With the container project folder known, only frames below it count.
 */
export function projectFrame(raw: string, projectDir?: string): string | undefined {
  const path = raw.replace(/\\/g, '/');
  let relative: string | undefined;
  if (projectDir) {
    const base = projectDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (path.startsWith(base)) relative = path.slice(base.length);
    else if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path) && !path.startsWith('<')) relative = path.replace(/^(?:\.\/)+/, '');
  } else if (!/\/(?:site-packages|dist-packages|lib\/python[0-9.]*)\//.test(path)) {
    relative = /(?:^|\/)((?:course_agent|checks|tests|shelf|rich|reading|examples)\/[A-Za-z0-9_./-]+\.py|check\.py)$/.exec(path)?.[1];
  }
  if (!relative || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.py$/.test(relative)) return;
  const parts = relative.split('/');
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'site-packages' || part === 'dist-packages')) return;
  return relative;
}
/** Checkers and tests usually only report a failure; the learner's own source is where to look first. */
const learnerFrame = (file: string) => !/^(?:checks|tests)\//.test(file) && file !== 'check.py';

function skippedDiagnostic(file?: string): ProjectCheckDiagnostic {
  if (file === 'tests/test_my_agent.py') return {cause: 'A test was skipped: Replace the placeholder test in tests/test_my_agent.py '
    + 'with a test you can explain. The final check does not accept skipped tests.', file};
  return file ? {cause: `A test in ${file} was skipped. The final check does not accept skipped tests.`, file}
    : {cause: 'Some tests were skipped. The final check does not accept skipped tests.'};
}

/** Parse complete lines independently on each pipe; verbose subtests can precede the traceback. */
class PythonFailure {
  private pending = '';
  private longLine = false;
  private active = false;
  private learner?: Frame;
  private frame?: Frame;
  private trace = '';
  private decoder = new StringDecoder('utf8');
  failure?: {diagnostic: ProjectCheckDiagnostic; traceback: string};
  /** undefined: nothing skipped; '': skipped tests reported without a file. */
  skipped?: string;

  constructor(private readonly projectDir?: string) {}

  write(chunk: Buffer) { const text = this.decoder.write(chunk); this.append(text); return text; }
  end() { const text = this.decoder.end(); this.append(text + '\n'); return text; }

  private append(text: string) {
    if (this.failure) return;
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const complete = part.endsWith('\n');
      this.longLine ||= this.pending.length + part.length > 2048;
      this.pending = (this.pending + part).slice(0, 2048);
      if (!complete) continue;
      if (!this.longLine) this.parse(this.pending.replace(/\r?\n$/, ''));
      else if (this.active) this.trace = (this.trace + '[Long diagnostic line omitted]\n').slice(-1800);
      this.pending = ''; this.longLine = false;
      if (this.failure) return;
    }
  }

  private parse(raw: string) {
    const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (text === 'Traceback (most recent call last):') {
      this.active = true; this.trace = ''; this.learner = undefined; this.frame = undefined;
    }
    const skipped = /\(((?:tests|checks)\.test_[A-Za-z0-9_]+)(?:\.[A-Za-z0-9_]+)*\)\s*\.\.\.\s*skipped\b/.exec(text);
    if (skipped) this.skipped = skipped[1].replace('.', '/') + '.py';
    else if (/^Final checker: \d+ tests; [1-9]\d* skipped$|^(?:OK|FAILED) \(.*\bskipped=[1-9]/.test(text)) this.skipped ??= '';
    const frame = /^\s+File "([^"]+)", line (\d+)/.exec(text);
    if (frame) {
      this.active = true; // Syntax/import errors can omit the Traceback heading.
      const file = projectFrame(frame[1], this.projectDir), line = Number(frame[2]);
      if (file && Number.isSafeInteger(line) && line > 0) {
        // Frames run outermost to innermost: keep the deepest learner frame, else the deepest project frame.
        this.frame = {file, line};
        if (learnerFrame(file)) this.learner = {file, line};
      }
    }
    if (!this.active) return;
    this.trace = (this.trace + text + '\n').slice(-1800);
    const error = /^((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:Error|Exception)|KeyboardInterrupt|SystemExit|StopIteration)(?::\s*(.*))?$/.exec(text);
    const at = this.learner ?? this.frame;
    if (error) this.failure = {diagnostic: {cause: cause(error[1], error[2] || ''),
      ...(at ? {file: at.file, line: at.line} : {})}, traceback: this.trace};
  }
}

/** Keep the first failure and the ending result without growing memory or the 4,000-character API payload. */
export class ProjectCheckOutput {
  private head = '';
  private tail = '';
  private truncated = false;
  private streams: {stdout: PythonFailure; stderr: PythonFailure};
  private failure?: PythonFailure['failure'];

  /** projectDir: the project folder as the check sees it (the container path), used to anchor traceback frames. */
  constructor(projectDir?: string) {
    this.streams = {stdout: new PythonFailure(projectDir), stderr: new PythonFailure(projectDir)};
  }

  append(chunk: Buffer, stream: 'stdout' | 'stderr') {
    this.retain(this.streams[stream].write(chunk));
    this.failure ??= this.streams[stream].failure;
  }

  private retain(text: string) {
    this.truncated ||= this.head.length + text.length > 4000;
    this.head = (this.head + text).slice(0, 4000);
    this.tail = (this.tail + text).slice(-4000);
  }

  finish() {
    for (const stream of Object.values(this.streams)) {
      this.retain(stream.end()); this.failure ??= stream.failure;
    }
    let output = this.head;
    if (this.truncated) {
      const separator = '\n[... output omitted ...]\n';
      // Preserve the first traceback's ending even when it has scrolled out of both ends.
      const first = this.failure ? '[First captured failure]\n' + this.failure.traceback : this.head.slice(0, 1200);
      output = first + separator + this.tail.slice(-(4000 - first.length - separator.length));
    }
    const skipped = this.streams.stderr.skipped ?? this.streams.stdout.skipped;
    return {output, truncated: this.truncated,
      diagnostic: this.failure?.diagnostic ?? (skipped === undefined ? undefined : skippedDiagnostic(skipped || undefined))};
  }
}
