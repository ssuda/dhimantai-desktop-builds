import {createInterface, Interface} from 'node:readline/promises';
import {PassThrough, Writable} from 'node:stream';

/** Python input() and compiled stdio read lines. Node's terminal line editor handles their keys. */
export class ProgramStdin {
  private keys = new PassThrough();
  private output:Writable & {columns:number};
  private editor:Interface;
  private disposed = false;
  constructor(echo:(data:string) => void, send:(line:string|null) => void, interrupt:() => void) {
    this.output = Object.assign(new Writable({write(chunk, _encoding, done) { echo(chunk.toString()); done(); }}), {columns:80});
    this.editor = createInterface({input:this.keys, output:this.output, terminal:true, prompt:'', historySize:0});
    this.editor.on('line', send);
    this.editor.on('SIGINT', interrupt);
    this.editor.on('close', () => { if (!this.disposed) send(null); });
  }
  prompt(text:string) { this.editor.setPrompt(text); }
  write(data:string) { this.keys.write(data); }
  resize(cols:number) { this.output.columns = cols; }
  dispose() { this.disposed = true; this.editor.close(); this.keys.destroy(); this.output.destroy(); }
}
