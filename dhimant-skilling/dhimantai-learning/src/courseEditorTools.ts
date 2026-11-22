import * as vscode from 'vscode';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {newerDesktopVersion} from './desktopUpdates';

export type EditorTool = {id:string; builtin:true} | {
  id:string; version:string; sha256:string; min_desktop:string; platform:string; dependencies?:string[];
};

export async function activateCourseTools(bundle:string, tools:EditorTool[]=[]) {
  const active=new Set<string>();
  for (const tool of tools) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(tool.id) || active.has(tool.id))
      throw new Error('Invalid or duplicate course editor tool.');
    let extension=vscode.extensions.getExtension(tool.id);
    if ('builtin' in tool) {
      if (!tool.builtin || !extension || !tool.id.startsWith('vscode.')) throw new Error('The desktop is missing '+tool.id);
    } else {
      if(!/^[a-f0-9]{64}$/.test(tool.sha256) || !/^\d+\.\d+\.\d+$/.test(tool.version)
        || newerDesktopVersion(tool.min_desktop,vscode.version) || !['universal',process.platform+'-'+process.arch].includes(tool.platform)
        || tool.dependencies?.some(dep=>!active.has(dep))) throw new Error('The course package is incompatible: '+tool.id);
      const path=join(bundle,'media','course-extensions',tool.sha256+'.vsix');
      const bytes=await readFile(path).catch(()=>undefined);
      if (!bytes || createHash('sha256').update(bytes).digest('hex')!==tool.sha256)
        throw new Error('Restore the course bundle and reopen it to retry '+tool.id+'.');
      if(extension?.packageJSON.version!==tool.version) {
        await vscode.commands.executeCommand('workbench.extensions.installExtension',vscode.Uri.file(path),{installOnlyNewlyAddedFromExtensionPackVSIX:true});
        // Installation completes in the workbench before the extension-host registry updates.
        await new Promise<void>(resolve=>{
          const loaded=()=>vscode.extensions.getExtension(tool.id)?.packageJSON.version===tool.version;
          const done=()=>{listener.dispose();clearTimeout(timer);resolve();};
          const listener=vscode.extensions.onDidChange(()=>{if(loaded())done();});
          const timer=setTimeout(done,12000);
          if(loaded())done();
        });
        extension=vscode.extensions.getExtension(tool.id);
      }
      if(extension?.packageJSON.version!==tool.version)throw new Error('Reopen the workspace to activate '+tool.id+' '+tool.version+'.');
    }
    await extension!.activate();
    active.add(tool.id);
  }
}
