import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { CourseEngine } from './courseEngine';
import { courseData, Recipe } from './courseRecipe';
import { About, CourseDataset, datasetName, ImportPlan, LabReply, LIMITS, parseCsv, planImport, TableSchema } from './dataLab';
import { labExecArgs, LabRequest, LabSource, runLab } from './dataLabEngine';

type Lab = <T>(engine: CourseEngine, request: LabRequest) => Promise<T>;

/**
 * Course data for the learning notebook. A course whose recipe lists data (media/course/profiles.json) has its samples
 * preloaded into the course container's read-only lab database once per container; a seed is reloaded only when its
 * checksum changes (media/course/data_lab.py also checks). A learner's CSV or Excel file is added alongside.
 */
export class CourseData {
  private readonly schemas = new Map<string, TableSchema[]>();
  private plan?: ImportPlan;

  constructor(private readonly extensionPath: string, private readonly state: vscode.Memento,
      private readonly lab: Lab = (engine, request) => runLab(engine.bin, labExecArgs(engine.name), request)) {}

  /** The samples a course ships, from its recipe; empty for every other course. */
  async samples(course: string | undefined): Promise<string[]> {
    const recipes = JSON.parse(await readFile(join(this.extensionPath, 'media', 'course', 'profiles.json'), 'utf8')) as Record<string, Recipe>;
    return courseData(recipes, course);
  }

  private async about(): Promise<Record<string, About>> {
    return JSON.parse(await readFile(join(this.extensionPath, 'media', 'datalab', 'about.json'), 'utf8'));
  }

  /** Copies the runtime and seeds into the course folder and loads every sample, unless this container already has them. */
  async preload(engine: CourseEngine, names: string[]): Promise<CourseDataset[]> {
    const folder = (...parts: string[]) => join(engine.root, '.datalab', ...parts);
    await mkdir(folder('samples'), {recursive: true});
    const copy = async (from: string, to: string) => {
      const text = await readFile(from, 'utf8');
      if ((await readFile(to, 'utf8').catch(() => null)) !== text) { await writeFile(to + '.tmp', text); await rename(to + '.tmp', to); }
      return text;
    };
    const hash = createHash('sha256').update(await copy(join(this.extensionPath, 'media', 'course', 'data_lab.py'), folder('data_lab.py')));
    for (const name of names) hash.update('\0' + name + '\0' + await copy(join(this.extensionPath, 'media', 'datalab', name + '.sql'), folder('samples', name + '.sql')));
    const key = 'dhimantai.courseData.' + engine.name + '.' + hash.digest('hex').slice(0, 24);
    const cached = this.state.get<Record<string, TableSchema[]>>(key);
    const about = await this.about();
    const out: CourseDataset[] = [];
    for (const name of names) {
      let tables = cached?.[name];
      if (!tables) tables = (await this.lab<{tables: TableSchema[]}>(engine, {op: 'open', dataset: name, source: sampleSource(name)})).tables;
      this.schemas.set('sample:' + name, tables);
      out.push({id: 'sample:' + name, title: about[name]?.title.split(':')[0] ?? name, source: 'sample', about: about[name] ?? {title: name, summary: ''}, tables});
    }
    if (!cached) await this.state.update(key, Object.fromEntries(out.map(d => [d.id.slice(7), d.tables])));
    return out;
  }

  /** The learner's imported files that this notebook uses, read from the course folder. */
  async imports(engine: CourseEngine, names: string[]): Promise<CourseDataset[]> {
    const out: CourseDataset[] = [];
    for (const name of names.filter(n => /^[a-z][a-z0-9_]{0,31}$/.test(n)).slice(0, 10)) {
      try {
        const meta = JSON.parse(await readFile(join(engine.root, '.datalab', 'imports', name + '.meta.json'), 'utf8'));
        const id = 'import:' + name;
        let tables = this.schemas.get(id);
        if (!tables) { tables = (await this.lab<{tables: TableSchema[]}>(engine, {op: 'open', dataset: 'u_' + name, source: importSource(name)})).tables; this.schemas.set(id, tables); }
        out.push({id, title: meta.about.title, source: 'import', about: meta.about, tables});
      } catch { /* a removed or unreadable import is left out; its files stay on disk */ }
    }
    return out;
  }

  /** The query, read-only, as the datalab_reader role with the runtime's timeout and 500-row cap. */
  run(engine: CourseEngine, dataset: CourseDataset, sql: string): Promise<LabReply> {
    const name = dataset.id.split(':')[1];
    return this.lab<LabReply>(engine, {op: 'query', dataset: dataset.source === 'sample' ? name : 'u_' + name,
      source: dataset.source === 'sample' ? sampleSource(name) : importSource(name), sql});
  }

