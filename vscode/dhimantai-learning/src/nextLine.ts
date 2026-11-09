import * as vscode from 'vscode';
import { Api } from './api';
import { Auth } from './auth';
import type { TaskRunner } from './task';
import { Environment, EnvironmentName } from './environments';
import { contextFor, learnerCell } from './notebookCommands';
import { ladderToken, rememberLadderToken } from './ladderTokens';
import { checkExplanation } from './learningLoop';

export const wantsNextLine = (message: string) =>
  /^(?:\/nextline|(?:please\s+)?(?:fill(?: in)?|suggest|complete|write) (?:the |my )?next line(?: of code)?)[.!]?$/i.test(message.trim());

/** All code comes from the visible editor buffer, including unsaved edits. */
export function registerNextLine(secrets: vscode.SecretStorage, service: (name: EnvironmentName) => Environment, task: TaskRunner) {
  const decoration = vscode.window.createTextEditorDecorationType({after: {color: new vscode.ThemeColor('editorGhostText.foreground')}});
  let revision = 0;
  let pending: {editor: vscode.TextEditor; range: vscode.Range; text: string; valid: () => boolean;
    auth: Auth; account: string} | undefined;
  let watching: vscode.TextEditor | undefined;
  let sessionWatch: {environment: EnvironmentName; account: string; auth: Auth} | undefined;

  function clear() {
    revision++;
    watching = undefined;
    sessionWatch = undefined;
    if (!pending) return;
    pending.editor.setDecorations(decoration, []);
    pending = undefined;
    void vscode.commands.executeCommand('setContext', 'dhimantai.nextLineVisible', false);
  }

  function target(editor: vscode.TextEditor) {
    if (!vscode.workspace.getConfiguration('dhimantai').get('aiAssistance', true)) return;
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const link = nb && contextFor(nb);
    if (link && nb?.getCells().some(cell => cell.document === editor.document && learnerCell(cell))) {
      return link;
    }
  }

  async function notebookExplanation(source: string) {
    const text = await vscode.window.showInputBox({ title: 'Before a line suggestion', ignoreFocusOut: true,
      prompt: 'In your own words: what should the next line do, and with which names from your code?',
      validateInput: value => checkExplanation(value, source) });
    if (text === undefined) throw new Error('Help cancelled.');
    return text.trim();
  }

  async function suggest() {
    clear();
    const editor = vscode.window.activeTextEditor;
    const link = editor && target(editor);
    if (!editor || !link) throw new Error('Focus a code cell in a linked DhimantAI notebook with AI assistance enabled.');
    const doc = editor.document, pos = editor.selection.active, version = doc.version, request = revision;
    const line = doc.lineAt(pos.line), insertAfter = !!line.text.trim();
    if (editor.selections.length !== 1 || !editor.selection.isEmpty || (insertAfter && !pos.isEqual(line.range.end))) {
      throw new Error('Place one cursor on a blank line or at the end of the preceding line.');
    }
    const lines = doc.getText().split(/\r?\n/), index = pos.line + Number(insertAfter);
    if (insertAfter) lines.splice(index, 0, '');
    const source = lines.join('\n');
    if ([...source].length > 12000) throw new Error('Choose a code cell of up to 12,000 characters.');
    // A suggested line is line-level help: same ladder and explanation first as every other level.
    const explanation = await notebookExplanation(source);
    if (vscode.window.activeTextEditor !== editor || doc.version !== version) throw new Error('The editor changed. Ask for a line again.');
    const tokenKey = link.path;
    watching = editor;
    const valid = () => request === revision && !doc.isClosed && version === doc.version && vscode.window.activeTextEditor === editor &&
      editor.selection.isEmpty && editor.selection.active.isEqual(pos) && JSON.stringify(target(editor)) === JSON.stringify(link);
    const env = service(link.environment);
    const auth = new Auth(secrets, () => link.environment, () => env);
    const session = await auth.session();
    if (!session) throw new Error('Sign in to this exercise’s DhimantAI service before requesting a line.');
    if (!valid()) return;
    sessionWatch = {environment: link.environment, account: session.user.id, auth};
    const api = new Api(auth, () => {
      if (!valid()) throw new Error('The editor changed.');
      return env;
    }, session.user.id);
    const reply = await api.nextLine(link.path, {question: link.question, language: link.language, source, line: index,
      explanation, ladder_token: ladderToken(tokenKey)});
    rememberLadderToken(tokenKey, reply.ladder_token ?? ladderToken(tokenKey));
    if (!valid() || (await auth.session())?.user.id !== session.user.id || !valid()) return;
    if (!reply.code?.trim()) { void vscode.window.showInformationMessage(reply.hint); return; }
    if (/[\r\n\u0000\u2028\u2029]/.test(reply.code) || reply.code.length > 320) throw new Error('Instructor could not suggest a single line. Try again.');
    const range = insertAfter ? new vscode.Range(pos, pos) : line.range;
    const newline = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    pending = {editor, range, text: (insertAfter ? newline : '') + reply.code, valid, auth, account: session.user.id};
    const anchor = insertAfter ? line.range.end : line.range.start;
    editor.setDecorations(decoration, [{range: new vscode.Range(anchor, anchor),
      renderOptions: {after: {contentText: (insertAfter ? '  ↳ ' : '') + reply.code + '   [Tab to insert · Esc to dismiss]'}},
      hoverMessage: reply.explanation}]);
    await vscode.commands.executeCommand('setContext', 'dhimantai.nextLineVisible', true);
  }

  return vscode.Disposable.from(decoration,
    vscode.commands.registerCommand('dhimantai.suggestNextLine', () => task('Suggesting the next line', suggest)),
    vscode.commands.registerCommand('dhimantai.dismissNextLine', clear),
    vscode.commands.registerCommand('dhimantai.acceptNextLine', async () => {
      const p = pending;
      if (!p || !p.valid()) { clear(); return; }
      const session = await p.auth.session();
      if (pending !== p) return;
      if (!p.valid() || session?.user.id !== p.account) { clear(); return; }
      clear();
      if (!await p.editor.edit(edit => edit.replace(p.range, p.text))) {
        void vscode.window.showInformationMessage('The editor changed. Request a fresh line.');
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(editor => { if (watching && watching !== editor) clear(); }),
    vscode.window.onDidChangeTextEditorSelection(e => { if (watching === e.textEditor) clear(); }),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length && watching?.document === e.document) clear(); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('dhimantai.aiAssistance') || e.affectsConfiguration('dhimantai.environment')) clear(); }),
    secrets.onDidChange(async e => {
      const watch = sessionWatch;
      if (!watch || e.key !== 'dhimantai.session.' + watch.environment) return;
      const session = await watch.auth.session().catch(() => undefined);
      if (sessionWatch === watch && session?.user.id !== watch.account) clear();
    }));
}
