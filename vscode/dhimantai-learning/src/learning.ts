import type { DraftPayload, PracticeProject, RunConfiguration } from './api';

/** File names the sandbox writes (agent/course_projects/runtime/program.py), so error locations match. */
const ENTRY_FILES: Record<string, string> = {
  python: 'main.py', rust: 'main.rs', c: 'main.c', java: 'Main.java',
  javascript: 'main.js', typescript: 'main.ts', go: 'main.go', bash:'main.sh',zsh:'main.sh',pglab:'main.sh',sql:'main.sql',
};

/** Editor support for each sandbox language; JavaScript and TypeScript are built into VS Code. */
export const LANGUAGE_EXTENSIONS: Record<string, { id: string; name: string } | undefined> = {
  python: { id: 'ms-python.python', name: 'Python' },
  c: { id: 'ms-vscode.cpptools', name: 'C/C++' },
  rust: { id: 'rust-lang.rust-analyzer', name: 'rust-analyzer' },
  go: { id: 'golang.go', name: 'Go' },
  java: { id: 'redhat.java', name: 'Language Support for Java' },
  bash:{id:'mads-hartmann.bash-ide-vscode',name:'Bash IDE'},
  zsh:{id:'mads-hartmann.bash-ide-vscode',name:'Bash IDE'},
  pglab:{id:'mads-hartmann.bash-ide-vscode',name:'Bash IDE'},
  javascript: undefined,
  typescript: undefined,
};

export function entryFile(language: string): string {
  return ENTRY_FILES[language] ?? 'main.txt';
}

export function codeCellIndex(payload: DraftPayload): number {
  const index = payload.notebook.cells.findIndex(c => c.cell_type === 'code');
  if (index < 0) throw new Error('This exercise has no code cell.');
  return index;
}

export function codeSource(payload: DraftPayload): string {
  return payload.notebook.cells[codeCellIndex(payload)].source;
}

export interface LocalInputs {
  source: string;
  argv: string[];
  stdin: string;
  files: { name: string; content: string }[];
}

/** Practice keeps one code cell; the local entry file is that cell. Other draft fields are preserved. */
export function payloadWith(payload: DraftPayload, local: LocalInputs): DraftPayload {
  const next: DraftPayload = JSON.parse(JSON.stringify(payload));
  next.notebook.cells[codeCellIndex(next)].source = local.source;
  next.argv = local.argv;
  next.stdin = local.stdin;
  next.files = local.files;
  return next;
}

export function samePayload(a: DraftPayload, local: LocalInputs): boolean {
  const files = (x: { name: string; content: string }[] = []) => JSON.stringify([...x].sort((p, q) => p.name.localeCompare(q.name)));
  return codeSource(a) === local.source
    && JSON.stringify(a.argv ?? []) === JSON.stringify(local.argv)
    && (a.stdin ?? '') === local.stdin
    && files(a.files) === files(local.files);
}

export const INPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\.(txt|csv|tsv|json|log|html|htm|xml)$/;

/** Mirrors runtime/program_inputs.py so students see limits before a round trip. */
export function checkInputs(config: RunConfiguration | undefined, argv: string[], files: { name: string; content: string }[]): string | undefined {
  const maxFiles = config?.max_files ?? 12;
  const maxFile = config?.max_file_bytes ?? 128_000;
  const maxTotal = config?.max_total_bytes ?? 1_000_000;
  if (argv.length > 32 || Buffer.byteLength(argv.join(''), 'utf8') > 4000) return 'Use at most 32 arguments, 4 KB in total.';
  if (files.length > maxFiles) return `Keep at most ${maxFiles} input files in the inputs folder.`;
  let total = 0;
  for (const file of files) {
    if (!INPUT_NAME.test(file.name)) return `Rename ${file.name}: input files must be .txt, .csv, .tsv, .json, .log, .html, .htm or .xml with simple names.`;
    const size = Buffer.byteLength(file.content, 'utf8');
    if (size > maxFile) return `${file.name} is larger than ${Math.round(maxFile / 1000)} KB.`;
    total += size;
  }
  if (total > maxTotal) return `Input files must total under ${maxTotal >= 1_000_000 ? `${maxTotal / 1_000_000} MB` : `${Math.round(maxTotal / 1000)} KB`}.`;
  return undefined;
}

/** Split an argument line like a shell would for simple quoting, without ever invoking a shell. */
export function parseArguments(text: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    result.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] ?? match[3]);
  }
  return result;
}

