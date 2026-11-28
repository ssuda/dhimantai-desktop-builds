import {Terminal} from '@xterm/headless';

/** Turn PTY redraws, backspaces and wrapped rows into the output the Instructor reviews. */
export class CellTerminalTranscript {
  private screen = new Terminal({allowProposedApi:true, cols:80, rows:16, scrollback:4000});
  private firstLine = this.screen.registerMarker();
  write(data:string) { this.screen.write(data); }
  resize(cols:number, rows:number) { this.screen.resize(cols, rows); }
  async finish() {
    await new Promise<void>(done => this.screen.write('', done));
    const buffer = this.screen.buffer.active;
    const end = Math.max(buffer.baseY + buffer.cursorY, 0);
    const lines:string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)!;
      const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
      if (i > end && !text) continue;
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const text = lines.join('\n');
    const truncated = this.firstLine?.isDisposed || text.length > 200000;
    this.screen.dispose();
    return {text:text.slice(-200000), truncated};
  }
}
