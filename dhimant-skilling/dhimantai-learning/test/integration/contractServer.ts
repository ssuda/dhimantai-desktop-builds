// Local stand-in for GoTrue + /practice-code that keeps the server's contract
// (agent/course_projects/api.py, practice.py, code_help.py):
// optimistic draft versions (409), idempotent request ids, UTF-16 selection offsets,
// statement selections widened to the whole line, apply only after "received" and only on
// the same draft version. Runs are executed for real with python3 -I main.py <argv>.
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {studyFixtures, epubFixture, pdfFixture, pdfId} from './studyDocuments';

export const QUESTION_ID = '9d6ba91a-dce1-5d5e-b88c-46fc926a2f7a';
export const TUTOR_ID = 'ef88979f-ecf0-47ef-85ce-1dcd96ac2782';
export const TUTOR_PAYLOAD = { lesson: ['Python', 'LLMs', 'Tokenizers'], language: 'python',
  code: 'from transformers import AutoTokenizer\nprint(42)\n', stdin: 'hello\n',
  mode: 'program', packages: ['transformers==4.57.6'] };
export const EMAIL = 'learner@example.test';
export const PASSWORD = 'correct horse battery staple';
/** Students sign in with institute code + roll number; these map to the app's Supabase emails. */
export const STUDENT = { instituteCode: 'KTS-001', rollNumber: '2024/A-001', password: 'student pass 1' };
export const LEGACY_STUDENT = { instituteCode: 'OLD9', rollNumber: 'R.7', password: 'legacy pass 1' };
const ACCOUNTS: Record<string, { password: string; id: string }> = {
  [EMAIL]: { password: PASSWORD, id: 'learner-1' },
  '2024a001_kts001@vidyai.in': { password: STUDENT.password, id: 'student-1' },
  'r.7.old9@vidyai.in': { password: LEGACY_STUDENT.password, id: 'student-legacy' },
};

// Mirrors agent/course_projects/help_ladder.py: every level needs the learner's explanation; a line needs an
// earlier hint and a block a line or two hints. The real token is signed; this stand-in only counts.
const ladderCounts = (token: unknown) => {
  const m = typeof token === 'string' ? /^h(\d+)l(\d+)$/.exec(token) : null;
  return { hint: m ? Number(m[1]) : 0, line: m ? Number(m[2]) : 0 };
};
function ladderRefusal(body: Json, mode: string): string | undefined {
  if (mode === 'hint') return;
  if (typeof body.explanation !== 'string' || body.explanation.trim().length < 20) return 'First say in your own words (20+ characters) what you think is going wrong, and where.';
  const c = ladderCounts(body.ladder_token);
  if (mode === 'statement' && c.hint < 1) return 'Ask for a hint first, then try it.';
  if (mode === 'block' && c.line < 1 && c.hint < 2) return 'Use a hint and a line suggestion first. Bigger changes come last.';
}
function nextLadderToken(token: unknown, mode: string) {
  const c = ladderCounts(token);
  return `h${c.hint + (mode === 'hint' ? 1 : 0)}l${c.line + (mode === 'hint' ? 0 : 1)}`;
}

const STARTER = `import sys


def print_words(filename):
    pass


def print_top(filename):
    pass


def main():
    if len(sys.argv) != 3:
        print('usage: ./wordcount.py {--count | --topcount} file')
        sys.exit(1)
    option, filename = sys.argv[1], sys.argv[2]
    if option == '--count':
        print_words(filename)
    elif option == '--topcount':
        print_top(filename)


main()
`;

function counts(content: string) {
  const map = new Map<string, number>();
  for (const word of content.toLowerCase().split(/\s+/).filter(Boolean)) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}

function sample(name: string, content: string, description: string) {
  const pairs = [...counts(content)];
  const sorted = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const text = (values: [string, number][]) => values.map(([w, c]) => `${w} ${c}\n`).join('');
  return { name, content, description, expected_output: { '--count': text(sorted), '--topcount': text(top) } };
}

