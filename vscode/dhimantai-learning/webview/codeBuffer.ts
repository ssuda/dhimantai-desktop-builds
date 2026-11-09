import { basicSetup, EditorView } from 'codemirror';
import { autocompletion, acceptCompletion, completionStatus, startCompletion, CompletionContext } from '@codemirror/autocomplete';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { sql } from '@codemirror/legacy-modes/mode/sql';
import { go } from '@codemirror/legacy-modes/mode/go';

const languages = {python: python(), javascript: javascript(), typescript: javascript({typescript: true}),
  java: java(), c: cpp(), rust: rust(), go: StreamLanguage.define(go),sql:StreamLanguage.define(sql({})),bash:StreamLanguage.define(shell),zsh:StreamLanguage.define(shell),pglab:StreamLanguage.define(shell)};
const theme = EditorView.theme({
  '&': {backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)'},
  '.cm-scroller': {fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 14px)', maxHeight: '24em'},
  '.cm-content': {minHeight: '7em', caretColor: 'var(--vscode-editorCursor-foreground)'},
  '.cm-gutters': {backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none'},
  '.cm-activeLine, .cm-activeLineGutter': {backgroundColor: 'var(--vscode-editor-lineHighlightBackground)'},
  '&.cm-focused': {outline: '1px solid var(--vscode-focusBorder)'},
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {backgroundColor: 'var(--vscode-editor-selectionBackground)'},
});
const colors = HighlightStyle.define([
  {tag: tags.keyword, class:'syntax-keyword'},
  {tag: tags.variableName, class:'syntax-variable'},
  {tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class:'syntax-function'},
  {tag: [tags.typeName, tags.className], class:'syntax-type'},
  {tag: tags.string, class:'syntax-string'},
  {tag: [tags.number, tags.bool, tags.null], class:'syntax-number'},
  {tag: tags.operator, class:'syntax-operator'},
  {tag: tags.comment, class:'syntax-comment'},
]);

export class CodeBuffer {
  readonly view: EditorView;
  private readonly writable = new Compartment();
  private enabled = true;
  constructor(parent: HTMLElement, source: string, language: string, changed: () => void, focused: () => void, complete?:(source:string,offset:number)=>Promise<{label:string;apply:string;detail?:string;from?:number;to?:number}[]>) {
    this.view = new EditorView({parent, state: EditorState.create({doc: source, extensions: [
      basicSetup, languages[language as keyof typeof languages],
      autocompletion({override:[async(context:CompletionContext)=>{
        const word=context.matchBefore(/[\w$./-]+/);if(!word && !context.explicit)return null;
        const source=context.state.doc.toString(),from=word?.from??context.pos;
        const items=await complete?.(source,context.pos)??[];
        const words=[...new Set(source.match(/[a-zA-Z_][\w]*/g)??[])];
        const shellWords=['cd','ls','pwd','echo','export','source','git','python','pip','npm','make','psql','pg_ctl','pg_dump','pg_restore','createdb','sudo','mkdir','cat','grep'];
        const sqlWords=['SELECT','FROM','WHERE','JOIN','GROUP BY','ORDER BY','CREATE TABLE','INSERT INTO','UPDATE','DELETE FROM','BEGIN','COMMIT','ROLLBACK','EXPLAIN'];
        const fallback=[...new Set([...words,...(['bash','zsh','pglab'].includes(language)?shellWords:language==='sql'?sqlWords:[])])];
        return {from,options:[...items.map(item=>({...item,apply:(view:EditorView)=>{view.dispatch({changes:{from:item.from??from,to:item.to??context.pos,insert:item.apply},selection:{anchor:(item.from??from)+item.apply.length}});}})),
          ...fallback.filter(label=>label!==word?.text && !items.some(item=>item.label===label)).map(label=>({label,type:'text'}))]};
      }]}),
      Prec.highest(keymap.of([{key:'Tab',run:view=>completionStatus(view.state)==='active'?acceptCompletion(view):/[\w$./-]$/.test(view.state.doc.sliceString(view.state.doc.lineAt(view.state.selection.main.head).from,view.state.selection.main.head))?startCompletion(view):false},indentWithTab])), theme, syntaxHighlighting(colors),
      EditorView.contentAttributes.of({'aria-label': language + ' code', spellcheck: 'false'}),
      this.writable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
      EditorState.transactionFilter.of(transaction => transaction.newDoc.length > 12000 ? [] : transaction),
      EditorView.updateListener.of(update => { if (update.docChanged) changed(); if (update.focusChanged && update.view.hasFocus) focused(); }),
    ]})});
  }
  get value() { return this.view.state.doc.toString(); }
  set disabled(value: boolean) {
    if (value === !this.enabled) return;
    this.enabled = !value;
    this.view.dispatch({effects: this.writable.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)])});
  }
  destroy() { this.view.destroy(); }
}
