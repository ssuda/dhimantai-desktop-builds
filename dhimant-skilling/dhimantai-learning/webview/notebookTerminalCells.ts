import { isTerminalProgram, terminalPrograms, TerminalProgram } from '../src/notebookTerminal';
import { CellTerminal } from './cellTerminal';
import type { TerminalControl } from '../src/notebookCells';

type Message = {cell:string;id?:string;data?:string;closed?:boolean;error?:string};
type Slot = {program:TerminalProgram; element:HTMLElement; status:HTMLElement; reconnect:HTMLButtonElement; source:string;
  observer:IntersectionObserver; visible:boolean; autoStart:boolean; started:boolean; seeded:boolean; prompt:string; id?:string; terminal?:CellTerminal};

/** Each terminal has its own PTY. Only psql teaching examples prefill the input buffer. */
export class NotebookTerminalCells {
  courseDefault?: TerminalProgram;
  private slots = new Map<string,Slot>();
  private connected = false;
  available = true;
  private activityTimer?:ReturnType<typeof setTimeout>;
  constructor(private connect:(cell:string,program:TerminalProgram)=>void, private input:(cell:string,id:string,control:TerminalControl)=>void,
    private release:(cell:string)=>void, private activity:()=>void = () => {}) {}
  /** Visible terminal screens the Instructor may see alongside the other public notebook cells. */
  screens(limit = 1500) {
    const result:{id:string; program:TerminalProgram; text:string; truncated:boolean}[] = [];
    for (const [key,slot] of this.slots) {
      const id = key.slice(0, key.lastIndexOf(':'));
      if (!slot.terminal || slot.element.hidden || !/^[\w-]{1,100}$/.test(id)) continue;
      const screen = slot.terminal.screen(limit);
      if (screen.text.trim()) result.push({id, program:slot.program, ...screen});
    }
    return result;
  }
  private changed() {
    // Output arrives in bursts; share the screen once it settles rather than per chunk.
    clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => this.activity(), 1500);
  }
  private close(key:string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.observer.disconnect(); slot.terminal?.dispose(); slot.element.remove(); this.slots.delete(key);
    if (slot.started) this.release(key);
  }
  mountPicker(parent:HTMLElement, header:Element, key:string, program:TerminalProgram, source:string,
      focus:boolean, changed:(value:TerminalProgram)=>void, autoStart = false) {
    const picker = document.createElement('select');
    picker.setAttribute('aria-label','Terminal type');
    for (const group of ['Shells','Database clients','Language REPLs']) {
      const options = document.createElement('optgroup'); options.label = group;
      for (const [value,profile] of Object.entries(terminalPrograms))
        if (profile.group === group) options.append(new Option(profile.label,value));
      picker.append(options);
    }
    header.classList.add('terminal-heading'); header.replaceChildren('Terminal', picker);
    let current = '', previous = '';
    const show = (value:TerminalProgram, takeFocus:boolean) => {
      picker.value = value;
      // Switching back to the last program resumes it; anything older is ended so a cell keeps at most two processes.
      const next = key+':'+value;
      if (current && current !== next) {
        if (previous && previous !== next) this.close(previous);
        previous = current; this.changed();
      }
      current = next;
      for (const other of parent.children) (other as HTMLElement).hidden = true;
      this.mount(parent,current,value === 'psql' ? source : '',takeFocus,value,autoStart);
    };
    picker.onchange = () => {
      if (!isTerminalProgram(picker.value)) return;
      show(picker.value,true); changed(picker.value);
    };
    show(program,focus);
  }
  private mount(parent:HTMLElement, key:string, source:string, focus=false, program:TerminalProgram='psql', autoStart=false) {
    const prior = this.slots.get(key);
    if (prior) {
      if (prior.element.parentElement !== parent) parent.append(prior.element);
      prior.element.hidden = false;
      if (focus) (prior.element.querySelector<HTMLElement>('button:not([hidden]), .xterm-helper-textarea') ?? prior.element).focus();
      return prior.element;
    }
    const element = document.createElement('section'), status = document.createElement('span'), reconnect = document.createElement('button');
    const label = terminalPrograms[program].label;
    element.className = 'notebook-terminal-cell'; element.setAttribute('aria-label',source?'PostgreSQL example cell':label+' terminal');
    element.tabIndex = -1;
    status.setAttribute('role','status');status.textContent=this.available?'Starting '+label+'…':'Select a course workstation to use this terminal.';
    reconnect.type='button';reconnect.textContent=program==='psql'?'Reconnect to PostgreSQL':'Restart '+label;reconnect.hidden=true;
    element.append(status,reconnect);parent.append(element);
    const observer = new IntersectionObserver(entries => {
      slot.visible=entries.some(entry=>entry.isIntersecting);
      this.start(key,slot);
    });
    const slot:Slot = {program,element,status,reconnect,observer,source:source.replace(/\r\n?/g,'\n').trimEnd(),visible:false,autoStart,started:false,seeded:false,prompt:''};
    this.slots.set(key,slot);observer.observe(element);
    reconnect.onclick=()=>{
      slot.terminal?.dispose();slot.terminal=undefined;slot.id=undefined;slot.seeded=false;slot.started=false;slot.prompt='';
      reconnect.hidden=true;status.textContent='Starting '+label+'…';element.focus();this.start(key,slot);
    };
    if (focus) queueMicrotask(()=>{if(element.isConnected){element.focus();element.scrollIntoView({block:'nearest'});}});
    return element;
  }
  private start(key:string,slot:Slot) {
    if (!this.connected || !(slot.visible || slot.autoStart) || slot.element.hidden || slot.started || !slot.element.isConnected) return;
    slot.started=true;this.connect(key,slot.program);
  }
  ready(available = true) {
    this.available = this.connected = available;
    for (const [key,slot] of this.slots) {
      if (available) this.start(key,slot);
      else slot.status.textContent = 'Select a course workstation to use this terminal.';
    }
  }
  prune() {
    for(const [key,slot] of this.slots) if(!slot.element.isConnected) {
      slot.observer.disconnect();slot.terminal?.dispose();this.slots.delete(key);if(slot.started)this.release(key);
    }
  }
  reset() {
    this.connected=false;clearTimeout(this.activityTimer);
    for(const [key,slot] of this.slots){slot.observer.disconnect();slot.terminal?.dispose();if(slot.started)this.release(key);}
    this.slots.clear();
  }
  restart(available = true) {
    this.available = this.connected = available;
    for(const slot of this.slots.values()){
      slot.id=undefined;slot.started=slot.seeded=false;slot.prompt='';slot.terminal?.dispose();slot.terminal=undefined;
      slot.reconnect.hidden=true;slot.status.textContent=available?'Starting '+terminalPrograms[slot.program].label+'…':'Select a course workstation to use this terminal.';
    }
    if (available) this.ready();
  }
  receive(msg:Message) {
    const slot=this.slots.get(msg.cell);if(!slot)return;
    if(msg.closed) {
      slot.id=undefined;slot.status.textContent=msg.error||terminalPrograms[slot.program].label+' session closed.';slot.reconnect.hidden=false;
      if(slot.element.contains(document.activeElement))slot.reconnect.focus();return;
    }
    if(!msg.id)return;
    slot.id=msg.id;slot.status.textContent='';
    if(!slot.terminal) {
      slot.terminal=new CellTerminal(slot.element,'',control=>{if(slot.id)this.input(msg.cell,slot.id,control);});
      if(document.activeElement===slot.element)slot.terminal.focus();
    }
    if(!msg.data)return;
    const terminal=slot.terminal;
    this.changed();
    if (!slot.source || slot.seeded) {terminal.write(msg.data);return;}
    slot.prompt=(slot.prompt+msg.data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')).split(/[\r\n]/).at(-1)!.slice(-300);
    terminal.write(msg.data,()=>{
      if(slot.seeded || !slot.id || slot.terminal!==terminal || !/^.+=[*!?]?[#>] $/.test(slot.prompt))return;
      slot.seeded=true;
      if(!terminal.prefill(slot.source)) {slot.status.textContent='This PostgreSQL client could not preload the example.';return;}
      const active=document.activeElement;
      if(slot.visible && (active===document.body || active===slot.element || active?.id==='send'
        || active instanceof HTMLTextAreaElement && active.id==='message' && !active.value))terminal.focus();
    });
  }
}
