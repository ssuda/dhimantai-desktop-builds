// Practice cells share a notebook workspace. Grading continues to use fresh test environments.
import * as vscode from 'vscode';
import {dirname, basename, join} from 'node:path';
import {createHash} from 'node:crypto';
import {NotebookCells, CellEvent} from './notebookCells';
import {Toolchains} from './localRunner';
import {jupyterMetadata, learnerCell} from './notebookCommands';
import {parseRunInput, practiceLink, sampleFiles} from './practiceIpynb';
import {ENVIRONMENTS} from './environments';
import type {CourseEngine} from './courseEngine';

export type CourseRunner = (doc:vscode.NotebookDocument, language:string)=>Promise<CourseEngine|'setup-pending'|undefined>;
export const PRACTICE_KERNEL='dhimantai-practice';
const live=new Map<string,NotebookCells>();
const liveChanged=new vscode.EventEmitter<void>();
export function registerPracticeKernel(courseRunner:CourseRunner,options:{id?:string;label?:string;lab?:(doc:vscode.NotebookDocument)=>boolean;wants?:(doc:vscode.NotebookDocument)=>boolean;resetEvents?:(reset:()=>void)=>vscode.Disposable[]}={}):vscode.Disposable {
  const kernel=vscode.notebooks.createNotebookController(options.id??PRACTICE_KERNEL,'jupyter-notebook',options.label??'dhimantAI Practice');
  kernel.description='Course container by default; setup and repair complete before the cell starts';
  kernel.supportedLanguages=['python','javascript','typescript','rust','java','c','go','sql','shellscript'];
  kernel.supportsExecutionOrder=true;
  const sessions=new Map<string,NotebookCells>(), running=new Map<string,vscode.NotebookCell>();
  const cancellations=new Map<string,AbortController>();
  let order=0;
  const interrupt=(key:string)=>{cancellations.get(key)?.abort();sessions.get(key)?.stop();};
  kernel.interruptHandler=doc=>interrupt(doc.uri.toString());
  const session=(doc:vscode.NotebookDocument)=>{
    const key=doc.uri.toString();let cells=sessions.get(key);
    if(!cells){
      cells=new NotebookCells(()=>vscode.workspace.getConfiguration('dhimantai').get<Toolchains>('toolchains',{}),
        async language=>{
          const engine=await courseRunner(doc,language);
          if(engine==='setup-pending')throw new Error('The course runtime is being prepared. Run the cell again when setup finishes.');
          if(['sql','pglab'].includes(language) && !engine)throw new Error('Open this database notebook in its course runtime.');
          return engine;
        },async engine=>engine ? join(engine.root,'.dhimantai','notebooks',createHash('sha256').update(doc.uri.toString()).digest('hex').slice(0,24))
          : join(dirname(doc.uri.fsPath),'.dhimantai',basename(doc.uri.fsPath)+'.files'));
      sessions.set(key,cells);
    }
    return cells;
  };
  kernel.executeHandler=async(cells,doc)=>{
    const key=doc.uri.toString();
    if(running.has(key))return;
    for(const cell of cells){
      if(cell.kind!==vscode.NotebookCellKind.Code || !learnerCell(cell))continue;
      const task=kernel.createNotebookCellExecution(cell);task.executionOrder=++order;task.start(Date.now());
      const runner=session(doc);running.set(key,cell);live.set(key,runner);liveChanged.fire();
      const abort=new AbortController();cancellations.set(key,abort);const cancel=task.token.onCancellationRequested(()=>abort.abort());
      let outputs:Promise<unknown>=Promise.resolve(),ok=false;
      const streamed=new Set<string>();
      try {
        await task.clearOutput();
        if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before running code.');
        const link=practiceLink(jupyterMetadata(doc),Object.keys(ENVIRONMENTS));
        const selected=cell.document.languageId;
        const authored=cell.metadata?.metadata?.dhimantai?.language??cell.metadata?.dhimantai?.language;
        const language=selected==='shellscript' ? (['zsh','pglab'].includes(authored)?authored:link?.language==='pglab'?'pglab':'bash') : selected;
        const inputCell=doc.getCells().find(c=>c.metadata?.metadata?.dhimantai_practice_role==='input');
        const input=inputCell?parseRunInput(inputCell.document.getText()):{argv:[],stdin:''};
        const event=(event:CellEvent)=>{
          if(event.kind==='input'){
            void vscode.window.showInputBox({prompt:event.prompt,ignoreFocusOut:true}).then(answer=>{if(running.get(key)===cell)runner.input(answer??null);});
            return;
          }
          let items:vscode.NotebookCellOutputItem[]=[];
          if(event.kind==='stream'){streamed.add(event.stream);items=[event.stream==='stderr'?vscode.NotebookCellOutputItem.stderr(event.text):vscode.NotebookCellOutputItem.stdout(event.text)];}
          if(event.kind==='display')items=Object.entries(event.data).map(([mime,value])=>mime.startsWith('image/') && mime!=='image/svg+xml'
            ?new vscode.NotebookCellOutputItem(Buffer.from(value,'base64'),mime):vscode.NotebookCellOutputItem.text(value,mime));
          if(items.length)outputs=outputs.then(()=>task.appendOutput(new vscode.NotebookCellOutput(items)));
        };
        // Compiled cells form one program. Python, shell and database cells execute in their existing session.
        const source=['python','sql','bash','zsh','pglab'].includes(language)?cell.document.getText():doc.getCells()
          .filter(c=>c.index<=cell.index && learnerCell(c) && c.document.languageId===selected).map(c=>c.document.getText()).join('\n\n');
        const result=await runner.run(language,source,input.stdin,{...input,files:link?sampleFiles(link.tests):[],
          setup:link?.dataset,database:link?.language==='pglab'||options.lab?.(doc)?'lab':undefined,
          interactive:cell.metadata?.metadata?.dhimantai_interactive ?? !input.stdin,signal:abort.signal,event});
        await outputs;ok=result.status==='exited' && result.exit_code===0;
        for(const stream of ['stdout','stderr'] as const){
          if(result[stream] && !streamed.has(stream))await task.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem[stream](result[stream])]));
        }
        if(result.status==='cancelled')await task.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr('Stopped.')]));
      }catch(error){await task.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(error instanceof Error?error.message:String(error))]));}
      finally{try{await outputs;}finally{cancel.dispose();cancellations.delete(key);running.delete(key);if(live.get(key)===runner)live.delete(key);liveChanged.fire();task.end(ok,Date.now());}}
      if(!ok || abort.signal.aborted)break;
    }
  };
  const send=options.id?new vscode.Disposable(()=>{}):vscode.commands.registerCommand('dhimantai.cellInput',async()=>{
    const doc=vscode.window.activeNotebookEditor?.notebook;if(!doc)return;
    const runner=live.get(doc.uri.toString());if(!runner)return;
    const answer=await vscode.window.showInputBox({prompt:'Input for the running cell (Cancel sends end of input)',ignoreFocusOut:true});runner.input(answer??null);
  });
  const closed=vscode.workspace.onDidCloseNotebookDocument(doc=>{interrupt(doc.uri.toString());sessions.get(doc.uri.toString())?.restart();sessions.delete(doc.uri.toString());});
  const reset=()=>{cancellations.forEach(c=>c.abort());sessions.forEach(s=>s.restart());sessions.clear();};
  const prefer=(doc:vscode.NotebookDocument)=>{if(options.wants?.(doc))kernel.updateNotebookAffinity(doc,vscode.NotebookControllerAffinity.Preferred);};
  vscode.workspace.notebookDocuments.forEach(prefer);
  const opened=vscode.workspace.onDidOpenNotebookDocument(prefer);
  const selected=kernel.onDidChangeSelectedNotebooks(({notebook,selected})=>{if(!selected){interrupt(notebook.uri.toString());sessions.get(notebook.uri.toString())?.restart();sessions.delete(notebook.uri.toString());}});
  const status=options.id?new vscode.Disposable(()=>{}):vscode.notebooks.registerNotebookCellStatusBarItemProvider('jupyter-notebook',{
    onDidChangeCellStatusBarItems:liveChanged.event,
    provideCellStatusBarItems(cell){
      if(!live.has(cell.notebook.uri.toString()))return;
      const item=new vscode.NotebookCellStatusBarItem('$(keyboard) Input',vscode.NotebookCellStatusBarAlignment.Left);
      item.command='dhimantai.cellInput';item.tooltip='Send input to a running program';return item;
    }
  });
  return vscode.Disposable.from(kernel,send,closed,opened,selected,status,...(options.resetEvents?.(reset)??[]),new vscode.Disposable(reset));
}
