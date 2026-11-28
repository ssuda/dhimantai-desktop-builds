import type {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type {TerminalControl} from '../src/notebookCells';

/** Keyboard input and terminal replies go straight to the course process's PTY. */
export class CellTerminal {
  readonly element = document.createElement('div');
  private readonly terminal:Terminal;
  private readonly observer:ResizeObserver;
  private readonly themeObserver:MutationObserver;
  constructor(parent:HTMLElement, initialText:string, send:(control:TerminalControl) => void) {
    this.element.className = 'cell-terminal';
    parent.append(this.element);
    const style = getComputedStyle(this.element);
    // Load the renderer only when a program actually opens its terminal.
    const {Terminal} = require('@xterm/xterm') as typeof import('@xterm/xterm');
    const theme = () => ({background:style.backgroundColor, foreground:style.color, cursor:style.color});
    this.terminal = new Terminal({cols:80, rows:16, scrollback:4000, cursorBlink:true, screenReaderMode:true,
      fontFamily:style.fontFamily, fontSize:parseFloat(style.fontSize),
      minimumContrastRatio:4.5, theme:theme()});
    this.themeObserver = new MutationObserver(() => { this.terminal.options.theme = theme(); });
    this.themeObserver.observe(document.body, {attributes:true, attributeFilter:['data-vscode-theme-id']});
    const fit = new FitAddon();
    this.terminal.loadAddon(fit);
    this.terminal.open(this.element);
    this.terminal.onData(data => {
      // Bound messages from a large paste without splitting Unicode code points.
      for (const part of data.match(/[\s\S]{1,2048}/gu) ?? []) send({data:part});
    });
    this.terminal.onResize(({cols, rows}) => send({cols, rows}));
    const resize = () => {
      const size = fit.proposeDimensions();
      if (size && this.element.clientWidth) this.terminal.resize(Math.min(500, size.cols), Math.min(200, size.rows));
    };
    this.observer = new ResizeObserver(resize);
    this.observer.observe(this.element);
    resize();
    this.terminal.write(initialText.replace(/\r?\n/g, '\r\n'));
  }
  write(data:string, done?:()=>void) { this.terminal.write(data,done); }
  prefill(source:string) {
    // An unbracketed multiline paste would submit lines before the learner presses Enter.
    if (!this.terminal.modes.bracketedPasteMode || /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/.test(source)) return false;
    this.terminal.paste(source);return true;
  }
  /** The visible tail of the screen as plain text: what the learner typed and what came back. */
  screen(limit:number) {
    const buffer = this.terminal.buffer.active, lines:string[] = [];
    for (let i = Math.max(0, buffer.length - 400); i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    const text = lines.join('\n');
    return {text:text.slice(-limit), truncated:text.length > limit || buffer.length > 400};
  }
  focus() { this.terminal.focus(); }
  dispose() { this.observer.disconnect(); this.themeObserver.disconnect(); this.terminal.dispose(); this.element.remove(); }
}