  /** Reads a chosen CSV or Excel file on this computer and returns its preview; nothing is created yet. */
  async preview(engine: CourseEngine, file: string) {
    const extension = extname(file).toLowerCase();
    if (['.xls', '.ods', '.numbers'].includes(extension))
      throw new Error('Course data reads .xlsx and CSV files. In your spreadsheet choose File → Save as → CSV, then import that file.');
    const size = (await stat(file)).size;
    if (size > LIMITS.fileBytes) throw new Error(`The file is ${(size / 1024 / 1024).toFixed(1)} MB; files up to 50 MB can be imported. Import a smaller extract, for example one year or one branch.`);
    const data = await readFile(file);
    let rows: string[][], sheet: string | undefined, note = '';
    if (extension === '.xlsx') {
      const book = await this.lab<{rows: string[][]; sheet: string; sheets: number}>(engine, {op: 'xlsx', data: data.toString('base64')});
      rows = book.rows; sheet = book.sheet;
      if (book.sheets > 1) note = `Only the first sheet, "${book.sheet}", was read. To use another sheet, move it first or save it as CSV.`;
    } else {
      const text = data[0] === 0xff && data[1] === 0xfe ? data.toString('utf16le') : data.toString('utf8');
      if (text.includes('�')) note = 'Some characters could not be read. Save the file as "CSV UTF-8" if names look wrong.';
      rows = parseCsv(text);
    }
    const taken = new Set((await readdir(join(engine.root, '.datalab', 'imports')).catch(() => [] as string[]))
      .filter(f => f.endsWith('.meta.json')).map(f => f.slice(0, -'.meta.json'.length)));
    let name = datasetName(basename(file));
    // Sample names stay the samples'.
    for (let n = 2; taken.has(name) || ['shop', 'school', 'clinic'].includes(name); n++) name = datasetName(basename(file)).slice(0, 29) + '_' + n;
    const plan = planImport(basename(file), rows, sheet);
    if (note) plan.notes.unshift(note);
    plan.table = name;
    this.plan = plan;
    return {fileName: plan.fileName, table: plan.table, sheet: plan.sheet, columns: plan.columns, preview: plan.preview, total: plan.total, notes: plan.notes};
  }

  cancel() { this.plan = undefined; }

  /** Creates the table from the previewed file, beside the samples, and returns the new dataset. */
  async confirm(engine: CourseEngine): Promise<CourseDataset> {
    const plan = this.plan;
    if (!plan) throw new Error('Choose a file to import first.');
    this.plan = undefined;
    const name = plan.table, folder = join(engine.root, '.datalab', 'imports');
    await mkdir(folder, {recursive: true});
    const today = new Date().toISOString().slice(0, 10);
    const about: About = {title: plan.fileName, summary: `Imported from ${plan.fileName}${plan.sheet ? ` (sheet ${plan.sheet})` : ''} on ${today}: `
      + `${plan.total.toLocaleString('en-IN')} rows, ${plan.columns.length} columns, in one table called ${name}.`,
      tables: [{name, description: 'Your imported file, one row per data row.',
        columns: Object.fromEntries(plan.columns.map(c => [c.name, `From the column "${c.original}". Stored as ${c.type}.`]))}],
      gaps: ['Nobody has described what each column means. Check the meaning yourself before trusting an answer.',
        'Column types were guessed. Values that were unclear were kept as text.', ...plan.notes]};
    const write = async (file: string, text: string) => { await writeFile(file + '.tmp', text); await rename(file + '.tmp', file); };
    await write(join(folder, name + '.json'), JSON.stringify({tables: [{name, columns: plan.columns.map(c => ({name: c.name, type: c.type})), rows: plan.rows}]}));
    await write(join(folder, name + '.meta.json'), JSON.stringify({about, created: today, file: plan.fileName}, null, 2));
    this.schemas.delete('import:' + name);
    const [dataset] = await this.imports(engine, [name]);
    if (!dataset) throw new Error('The table could not be created. Try importing the file again.');
    return dataset;
  }
}

const sampleSource = (name: string): LabSource => ({kind: 'sample', path: `/course/.datalab/samples/${name}.sql`});
const importSource = (name: string): LabSource => ({kind: 'import', path: `/course/.datalab/imports/${name}.json`});
