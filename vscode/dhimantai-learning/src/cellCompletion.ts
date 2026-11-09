import * as vscode from 'vscode';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {cellLanguage} from './roomCode';
import {entryFile,LANGUAGE_EXTENSIONS} from './learning';

/** Forward embedded editor completions to the same extensions used by ordinary source files. */
export async function cellCompletions(folder:string,language:string,source:string,offset:number){
  if(!cellLanguage(language) || source.length>12000 || !Number.isInteger(offset) || offset<0 || offset>source.length)return [];
  const dir=join(folder,'.cell-completions',language);await mkdir(dir,{recursive:true});
  const file=vscode.Uri.file(join(dir,entryFile(language)));
  await writeFile(file.fsPath,source);
  const extension=LANGUAGE_EXTENSIONS[language]?.id;
  if(extension)await vscode.extensions.getExtension(extension)?.activate().then(undefined,()=>undefined);
  let doc=await vscode.workspace.openTextDocument(file);
  if(['bash','zsh','pglab'].includes(language) && doc.languageId!=='shellscript')doc=await vscode.languages.setTextDocumentLanguage(doc,'shellscript');
  // A previously opened mirror may not yet have received the file watcher update.
  if(doc.getText()!==source){const edit=new vscode.WorkspaceEdit();edit.replace(file,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),source);await vscode.workspace.applyEdit(edit);}
  const result=await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider',file,doc.positionAt(offset)).then(value=>value,()=>undefined);
  const items=(result?.items??[]).slice(0,100).map(item=>{
    const label=typeof item.label==='string'?item.label:item.label.label;
    const insert=item.insertText instanceof vscode.SnippetString?item.insertText.value.replace(/\$\{\d+:([^}]*)\}/g,'$1').replace(/\$\d+|\$\{\d+\}/g,''):item.insertText??label;
    const range=item.range instanceof vscode.Range?item.range:item.range?.replacing;
    return {label,apply:insert,detail:item.detail?.slice(0,300),...(range?{from:doc.offsetAt(range.start),to:doc.offsetAt(range.end)}:{})};
  });
  if(['bash','zsh','pglab'].includes(language)){
    const word=/[^\s\"']*$/.exec(source.slice(0,offset))?.[0]??'';
    const prefix=word.includes('/')?word.slice(0,word.lastIndexOf('/')+1):'';
    const target=resolve(folder,prefix),rel=relative(folder,target);
    if(!isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep)){
      for(const file of await readdir(target,{withFileTypes:true}).catch(()=>[])){
        if(file.name.startsWith('.') || !/^[\w.-]+$/.test(file.name))continue;
        const label=prefix+file.name+(file.isDirectory()?'/':'');
        items.push({label,apply:label,detail:'Notebook file',from:offset-word.length,to:offset});
      }
    }
  }
  return items.slice(0,150);
}
