import * as vscode from 'vscode';
import type * as ts from 'typescript';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BufferEdit {from: number; to: number; insert: string}
export interface CellSuggestion {
  label: string; apply: string; from?: number; to?: number; detail?: string; ticket?: string;
}

/** The webview has no TextDocument. Give the desktop TypeScript provider a virtual
 * sibling of Desk.jsx, so imports resolve in the same configured project as the editor.
 * Completion commands that normally modify a VS Code document never cross the bridge. */
export class StudioJsx {
  private readonly sdk: typeof ts;
  private readonly service: ts.LanguageService;
  private readonly file: string;
  private source = '';
  private version = 0;
  private tickets = new Map<string, ts.CompletionEntry>();

  constructor(root: string) {
    this.sdk = require(join(vscode.env.appRoot, 'extensions', 'node_modules', 'typescript', 'lib', 'typescript.js'));
    const sdk = this.sdk;
    const config = join(root, 'jsconfig.json');
    const raw = sdk.readConfigFile(config, sdk.sys.readFile);
    if (raw.error) throw new Error('The starter JavaScript configuration could not be read.');
    const project = () => sdk.parseJsonConfigFileContent(raw.config, sdk.sys, root);
    this.file = join(root, 'resources', 'js', 'dhimantai-cell-' + randomUUID() + '.jsx');
    const snapshot = (path: string) => {
      const text = path === this.file ? this.source : sdk.sys.readFile(path);
      return text === undefined ? undefined : sdk.ScriptSnapshot.fromString(text);
    };
    this.service = sdk.createLanguageService({
      ...sdk.sys, useCaseSensitiveFileNames: () => sdk.sys.useCaseSensitiveFileNames, getCurrentDirectory: () => root,
      getScriptFileNames: () => [...project().fileNames, this.file],
      getCompilationSettings: () => project().options,
      getScriptSnapshot: snapshot,
      getScriptVersion: path => path === this.file ? String(this.version) : String(sdk.sys.getModifiedTime?.(path)?.getTime()),
      getDefaultLibFileName: opts => sdk.getDefaultLibFilePath(opts),
    });
  }

  suggest(source: string, offset: number): CellSuggestion[] {
    this.tickets.clear();
    if (source.length > 12000 || !Number.isInteger(offset) || offset < 0 || offset > source.length) return [];
    this.source = source;
    this.version++;
    const prefix = source.slice(0, offset).match(/[\w$]+$/)?.[0] ?? '';
    const options = this.service.getCompletionsAtPosition(this.file, offset, {includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true});
    return (options?.entries ?? []).filter(e => e.name.toLowerCase().startsWith(prefix.toLowerCase())).slice(0,100).map(entry => {
      const ticket = randomUUID();
      this.tickets.set(ticket, entry);
      const span = entry.replacementSpan ?? options?.optionalReplacementSpan;
      const from = span?.start ?? offset - prefix.length;
      return {ticket, label:entry.name, apply:entry.insertText ?? entry.name, detail:entry.sourceDisplay?.map(d => d.text).join(''),
        from, to:span ? from + span.length : offset};
    });
  }

  async resolve(ticket: string, source: string, offset: number): Promise<BufferEdit[] | undefined> {
    const entry = this.tickets.get(ticket);
    if (!entry || source !== this.source) return;
    if (!entry.hasAction) return [];
    const details = this.service.getCompletionEntryDetails(this.file, offset, entry.name, {}, entry.source,
      {includeCompletionsForModuleExports:true}, entry.data);
    if (!details?.codeActions?.length) return;
    const edits: BufferEdit[] = [];
    for (const action of details.codeActions) {
      if (action.commands?.length) return;
      for (const change of action.changes) {
        if (change.fileName !== this.file || change.isNewFile) return;
        for (const text of change.textChanges) edits.push({from:text.span.start, to:text.span.start+text.span.length, insert:text.newText});
      }
    }
    return edits;
  }

  dispose() { this.tickets.clear(); this.service.dispose(); }
}