const WORDS = ['zebra', 'apple', 'pear', 'orange', 'banana', 'grape', 'lemon', 'mango', 'peach', 'plum', 'cherry', 'melon',
  'kiwi', 'fig', 'date', 'lime', 'berry', 'apricot', 'coconut', 'guava', 'papaya', 'olive', 'quince', 'nectarine'];

// A test suite like the server's: public cases (with answers) reach the editor, hidden ones never do.
const CASE = (id: string, visibility: 'public' | 'hidden', option: '--count' | '--topcount', name: string, content: string) => {
  const s = sample(name, content, '');
  return { id, visibility, kind: 'cli' as const, argv: [option, name], files: [{ name, content }], stdin: '', expected: s.expected_output[option] };
};
const SUITE = [
  CASE('t1', 'public', '--count', 'words.txt', 'Apples are good\nApples and pears are good\n'),
  CASE('t2', 'public', '--topcount', 'distinct.txt', 'kiwi kiwi kiwi fig fig lime\n'),
  CASE('t3', 'hidden', '--count', 'hidden-case-3.txt', 'Python python PYTHON\ncode Code learn\n'),
  CASE('t4', 'hidden', '--count', 'hidden-case-4.txt', ''),
  CASE('t5', 'hidden', '--topcount', 'hidden-case-5.txt', '  x\ty  y\n\nz z z\n'),
];

const project = {
  id: 'practice:' + QUESTION_ID, question_id: QUESTION_ID, version: 'practice-code-v2', workspace_kind: 'practice', programming_environment: 'external',
  code_assistance_allowed: true, title: 'Programming exercise', subject: 'Python',
  brief: 'Complete the **Word count** exercise in Python. Implement `print_words` and `print_top`.\n\n```python\n' + STARTER + '```',
  languages: ['python'], milestones: [], rubric: [],
  run_configuration: {
    protocol: 2, preset: 'word_count',
    arguments: [
      { value: '--count', description: 'Show all word counts alphabetically' },
      { value: '--topcount', description: 'Show the 20 most frequent words' },
    ],
    sample_files: [
      sample('words.txt', 'Apples are good\nApples and pears are good\n', 'Alphabetical order vs frequency.'),
      sample('mixed-case.txt', 'Python python PYTHON\ncode Code learn\n', 'Cases count as one word.'),
      sample('empty.txt', '', 'No words.'),
      sample('top-20.txt', WORDS.map((w, i) => Array(24 - i).fill(w).join(' ')).join('\n') + '\n', 'Only the top 20 are printed.'),
    ],
    max_files: 5, max_file_bytes: 32000, max_total_bytes: 64000,
  },
  starter_code: STARTER, contract: 'Write a Python script.', understanding_prompt: '',
  tests: { suite_version: 1, hidden_count: 3, public: SUITE.filter(t => t.visibility === 'public').map(({ visibility: _v, ...t }) => t) },
};

type Json = Record<string, any>;

export interface ContractState {
  liveTransfers?: Json[];
  draft: { version: number; payload: Json };
  submissions: Json[];
  assistance: Json[];
  requests: string[];
  editor?: Json | null;
  learning: Json[];
  loggedOut?: number;
  coach: Json[];
  signIns?: string[];
}

