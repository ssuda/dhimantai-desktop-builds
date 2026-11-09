import * as vscode from 'vscode';
import { SignInRequired } from './auth';

/**
 * Runs a command's work one at a time: a second command while one is busy says so, a sign-in error
 * offers Sign In, and any other error is shown and logged.
 */
export function taskRunner(output: vscode.OutputChannel) {
  let busy: string | undefined;
  return async (label: string, action: () => Promise<unknown>) => {
    if (busy) { void vscode.window.showInformationMessage(`dhimantAI is busy: ${busy}`); return; }
    busy = label;
    try { await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SignInRequired) {
        void vscode.window.showWarningMessage(message, 'Sign In').then(choice => {
          if (choice) void vscode.commands.executeCommand('dhimantai.signIn');
        });
      } else void vscode.window.showErrorMessage(message);
      output.appendLine(`[error] ${label}: ${message}`);
    } finally { busy = undefined; }
  };
}
export type TaskRunner = ReturnType<typeof taskRunner>;
