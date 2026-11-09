import type { NativeDebugAction, NativeDebugState } from '../src/debugEvidence';

export class NativeDebugControls {
  readonly element = document.createElement('section');
  private state?: NativeDebugState;
  private revision = -1;
  private status = document.createElement('p');
  private buttons: HTMLButtonElement[] = [];
  constructor(action: (action:NativeDebugAction) => void) {
    this.element.className = 'native-debug-controls';
    const title = document.createElement('h4'); title.textContent = 'Practise with the VS Code debugger';
    const instructions = document.createElement('p');
    instructions.textContent = 'Debug this cell as a complete program in a separate file, using its standard input. Other notebook cells are not included. Set a breakpoint in the gutter. Predict a variable’s next value, Step Over, and compare Variables. Step Into a call and inspect Call Stack; add a variable to Watch yourself. Discuss paused state shares the captured line, call stack and local values with Instructor.';
    this.element.append(title,instructions);
    const basics = document.createElement('details'), basicsTitle = document.createElement('summary'), basicsText = document.createElement('p');
    basicsTitle.textContent = 'What do the debugger controls mean?';
    basicsText.textContent = 'A breakpoint pauses before a chosen line runs. Step Over runs the next line without entering its function calls; Step Into follows a call; Step Out finishes the current function and returns to its caller. Variables shows current values. Watch lets you inspect expressions you choose. Call Stack shows which functions called each other. Predict the next change before stepping.';
    basics.append(basicsTitle,basicsText); this.element.append(basics);
    for (const [name,label] of [['start','Debug in VS Code'],['open','Open debug file'],['stop','Stop debugger'],
      ['inspect','Discuss paused state'],['import','Bring changes back']] as const) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet';
      b.textContent = label; b.dataset.debug = name; b.onclick = () => action(name); this.buttons.push(b); this.element.append(b);
    }
    this.status.setAttribute('role','status'); this.element.append(this.status);
  }
  receive(revision:number,state:NativeDebugState) { this.revision = revision; this.state = state; this.status.textContent = state.message; }
  message(text:string) { this.status.textContent = text; }
  update(revision:number, active:boolean, ai:boolean, busy:boolean, code:boolean) {
    const live = this.state && ['starting','running','paused'].includes(this.state.phase);
    for (const b of this.buttons) {
      const action = b.dataset.debug;
      b.disabled = !active || busy || (action === 'start' ? !!live || !code
        : action === 'inspect' ? !ai || this.state?.phase !== 'paused' || this.state.canInspect === false || this.revision !== revision
        : action === 'import' ? !!live || !this.state || this.revision !== revision
        : action === 'stop' ? !live : !this.state);
    }
  }
}
