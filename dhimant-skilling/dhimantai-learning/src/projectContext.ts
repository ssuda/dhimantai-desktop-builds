import { realpath, stat } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { ProjectSource } from './projectCore';

// Keep this in step with the server's public_path validator. No workspace crawl or
// model-selected arbitrary path: candidates come from the installed project manifest
// and bounded public source/test/fixture folders in projectFiles.
const SOURCE_SUFFIX = '(?:py|pyi|php|java|kt|swift|c|h|cpp|cc|cxx|hpp|hh|hxx|rs|go|js|mjs|cjs|ts|tsx|jsx)';
// Files named for stored secrets (credentials, secrets, passwords), secret-named folders and data files stay private;
// a source module such as auth/tokens.py or config/env.py is shared (pasted credentials redacted below) because that is
// where security teaching happens. Mirrors agent public_path.
const SECRET_PATH = new RegExp('(?:^|/)(?:credentials?|secrets?|passwords?)(?:\\.[^/]*)?(?:/|$)'
  + '|(?:^|/)(?:tokens?|private|env|keys?)(?:/|(?:\\.(?!' + SOURCE_SUFFIX + '$)[^/]*)?$)'
  + '|\\.env[^/]*(?:/|$)|[^/]*\\.(?:pem|key)(?:/|$)|id_rsa[^/]*(?:/|$)|service_account[^/]*(?:/|$)'
  + '|[^/]*_(?:credentials|token|secret|key)\\.(?!' + SOURCE_SUFFIX + '$)[^/.]+$', 'i');
/** CI workflows are the deployment evidence most projects have; the only dot-folder accepted. */
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/;
export function publicContextPath(path: string) {
  return path.length <= 160 && !path.includes('\\') && !path.includes(':') &&
    (WORKFLOW_PATH.test(path) || path.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))) &&
    (/\.(py|php|java|kt|kts|swift|xml|c|h|cpp|cc|cxx|hpp|hh|hxx|rs|go|js|mjs|cjs|ts|tsx|jsx|html|css|sql|md|json|toml|txt|rst|csv|tsv|yaml|yml)$/.test(path) ||
      /(?:^|\/)(?:Dockerfile(?:\.(?!(?:pem|key|env)$)[A-Za-z0-9_-]+)?|Caddyfile|Makefile|Procfile|alembic\.ini)$/i.test(path)) &&
    !SECRET_PATH.test(path);
}

// Path filtering cannot see a key pasted into a learner's file or unsaved buffer. Redact
// likely credentials from every excerpt; each replacement keeps the original line breaks.
const secretPatterns: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    (match, body: string, end: string) => match.slice(0, match.length - body.length - end.length)
      + (body.includes('\n') ? body.replace(/[^\r\n]+/g, '[redacted]') : '[redacted]') + end],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, () => '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, () => '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => '[redacted]'],
  [/(\b[A-Za-z0-9_]*(?:api_?key|secret|token|password|passwd)["']?\s*[=:]\s*)(["'])[^"'\r\n]{8,}\2/gi,
    (_match, prefix: string, quote: string) => prefix + quote + '[redacted]' + quote],
];
export function redactSecrets(text: string) {
  for (const [pattern, replace] of secretPatterns) text = text.replace(pattern, replace as (...args: any[]) => string);
  return text;
}

/** Explain, in plain words and naming the file where possible, why the project snapshot failed. */
export async function projectContextProblem(error: unknown, root: string, paths: string[] | undefined, open = new Map<string, string>(), fileLimit = 64) {
  const message = error instanceof Error ? error.message : String(error);
  const lead = 'The Instructor cannot read this project right now, so shared files and milestone evidence are paused. ';
  const find = async (test: (path: string) => Promise<boolean>) => {
    for (const path of paths ?? []) if (await test(path).catch(() => false)) return path;
  };
  if (/too many public project/i.test(message))
    return lead + `The project has more public source, test and data files than the Instructor can read (${fileLimit}). Move extra files out of the source, test and data folders.`;
  if (/too deeply nested/i.test(message))
    return lead + 'A source folder is nested more than 8 levels deep. Move those files closer to the project folder.';
  if (/linked files/i.test(message)) {
    const canonical = await realpath(root).catch(() => root);
    const linked = await find(async path => await realpath(join(root, path)) !== resolve(canonical, path));
    return lead + (linked ? `${linked} is a link to another file. ` : 'A project file is a link to another file. ')
      + 'The Instructor reads regular files. Replace the link with a copy of the file.';
  }
  if (/smaller than 512 KB|too large/i.test(message)) {
    const large = await find(async path => (open.get(path)?.length ?? 0) > 512000 || (await stat(join(root, path))).size > 512000);
    if (large) return lead + `${large} is larger than 512 KB. Move large data out of the project folders or shorten the file.`;
    if (/too large/i.test(message)) return lead + 'Together, the project files are larger than 8 MB. Move large data files out of the project folders.';
  }
  return lead + message;
}