export class ContractServer {
  constructor(private readonly courseNames = ['Python']) {}
  readonly state: ContractState = {
    draft: {
      version: 0,
      payload: { language: 'python', notebook: { nbformat: 4, cells: [{ cell_type: 'code', source: STARTER, metadata: {} }] }, notes: '', help_used: 'assistance_unknown', milestones: [], stdin: '' },
    },
    submissions: [], assistance: [], requests: [], learning: [], coach: [],
  };
  private server?: Server;
  private tokens = new Set<string>();
  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch(error => send(res, 500, { error: String(error) })));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    return this.url;
  }

  stop() {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.url);
    const body = req.method === 'POST' ? JSON.parse((await read(req)) || '{}') : {};
    if (url.pathname === '/__state') return send(res, 200, this.state);
    this.state.requests.push(`${req.method} ${url.pathname}`);

    if(url.pathname.startsWith('/notebook-coach/study')||url.pathname.startsWith('/study-files/')){
      const courses=await studyFixtures();
      if(!url.pathname.startsWith('/study-files/')&&!this.tokens.has((req.headers.authorization??'').replace(/^Bearer /,'')))return send(res,401,{error:'Sign in'});
      if(url.pathname==='/notebook-coach/study')return send(res,200,{courses:courses.map((c:any)=>({id:c.id,title:c.title,chapters:c.chapters.map((ch:any)=>({id:ch.id,title:ch.title,format:ch.id===pdfId?'pdf':'epub'}))}))});
      const id=decodeURIComponent(url.pathname.split('/').at(-1)!);
      const course=courses.find((c:any)=>c.chapters.some((ch:any)=>ch.id===id));
      const chapter=course?.chapters.find((ch:any)=>ch.id===id);
      if(!chapter)return send(res,404,{error:'No PDF or EPUB'});
      if(url.pathname.startsWith('/study-files/')){res.writeHead(200,{'Content-Type':id===pdfId?'application/pdf':'application/epub+zip'});return res.end(id===pdfId?pdfFixture():await epubFixture(chapter));}
      return send(res,200,{...chapter,course:course.title,reading:course.reading,document:{format:id===pdfId?'pdf':'epub',url:this.url+'/study-files/'+encodeURIComponent(id)}});
    }

    if (url.pathname === '/auth/v1/logout') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.headers.apikey !== 'test-anon-key' || !this.tokens.delete(token)) return send(res, 401, { msg: 'Invalid token' });
      this.state.loggedOut = (this.state.loggedOut ?? 0) + 1;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/auth/v1/token') {
      if (req.headers.apikey !== 'test-anon-key') return send(res, 401, { msg: 'Invalid API key' });
      const grant = url.searchParams.get('grant_type');
      const account = ACCOUNTS[body.email];
      if (grant === 'password' && (!account || account.password !== body.password)) return send(res, 400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      this.state.signIns = [...(this.state.signIns ?? []), body.email];
      const token = 'tok-' + randomUUID();
      this.tokens.add(token);
      const email = grant === 'password' ? body.email : EMAIL;
      return send(res, 200, { access_token: token, refresh_token: 'refresh-' + randomUUID(), expires_in: 3600, user: { id: (ACCOUNTS[email] ?? ACCOUNTS[EMAIL]).id, email } });
    }

    if (url.pathname === '/notebook-coach/labs') {
      if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(res, 401, {error:'Sign in'});
      const directory = join(__dirname, '../../../media/course/labs');
      const labs = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.ipynb')).sort()
        .map(async name => ({name,notebook:JSON.parse(await readFile(join(directory,name),'utf8'))})));
      return send(res, 200, {labs});
    }
    if (url.pathname.startsWith('/notebook-coach/exercises')) {
      if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(res, 401, { error: 'Sign in' });
      if (url.pathname.endsWith('/questions')) {
        return send(res, 200, { questions: url.searchParams.get('pool') === 'textbook'
          ? [{ id: QUESTION_ID, title: 'Word count', topic: 'Strings', language: 'python', difficulty: 'easy' }] : [] });
      }
      if (req.method === 'GET') return send(res, 200, { courses: this.courseNames.map(name => ({name, chapters: [{id: QUESTION_ID, name: 'Lists'}]})),
        languages: [{ id: 'python', name: 'Python' }] });
      if (body.chapter_id !== QUESTION_ID || body.language !== 'python' || body.difficulty !== 'easy') return send(res, 400, {error: 'Bad selection'});
      return send(res, 200, { exercise: {title: 'Count red labels', task: 'Count the red labels in a list.',
        example_input: "['red', 'blue', 'red']", expected_output: '2'}, course: 'Python', chapter: 'Lists',
        language: body.language, kernel: 'python3', difficulty: body.difficulty, validation: 'reference_execution',
        tests: [{id: 'example', kind: 'stdio', stdin: "['red', 'blue', 'red']", expected: '2'}] });
    }

    if (url.pathname.endsWith('/next-line')) {
      if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(res, 401, {error: 'Sign in'});
      const refused = ladderRefusal(body, 'statement');
      if (refused) return send(res, 412, { error: refused });
      this.state.coach.push(body);
      return send(res, 200, {code: '    total += 1', hint: 'Count one item.', explanation: 'Add one for this item.',
        ladder_token: nextLadderToken(body.ladder_token, 'statement')});
    }

    if (url.pathname === '/notebook-coach/tutor' || url.pathname === `/practice-code/${QUESTION_ID}/notebook-coach`) {
      if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(res, 401, { error: 'Sign in' });
      this.state.coach.push(body);
      return send(res, 200, { guidance: 'Check which name this line reads.', prompt: 'Where is its value assigned?', line: 2 });
    }

    const live = url.pathname.match(/^\/(practice-code|doubt-practice)\/([0-9a-f-]{36})\/transfer\/([0-9a-f-]{36})\/send$/);
    if (live) {
      if (!this.tokens.has((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return send(res, 401, { error: 'Sign in' });
      if (live[2] !== QUESTION_ID || live[3] !== 'f594f2bf-81b9-4869-a4d0-bef64dc4160e') return send(res, 410, { error: 'This live link ended.' });
      this.state.liveTransfers ??= [];
      const old = this.state.liveTransfers.find(t => t.request_id === body.request_id);
      if (!old) this.state.liveTransfers.push(body);
      return send(res, 200, { receipt: { status: 'applied', revision: body.base_revision + 1 } });
    }

    if (url.pathname.startsWith('/tutor-code/vscode/')) {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.tokens.has(token)) return send(res, 401, { error: 'Sign in' });
      if (url.pathname === `/tutor-code/vscode/${TUTOR_ID}` && req.method === 'GET') {
        return send(res, 200, { handoff: { id: TUTOR_ID, payload: TUTOR_PAYLOAD } });
      }
      if (url.pathname === `/tutor-code/vscode/${TUTOR_ID}/opened` && req.method === 'POST') {
        return send(res, 200, { opened: true });
      }
      return send(res, 404, { error: 'This Instructor link expired or was replaced. Open it again from the app.' });
    }

    const match = url.pathname.match(/^\/(?:practice-code|doubt-practice)\/([0-9a-f-]{36})(?:\/(save|submit|assist|editor|learning-events|coach)(?:\/([0-9a-f-]{36}))?)?$/);
    if (!match) return send(res, 404, { error: 'Not found' });
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!token) return send(res, 401, { error: 'Sign in to continue.' });
    if (!this.tokens.has(token)) return send(res, 401, { error: 'Your session has expired.' });
    if (match[1] !== QUESTION_ID) return send(res, 404, { error: 'This question is not available.' });
    const [, , action, assistanceId] = match;
    const s = this.state;

    if (!action && req.method === 'GET') {
      const currentProject = url.pathname.startsWith('/doubt-practice/')
        ? { ...project, id: `practice:doubt:${QUESTION_ID}`, question_id: `doubt:${QUESTION_ID}`, doubt_practice: true } : project;
      return send(res, 200, {
        project: currentProject, draft: s.draft, submissions: [...s.submissions].reverse().map(publicSubmission), source_changed: false,
        coding_help_received: s.assistance.some(a => a.received_at), runtime: { status: 'ready', ready_languages: ['python'] },
      });
    }
    if (action === 'editor') {
      if (body.client !== 'vscode' || !['open', 'heartbeat', 'close'].includes(body.event)) return send(res, 400, { error: 'Invalid editor session.' });
      s.editor = body.event === 'close' ? null : { client: 'vscode', client_version: body.client_version, platform: body.platform, connected: true };
      return send(res, 200, { editor: s.editor });
    }
    if (action === 'coach') {
      if (!body.work) return send(res, 410, { error: 'Share current work for transient feedback.' });
      s.coach.push(body);
      return send(res, 200, { turn: { say: `You said “${String(body.message).slice(0, 40)}”. Let us use ${body.strategy}: look at line ${body.line ?? 1}.`,
        question: 'What value does it have just before it fails?', strategy: body.strategy ?? 'decompose', line: body.line ?? null,
        replies: ['Show me where to look', 'I am stuck'], source: 'model' } });
    }
    if (action === 'learning-events') {
      if (!Array.isArray(body.events) || !body.events.length || body.events.length > 50) return send(res, 400, { error: 'Send between 1 and 50 learning events.' });
      for (const e of body.events) if (!s.learning.some(x => x.id === e.id)) s.learning.push(e);
      return send(res, 200, { accepted: body.events.map((e: Json) => e.id) });
    }
    if (action === 'save') {
      if (body.expected_version !== s.draft.version) return send(res, 409, { error: 'Your draft changed elsewhere. Reload before saving.' });
      const { expected_version: _ignored, ...payload } = body;
      s.draft = { version: s.draft.version + 1, payload };
      return send(res, 200, { draft: s.draft });
    }
    if (action === 'submit') {
      const old = s.submissions.find(x => x.request_id === body.request_id);
      if (old) return send(res, 200, { submission: publicSubmission(old) });
      if (body.expected_version !== s.draft.version) return send(res, 409, { error: 'Save before running.' });
      const row: Json = { id: randomUUID(), request_id: body.request_id, kind: body.kind, status: 'queued', draft_version: s.draft.version, created_at: new Date().toISOString() };
      s.submissions.push(row);
      if (body.kind === 'check') void this.check(row, JSON.parse(JSON.stringify(s.draft.payload)));
      else void this.execute(row, JSON.parse(JSON.stringify(s.draft.payload)));
      return send(res, 200, { submission: publicSubmission(row) });
    }
    if (action === 'assist' && !assistanceId) {
      // External programming (agent/course_projects/external_programming.py) takes the code from the request.
      const external = body.work && typeof body.work === 'object';
      if (!external && (body.expected_version !== s.draft.version || body.expected_version < 1)) return send(res, 409, { error: 'Your exercise changed. Save or reload before asking for help.' });
      const refused = ladderRefusal(body, body.mode);
      if (refused) return send(res, 412, { error: refused });
      const source: string = (external ? body.work : s.draft.payload).notebook.cells[body.cell_index].source;
      let start = body.selection_start, end = body.selection_end;
      if (body.mode === 'statement') {
        start = source.lastIndexOf('\n', start - 1) + 1;
        const boundary = source.indexOf('\n', end);
        end = boundary === -1 ? source.length : boundary;
      }
      const selected = source.slice(start, end);
      const repaired = selected.replace('source.lower()', 'source.read().lower()');
      const response = body.mode === 'hint'
        ? { hint: 'A file object is not text. What do you need to call before you can split its contents?', code: '', explanation: 'open() returns a file object.', check_question: 'Which method returns the whole file as a string?' }
        : { hint: 'Read the file before splitting it.', code: repaired, explanation: 'read() returns the file contents as a string.', check_question: 'What would happen with a 2 GB file?' };
      const row = { id: randomUUID(), request_id: body.request_id, mode: body.mode, draft_version: s.draft.version, status: 'ready', response, received_at: null, applied_at: null, error: null,
        target: { cell_index: body.cell_index, selected_code: selected, selection_start: start, selection_end: end }, source, local_run: body.local_run ?? null };
      s.assistance.push(row);
      return send(res, 200, { assistance: publicHelp(row), ladder_token: nextLadderToken(body.ladder_token, body.mode) });
    }
    if (action === 'assist' && assistanceId) {
      const row = s.assistance.find(a => a.id === assistanceId);
      if (!row) return send(res, 404, { error: 'Help is unavailable.' });
      if (body.event === 'received') {
        row.received_at ??= new Date().toISOString();
        return send(res, 200, { assistance: publicHelp(row) });
      }
      if (!row.received_at) return send(res, 400, { error: 'Read this suggestion before applying it.' });
      if (row.applied_at || s.draft.version !== row.draft_version) return send(res, 409, { error: 'Your code changed. Ask for a fresh suggestion.' });
      const payload = JSON.parse(JSON.stringify(s.draft.payload));
      const cell = payload.notebook.cells[row.target.cell_index];
      if (cell.source !== row.source) return send(res, 409, { error: 'The selected code changed.' });
      cell.source = cell.source.slice(0, row.target.selection_start) + row.response.code + cell.source.slice(row.target.selection_end);
      s.draft = { version: s.draft.version + 1, payload };
      row.applied_at = new Date().toISOString();
      row.applied_version = s.draft.version;
      return send(res, 200, { draft: s.draft });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  /** Judge the saved draft on every case, like the worker: full detail for public cases, verdict only for hidden. */
  private async check(row: Json, payload: Json) {
    row.status = 'running';
    const norm = (t: string) => t.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
    const cases = [];
    for (const test of SUITE) {
      const dir = await mkdtemp(join(tmpdir(), 'dhimantai-check-'));
      try {
        await writeFile(join(dir, 'main.py'), payload.notebook.cells.find((c: Json) => c.cell_type === 'code').source);
        for (const f of test.files) await writeFile(join(dir, f.name), f.content);
        const out = await new Promise<{ code: number; stdout: string }>(resolve =>
          execFile('python3', ['-I', 'main.py', ...test.argv], { cwd: dir, timeout: 10_000 }, (error, stdout) =>
            resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout })));
        const verdict = out.code !== 0 ? 'runtime_error' : norm(out.stdout) === norm(test.expected) ? 'passed' : 'wrong_answer';
        cases.push({ id: test.id, visibility: test.visibility, verdict, label: verdict,
          ...(test.visibility === 'public' ? { input: { argv: test.argv }, expected: test.expected, actual: out.stdout } : {}) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const passed = cases.filter(c => c.verdict === 'passed').length;
    row.automated = { tests: { suite_version: 1, passed, total: cases.length, all_passed: passed === cases.length,
      public: { passed: cases.filter(c => c.visibility === 'public' && c.verdict === 'passed').length, total: 2 }, cases } };
    row.status = 'assessed';
  }

  private async execute(row: Json, payload: Json) {
    row.status = 'running';
    const dir = await mkdtemp(join(tmpdir(), 'dhimantai-run-'));
    try {
      await writeFile(join(dir, 'main.py'), payload.notebook.cells.find((c: Json) => c.cell_type === 'code').source);
      for (const file of payload.files ?? []) await writeFile(join(dir, file.name), file.content);
      const started = Date.now();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        const child = execFile('python3', ['-I', 'main.py', ...(payload.argv ?? [])], { cwd: dir, timeout: 45_000 }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout, stderr }));
        child.stdin?.end(payload.stdin ?? '');
      });
      row.automated = {
        display: [], scope: 'Development run only. No correctness tests were applied.',
        execution: { status: 'exited', exit_code: result.code, stdout: result.stdout, stderr: result.stderr,
          command: ['python', '-I', 'main.py', ...(payload.argv ?? [])].join(' '), duration_seconds: (Date.now() - started) / 1000, truncated: false },
      };
      row.status = 'assessed';
    } catch (error) {
      row.status = 'failed';
      row.error = String(error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function publicSubmission(row: Json) {
  const { request_id: _r, ...rest } = row;
  return rest;
}

function publicHelp(row: Json) {
  const { source: _s, local_run: _l, ...rest } = row;
  return rest;
}

function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
