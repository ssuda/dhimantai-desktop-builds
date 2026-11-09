import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cloneCapstone } from './capstoneRepo';
import { createProject, createReadingProject } from './projectCore';

export function registerCapstone(context: vscode.ExtensionContext) {
  return vscode.commands.registerCommand('dhimantai.startCapstone', async (course?: string) => {
    const project = await vscode.window.showQuickPick([
      {label: 'Read Rich · larger Python repository', description: 'Code reading · real upstream source · guided navigation', id: 'rich-reading'},
      {label: 'Read shelf · smaller guided introduction', description: 'Code reading · map files, follow calls, compare tests', id: 'shelf-reading'},
      {label: 'Build a Course Research Agent', description: 'Python · multi-file project · step-by-step Coach', id: 'course-agent'},
      {label: 'Fix a real repository bug', description: 'Python · shelf capstone · Git investigation', id: 'shelf'},
    ].filter(p => course !== 'engineering-code-reading' || p.id.endsWith('-reading')), {title: 'Start a course project'});
    if (!project) return;
    const parent = await vscode.commands.executeCommand<vscode.Uri>('dhimantai.setupCourse');
    if (!parent) return;
    const destination = join(parent.fsPath, project.id === 'shelf' ? 'shelf-capstone' : project.id === 'course-agent' ? 'course-research-agent' : project.id);
    if (existsSync(destination)) {
      const open = await vscode.window.showWarningMessage('That project folder already exists here.', 'Open it');
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), {forceNewWindow: true});
      return;
    }
    try {
      if (project.id === 'course-agent') await createProject(vscode.Uri.joinPath(context.extensionUri, 'media', 'projects', 'course-agent').fsPath, destination);
      else if (project.id === 'shelf-reading' || project.id === 'rich-reading') await createReadingProject(vscode.Uri.joinPath(context.extensionUri, 'media').fsPath, project.id, destination);
      else await cloneCapstone(vscode.Uri.joinPath(context.extensionUri, 'media', 'capstone', 'shelf.bundle').fsPath, destination);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), {forceNewWindow: true});
  });
}
