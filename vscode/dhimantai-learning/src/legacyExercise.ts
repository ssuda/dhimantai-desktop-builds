import * as vscode from 'vscode';
import { entryFile } from './learning';
import { EnvironmentName } from './environments';

const decoder = new TextDecoder();

/**
 * Exercise folders from earlier versions reopen in the Practice notebook. The learner's code in the
 * folder seeds the notebook's solution cell when that exercise has no saved notebook yet.
 */
export async function openLegacyExercise(folder: vscode.Uri, environment: () => EnvironmentName) {
  const meta = JSON.parse(decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, '.dhimantai.json'))));
  if (typeof meta?.questionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(meta.questionId)) return;
  if (['production', 'staging', 'development', 'local'].includes(meta.environment) && meta.environment !== environment())
    await vscode.workspace.getConfiguration('dhimantai').update('environment', meta.environment, vscode.ConfigurationTarget.Global);
  let source: string | undefined = typeof meta.synced?.source === 'string' ? meta.synced.source : undefined;
  for (const language of ['python', 'javascript', 'typescript', 'c', 'java', 'go', 'rust']) {
    const saved = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, entryFile(language))).then(b => decoder.decode(b), () => undefined);
    if (saved !== undefined) { source = saved; break; }
  }
  await vscode.commands.executeCommand('dhimantai.openPracticeNotebook', meta.questionId,
    typeof meta.userId === 'string' ? meta.userId : undefined, undefined, undefined, source);
}
