import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { restoreEmptyCapstone } from './capstoneRepo';
import { createProject, createReadingProject, createShelfProject } from './projectCore';
import { projectWorkspace } from './projectWorkspace';
import { projectSetupError, validateProjectWorkspace } from './projectSetup';
import { CATALOG_PROJECTS } from './catalogProjects';

export async function openProject(context: vscode.ExtensionContext, title: string, destination: string, created: boolean) {
  const choice = await vscode.window.showInformationMessage(`${title} — ${created ? 'project created' : 'project ready'}`,
    {modal: true, detail: `${created ? 'Created project folder' : 'Existing project folder'}:\n${destination}\n\nOpen in a new window to keep your current workspace open. Open in the current window to replace this workspace with the project.`},
    'Open in New Window', 'Open in Current Window');
  if (!choice) return;
  try {
    const workspace = await projectWorkspace(context.globalStorageUri.fsPath, destination, title);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspace),
      choice === 'Open in New Window' ? {forceNewWindow: true} : {forceReuseWindow: true});
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not open ${title}. Your project is saved at "${destination}". ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function registerCapstone(context: vscode.ExtensionContext) {
  return vscode.commands.registerCommand('dhimantai.startCapstone', async (target?: string) => {
    const selected = CATALOG_PROJECTS.find(p => p.id === target);
    if (target && target !== 'engineering-code-reading' && !selected) return;
    const project = selected ?? await vscode.window.showQuickPick(CATALOG_PROJECTS
      .filter(p => target !== 'engineering-code-reading' || p.id.endsWith('-reading'))
      .map(p => ({...p, label: p.title, description: `${p.difficulty} · Estimated ${p.estimatedTime}`})),
    {title: 'Start a course project'});
    if (!project) return;
    let destination = '';
    try {
      const parent = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse');
      if (!parent) return;
      destination = join(parent.fsPath, project.id === 'shelf' ? 'shelf-capstone' : project.id === 'course-agent' ? 'course-research-agent' : project.id);
      const media = vscode.Uri.joinPath(context.extensionUri, 'media').fsPath;
      if (existsSync(destination)) {
        if (project.id === 'rich-reading') await restoreEmptyCapstone(
          vscode.Uri.joinPath(context.extensionUri, 'media', 'projects', 'rich.bundle').fsPath, destination);
        await validateProjectWorkspace(media, project.id, destination);
        await openProject(context, project.title, destination, false);
        return;
      }
      // Each project is built in a private sibling folder and moved into place only when complete.
      if (project.id === 'course-agent') await createProject(vscode.Uri.joinPath(context.extensionUri, 'media', 'projects', 'course-agent').fsPath, destination);
      else if (project.id === 'shelf-reading' || project.id === 'rich-reading') await createReadingProject(media, project.id, destination);
      else await createShelfProject(media, destination);
      await validateProjectWorkspace(media, project.id, destination);
      await openProject(context, project.title, destination, true);
    } catch (error) {
      void vscode.window.showErrorMessage(destination ? projectSetupError(destination, error)
        : `Could not set up the course runtime. ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  });
}