export function formatArguments(argv: string[]): string {
  return argv.map(a => (/^[\w./:=@%+-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`)).join(' ');
}

export function defaultArgv(config: RunConfiguration | undefined): string[] {
  if (config?.preset === 'word_count' && config.sample_files.length) return ['--count', config.sample_files[0].name];
  if (config?.preset === 'baby_names' && config.sample_files.length) return [config.sample_files[0].name];
  return [];
}

/** Expected output exists only when the run uses an unmodified sample with a known option. */
export function expectedOutput(config: RunConfiguration | undefined, argv: string[], files: { name: string; content: string }[]): string | undefined {
  if (!config) return undefined;
  // Word count: [option, file]. Programs that take one file and no option (baby names): [file].
  const [option, name] = argv.length === 2 ? argv : argv.length === 1 ? ['', argv[0]] : [undefined, undefined];
  if (option === undefined || name === undefined) return undefined;
  const sample = config.sample_files.find(s => s.name === name);
  const attached = files.find(f => f.name === name);
  if (!sample || !attached || attached.content !== sample.content) return undefined;
  return sample.expected_output[option];
}

export function expectedRunOutput(project: PracticeProject, inputs: LocalInputs): string | undefined {
  const { argv, stdin, files } = inputs;
  const preset = !stdin ? expectedOutput(project.run_configuration, argv, files) : undefined;
  if (preset !== undefined) return preset;
  const samples = [...(project.tests?.public ?? []), ...(project.public_examples ?? [])];
  const expected = new Set(samples.filter(s => (s.kind === 'stdio' || s.kind === 'cli') && (s.stdin ?? '') === stdin &&
    JSON.stringify(s.argv ?? []) === JSON.stringify(argv) && (s.files?.length ?? 0) === files.length &&
    files.every(f => s.files?.some(other => other.name === f.name && other.content === f.content))).map(s => s.expected));
  return expected.size === 1 ? [...expected][0] : undefined;
}

export type Comparison =
  | { result: 'match' }
  | { result: 'order'; note: string }
  | { result: 'differs'; line: number; expected: string; actual: string; missing: number; extra: number };

const lines = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').map(l => l.replace(/\s+$/, '')).filter((l, i, all) => all.length > 1 || l !== '');

export function compareOutput(actual: string, expected: string): Comparison {
  const a = lines(actual);
  const e = lines(expected);
  if (a.length === e.length && a.every((line, i) => line === e[i])) return { result: 'match' };
  if (a.length === e.length && [...a].sort().join('\n') === [...e].sort().join('\n')) {
    return { result: 'order', note: 'Same lines in a different order. Check how you sort; equal counts may legitimately tie.' };
  }
  const index = Math.max(0, Array.from({ length: Math.max(a.length, e.length) }, (_, i) => i).find(i => a[i] !== e[i]) ?? 0);
  const expectedSet = new Set(e);
  const actualSet = new Set(a);
  return {
    result: 'differs', line: index + 1, expected: e[index] ?? '(no more lines)', actual: a[index] ?? '(no more lines)',
    missing: e.filter(l => !actualSet.has(l)).length, extra: a.filter(l => !expectedSet.has(l)).length,
  };
}

export interface ErrorLocation {
  line: number;
  column?: number;
  message: string;
}

/** Find the learner-code line for a runtime or compile error in program output. */
export function errorLocation(language: string, stderr: string): ErrorLocation | undefined {
  const text = stderr.replace(/\r\n/g, '\n');
  const trimmed = text.trim().split('\n');
  const last = trimmed[trimmed.length - 1]?.trim() ?? '';
  const file = entryFile(language).replace(/\./g, '\\.');
  const take = (re: RegExp, pick: 'first' | 'last') => {
    const all = [...text.matchAll(re)];
    return pick === 'last' ? all[all.length - 1] : all[0];
  };
  let match: RegExpMatchArray | undefined;
  let message = last;
  switch (language) {
    case 'python':
      match = take(new RegExp(`File "(?:[^"]*/)?${file}", line (\\d+)`, 'g'), 'last');
      break;
    case 'rust':
      match = take(new RegExp(`(?:--> |panicked at )(?:\\./)?${file}:(\\d+):(\\d+)`, 'g'), 'first');
      // Compile errors start with "error"; a panic's reason is the line after "panicked at".
      {
        const panic = trimmed.findIndex(l => l.includes('panicked at'));
        message = trimmed.find(l => /^error/.test(l)) ?? (panic >= 0 ? trimmed[panic + 1]?.trim() : undefined) ?? last;
      }
      break;
    case 'typescript':
      match = take(new RegExp(`${file}\\((\\d+),(\\d+)\\): (.*)`, 'g'), 'first');
      if (match) message = match[3];
      break;
    case 'javascript':
      match = take(new RegExp(`${file}:(\\d+)(?::(\\d+))?`, 'g'), 'first');
      message = trimmed.find(l => /^\w*Error\b/.test(l)) ?? last;
      break;
    default:
      match = take(new RegExp(`(?:\\./)?${file}:(\\d+)(?::(\\d+))?:?\\s*(?:fatal )?(?:error:?)?\\s*(.*)`, 'g'), 'first');
      if (match?.[3]) message = match[3];
  }
  if (!match) return undefined;
  const line = Number(match[1]);
  if (!Number.isInteger(line) || line < 1) return undefined;
  return { line, column: match[2] ? Number(match[2]) : undefined, message: message || 'The program stopped with an error.' };
}

/** Apply a server suggestion locally for preview, using the same UTF-16 offsets as the server. */
export function spliceSuggestion(source: string, start: number, end: number, code: string): string {
  return source.slice(0, start) + code + source.slice(end);
}