export interface ProjectStructure { files: string[]; total_files: number; truncated: boolean }
export interface ProjectLineSelection { path: string; start: number; end: number }
const stopWords = new Set(('the this that these those what which where when why how does do can could would should '
  + 'please help explain understand file files source code project test tests data function current with from into '
  + 'and are for have has not about here there then their them your using used result line '
  + 'follow method next its now one call some more also need want see tell show').split(' '));
const words = (value: string) => [...new Set(value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  .split(/[^a-z0-9_]+/).flatMap(word => [word, ...word.split('_')])
  .filter(word => word.length >= 3 && !stopWords.has(word)))].slice(0, 40);
const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, '').replace(/^test_/, '');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, value: string) => new RegExp('(?<![\\w/])' + escape(value) + '(?![\\w/])', 'i').test(text);

/** Deterministic local retrieval: paths/symbols, then callers, matching tests and fixtures. */
export function selectProjectContext(all: Map<string, string>, focus: string[], question = '',
    locations: Record<string, number | string> = {}, selection?: ProjectLineSelection) {
  const paths = [...all.keys()].filter(publicContextPath).sort(), terms = words(question);
  const tokens = new Map(paths.map(path => [path, new Set(words(path))]));
  const matches = new Map(paths.map(path => [path, terms.filter(term =>
    new RegExp('\\b' + escape(term) + '\\b', 'i').test(all.get(path)!))]));
  const frequency = new Map(terms.map(term => [term, paths.filter(path => matches.get(path)!.includes(term)).length]));
  const scores = new Map(paths.map(path => {
    const named = mentions(question, path) || mentions(question, posix.basename(path));
    const score = (named ? 1000 : 0) + (focus[0] === path ? 300 : focus.includes(path) ? 60 : 0)
      + terms.reduce((sum, term) => sum + (tokens.get(path)!.has(term) ? 70 : 0), 0)
      + terms.reduce((sum, term) => sum + (new RegExp('^\\s*(?:async\\s+)?(?:def|class)\\s+' + escape(term) + '\\b', 'mi').test(all.get(path)!) ? 250 : 0), 0)
      + matches.get(path)!.reduce((sum, term) => sum + 100 / Math.max(1, frequency.get(term)!), 0);
    return [path, score] as const;
  }));
  const ranked = () => [...paths].sort((a, b) => scores.get(b)! - scores.get(a)! ||
    (focus.indexOf(a) < 0 ? 1000 : focus.indexOf(a)) - (focus.indexOf(b) < 0 ? 1000 : focus.indexOf(b)) || a.localeCompare(b));
  // One bounded hop, so unrelated dependency graphs cannot consume the context.
  const seeds = ranked().filter(path => scores.get(path)! > 0).slice(0, 3);
  for (const path of paths) for (const seed of seeds) {
    if (path === seed) continue;
    const name = stem(path), source = all.get(seed)!;
    const related = name !== '__init__' && name !== '__main__' && (name === stem(seed) ||
      new RegExp('(?:from|import)\\s+[^\\n]*\\b' + escape(name) + '\\b').test(source) ||
      source.includes(path) || source.includes(posix.basename(path)));
    if (related) scores.set(path, scores.get(path)! + 120);
  }
  const ordered = ranked();
  // Related files support the strongest direct match; they must not replace it
  // simply because several seed files import the same helper or test subject.
  if (seeds[0]) { ordered.splice(ordered.indexOf(seeds[0]), 1); ordered.unshift(seeds[0]); }
  const selected = selection && ordered.includes(selection.path) ? selection : undefined;
  if (selected) {
    if (selected.start > 100000) throw new Error('The selected lines are beyond the project excerpt limit.');
    ordered.splice(ordered.indexOf(selected.path), 1);
    ordered.unshift(selected.path);
  }
  // README accompanies every question, while the question's strongest match stays first.
  const readme = paths.find(path => /^README\.(md|rst|txt)$/i.test(path));
  if (readme && ordered.indexOf(readme) > 2) { ordered.splice(ordered.indexOf(readme), 1); ordered.splice(2, 0, readme); }
  const chosen = ordered.slice(0, 12), files: ProjectSource[] = [];
  let budget = 20000; // Serialized bytes, including escaped source and per-file metadata.
  for (const [index, path] of chosen.entries()) {
    // Redact before slicing so an excerpt boundary cannot expose part of a key.
    const source = redactSecrets(all.get(path)!), lines = source.split('\n'), location = locations[path];
    const reference = question.match(new RegExp('(?:' + escape(path) + '|' + escape(posix.basename(path)) + ')(?::|#L)(\\d+)', 'i'));
    const lineScores = lines.map(line => terms.reduce((sum, term) => sum +
      (new RegExp('\\b' + escape(term) + '\\b', 'i').test(line) ?
        (/^\s*(?:async\s+)?(?:def|class)\s/.test(line) ? 4 : 1) / Math.max(1, frequency.get(term)!) : 0), 0));
    const best = lineScores.reduce((highest, score) => Math.max(highest, score), 0);
    const target = reference ? Number(reference[1]) - 1 : best > 0 ? lineScores.indexOf(best)
      : typeof location === 'string' ? Math.max(0, lines.findIndex(line => line.includes(location)))
      : (location ?? 1) - 1;
    const highlighted = selected?.path === path ? selected : undefined;
    let start = highlighted ? highlighted.start - 1 : Math.max(0, Math.min(target, lines.length - 1, 99999) - 8);
    const allowance = Math.min(6500, budget - (chosen.length - index - 1) * 1000);
    let text = lines.slice(start, highlighted?.end).join('\n').slice(0, 6000);
    const file = () => ({path, text, truncated: start > 0 || text.length < source.length, start_line: start + 1});
    while (Buffer.byteLength(JSON.stringify(file())) > allowance) text = text.slice(0, -100);
    if (!highlighted && target < lines.length && target <= 99999 && text.split('\n').length <= target - start) {
      // Long preceding lines must not displace the symbol the learner asked about.
      start = Math.max(0, target); text = lines.slice(start).join('\n').slice(0, 6000);
      while (Buffer.byteLength(JSON.stringify(file())) > allowance) text = text.slice(0, -100);
    }
    // Don't cut a UTF-16 surrogate pair at an excerpt boundary.
    text = text.replace(/[\uD800-\uDBFF]$/, '');
    files.push(file()); budget -= Buffer.byteLength(JSON.stringify(file())) + 2;
  }
  const omitted = ordered.filter(path => !chosen.includes(path));
  // Include an example from each top-level folder before filling the bounded map.
  const representatives = [...new Map(paths.map(path => [path.includes('/') ? path.split('/')[0] : path, path])).values()];
  const overview: string[] = [];
  for (const path of [...new Set([...chosen, ...representatives, ...paths])]) {
    if (overview.length >= 100 || Buffer.byteLength(JSON.stringify([...overview, path])) > 4000) continue;
    overview.push(path);
  }
  const structure: ProjectStructure = {files: overview.sort(), total_files: paths.length, truncated: overview.length < paths.length};
  const first = files[0];
  const sharedSelection = selected && first ? {...selected, end: first.start_line + first.text.split('\n').length - 1} : undefined;
  return {files, omitted: omitted.slice(0, 30), omitted_count: omitted.length, structure, selection:sharedSelection};
}

/** Only turn citations into navigation when the cited line was actually shared on this turn. */
export function projectReferences(answer: string, line: number | null, files: ProjectSource[]) {
  const references: {path:string; line:number}[] = [];
  const add = (path: string, line: number) => {
    const file = files.find(file => file.path === path);
    if (file && Number.isSafeInteger(line) && line >= file.start_line && line < file.start_line + file.text.split('\n').length &&
        references.length < 8 && !references.some(ref => ref.path === path && ref.line === line)) references.push({path, line});
  };
  for (const match of answer.matchAll(/(?<![\w./-])([\w.-]+(?:\/[\w.-]+)*):([1-9]\d*)\b/g)) add(match[1], Number(match[2]));
  if (line && files[0]) add(files[0].path, line);
  return references;
}
