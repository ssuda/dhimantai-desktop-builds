// Official language extensions for Rust, Go, Java, C and JavaScript/TypeScript analyse files, not notebook
// cells. For each Practice notebook in those languages we keep one real source file (inside a minimal
// project) whose text is every code cell joined in order, which is exactly the program that runs. The
// extension's diagnostics, completions, hover, signature help and definitions on that file are mapped back
// to the cell and line they came from. Python needs none of this: Pylance supports notebook cells directly.
import * as vscode from 'vscode';
import { posix } from 'node:path';

import { layout, Layout, MIRRORED, MirroredLanguage, scaffold, toCell, toMirror } from './cellLayout';
export { MIRRORED, MirroredLanguage } from './cellLayout';

interface Mirror { folder: vscode.Uri; file?: vscode.Uri; layout: Layout; written?: string; pending?: NodeJS.Timeout }

/**
 * Keep mirrors for notebooks chosen by `wants`, and forward language features between cells and mirrors.
 * `folderFor` names the hidden project folder for a notebook.
 */
export function registerCellMirrors(wants: (doc: vscode.NotebookDocument, language?:string) => MirroredLanguage | undefined,
    folderFor: (doc: vscode.NotebookDocument) => vscode.Uri): vscode.Disposable {
  const mirrors = new Map<string, Mirror>();
  const diagnostics = vscode.languages.createDiagnosticCollection('dhimantai-cells');
  const cellsOf = (doc: vscode.NotebookDocument) => doc.getCells().filter(c => c.kind === vscode.NotebookCellKind.Code
    && !c.metadata?.metadata?.dhimantai_coach_helper && !c.metadata?.metadata?.dhimantai_practice_role);

  const sync = async (doc: vscode.NotebookDocument, now = false, selected?:string) => {
    const language = wants(doc,selected);
    if (!language) return;
    const key = doc.uri.toString()+'|'+language;
    const mirror = mirrors.get(key) ?? {folder:language===wants(doc)?folderFor(doc):vscode.Uri.joinPath(folderFor(doc),language), layout: {text: '', segments: []}};
    mirrors.set(key, mirror);
    mirror.layout = layout(cellsOf(doc).filter(c=>c.document.languageId===language).map(c => ({uri: c.document.uri.toString(), text: c.document.getText()})));
    clearTimeout(mirror.pending);
    const write = async () => {
      const {main, files} = scaffold(language, mirror.layout.text);
      const file = vscode.Uri.joinPath(mirror.folder, main);
      if (mirror.file && mirror.file.toString() !== file.toString()) await vscode.workspace.fs.delete(mirror.file).then(undefined, () => {});
      if (!mirror.file || mirror.file.toString() !== file.toString()) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(mirror.folder, '.gitignore'), Buffer.from('*\n'));
        for (const [name, content] of Object.entries(files)) await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(mirror.folder, name), Buffer.from(content));
      }
      mirror.file = file;
      if (mirror.written !== mirror.layout.text) {
        await vscode.workspace.fs.writeFile(file, Buffer.from(mirror.layout.text));
        mirror.written = mirror.layout.text;
      }
      // An open document is what language servers analyse; opening it does not show an editor.
      const text = await vscode.workspace.openTextDocument(file);
      if (text.getText() !== mirror.layout.text) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); listener.dispose(); resolve(); };
        const listener = vscode.workspace.onDidChangeTextDocument(e => { if (e.document === text && text.getText() === mirror.layout.text) done(); });
        const timer = setTimeout(done, 1500);
      });
      return text;
    };
    if (now) return write();
    mirror.pending = setTimeout(() => { void write(); }, 150);
  };

  /** The mirror document for a cell, up to date with every cell, and the cell's line offset in it. */
  const forCell = async (cell: vscode.TextDocument) => {
    const notebook = vscode.workspace.notebookDocuments.find(n => n.getCells().some(c => c.document === cell));
    if (!notebook || !wants(notebook,cell.languageId)) return;
    const text = await sync(notebook, true,cell.languageId);
    const mirror = mirrors.get(notebook.uri.toString()+'|'+wants(notebook,cell.languageId));
    const start = mirror && toMirror(mirror.layout.segments, cell.uri.toString(), 0);
    if (!text || !mirror || start === undefined) return;
    return {text, mirror, start};
  };
  const mirrorOf = (uri: vscode.Uri) => [...mirrors.values()].find(m => m.file?.toString() === uri.toString());
  const back = (mirror: Mirror, range: vscode.Range) => {
    const a = toCell(mirror.layout.segments, range.start.line), b = toCell(mirror.layout.segments, range.end.line);
    if (!a) return;
    const end = b && b.cell === a.cell ? new vscode.Position(b.line, range.end.character) : new vscode.Position(a.line, range.start.character);
    return {cell: vscode.Uri.parse(a.cell), range: new vscode.Range(a.line, range.start.character, end.line, end.character)};
  };
  const shift = (range: vscode.Range, start: number, sameCell: (r: vscode.Range) => boolean) => {
    const moved = new vscode.Range(range.start.line - start, range.start.character, range.end.line - start, range.end.character);
    return sameCell(range) && moved.start.line >= 0 ? moved : undefined;
  };

  const forwardDiagnostics = (uris: readonly vscode.Uri[]) => {
    for (const uri of uris) {
      const mirror = mirrorOf(uri);
      if (!mirror) continue;
      const byCell = new Map<string, vscode.Diagnostic[]>(mirror.layout.segments.map(s => [s.cell, []]));
      for (const d of vscode.languages.getDiagnostics(uri)) {
        const target = back(mirror, d.range);
        if (!target) continue;
        const copy = new vscode.Diagnostic(target.range, d.message, d.severity);
        Object.assign(copy, {source: d.source, code: d.code, tags: d.tags});
        byCell.get(target.cell.toString())?.push(copy);
      }
      for (const [cell, list] of byCell) diagnostics.set(vscode.Uri.parse(cell), list);
    }
  };

  const selectors = MIRRORED.map(language => ({scheme: 'vscode-notebook-cell', language}));
  const inCell = (start: number, lines: number) => (r: vscode.Range) => r.start.line >= start && r.end.line < start + lines;
  const segmentLines = (mirror: Mirror, cell: vscode.TextDocument) => mirror.layout.segments.find(s => s.cell === cell.uri.toString())?.lines ?? 0;

  const subscriptions: vscode.Disposable[] = [
    diagnostics,
    vscode.languages.onDidChangeDiagnostics(event => forwardDiagnostics(event.uris)),
    vscode.workspace.onDidOpenNotebookDocument(doc => { void sync(doc); }),
    vscode.workspace.onDidChangeNotebookDocument(event => { void sync(event.notebook); }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== 'vscode-notebook-cell') return;
      const notebook = vscode.workspace.notebookDocuments.find(n => n.getCells().some(c => c.document === event.document));
      if (notebook) void sync(notebook,false,event.document.languageId);
    }),
    vscode.workspace.onDidCloseNotebookDocument(doc => {
      for(const [key,mirror] of mirrors){
        if(!key.startsWith(doc.uri.toString()+'|'))continue;
        clearTimeout(mirror.pending);
        mirror.layout.segments.forEach(s=>diagnostics.delete(vscode.Uri.parse(s.cell)));
        mirrors.delete(key);
      }
    }),
    vscode.languages.registerCompletionItemProvider(selectors, {
      async provideCompletionItems(cell, position, _token, context) {
        const found = await forCell(cell);
        if (!found) return;
        const {text, mirror, start} = found, lines = segmentLines(mirror, cell);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',
          text.uri, position.translate(start), context.triggerCharacter);
        const own = inCell(start, lines);
        return new vscode.CompletionList((list?.items ?? []).map(item => {
          const copy = Object.assign(new vscode.CompletionItem(item.label, item.kind), item);
          const range = item.range;
          if (range instanceof vscode.Range) copy.range = shift(range, start, own);
          else if (range) {
            const inserting = shift(range.inserting, start, own), replacing = shift(range.replacing, start, own);
            copy.range = inserting && replacing ? {inserting, replacing} : undefined;
          }
          if (item.textEdit) copy.textEdit = undefined;
          copy.additionalTextEdits = item.additionalTextEdits?.flatMap(edit => {
            const moved = shift(edit.range, start, own);
            return moved ? [new vscode.TextEdit(moved, edit.newText)] : [];
          });
          return copy;
        }), list?.isIncomplete);
      },
    }, '.', ':', '>', '(', '"', '/', '<'),
    vscode.languages.registerHoverProvider(selectors, {
      async provideHover(cell, position) {
        const found = await forCell(cell);
        if (!found) return;
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', found.text.uri, position.translate(found.start));
        if (!hovers?.length) return;
        const own = inCell(found.start, segmentLines(found.mirror, cell));
        const range = hovers.find(h => h.range)?.range;
        return new vscode.Hover(hovers.flatMap(h => h.contents), range && shift(range, found.start, own));
      },
    }),
    vscode.languages.registerSignatureHelpProvider(selectors, {
      async provideSignatureHelp(cell, position, _token, context) {
        const found = await forCell(cell);
        if (!found) return;
        return vscode.commands.executeCommand<vscode.SignatureHelp>('vscode.executeSignatureHelpProvider',
          found.text.uri, position.translate(found.start), context.triggerCharacter);
      },
    }, '(', ','),
    vscode.languages.registerDefinitionProvider(selectors, {
      async provideDefinition(cell, position) {
        const found = await forCell(cell);
        if (!found) return;
        const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider',
          found.text.uri, position.translate(found.start));
        // A definition inside the program points at its cell; library definitions stay where they are.
        return (result ?? []).flatMap(item => {
          const uri = 'targetUri' in item ? item.targetUri : item.uri, range = 'targetUri' in item ? item.targetRange : item.range;
          if (uri.toString() !== found.text.uri.toString()) return [new vscode.Location(uri, range)];
          const target = back(found.mirror, range);
          return target ? [new vscode.Location(target.cell, target.range)] : [];
        });
      },
    }),
  ];
  vscode.workspace.notebookDocuments.forEach(doc => { void sync(doc); });
  return vscode.Disposable.from(...subscriptions);
}

/** The hidden project folder beside a notebook: <folder>/.dhimantai/<notebook name>/. */
export function mirrorFolder(notebook: vscode.Uri): vscode.Uri {
  const name = posix.basename(notebook.path).replace(/\.ipynb$/i, '');
  return vscode.Uri.joinPath(notebook, '..', '.dhimantai', name);
}
