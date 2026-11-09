// Exercise real editor configuration and focus events; no Copilot account or model call.
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CopilotPolicy } from '../../src/copilotPolicy';

export async function run(): Promise<void> {
  const results: { step: string; ok: boolean; error?: string }[] = [];
  const panels: vscode.WebviewPanel[] = [];
  const step = async (name: string, body: () => Promise<void>) => {
    try { await body(); results.push({ step: name, ok: true }); }
    catch (error) { results.push({ step: name, ok: false, error: String(error) }); throw error; }
  };
  const setting = () => vscode.workspace.getConfiguration('chat');
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(predicate(), 'Editor configuration settled within five seconds');
  };
  const ext = vscode.extensions.getExtension<{ copilotPolicy: CopilotPolicy }>('optficial.dhimantai-learning')!;
  try {
    const { copilotPolicy } = await ext.activate();
    const desktop = vscode.env.appName === 'dhimantAI';
    await step('defaults disable AI; existing user and workspace preferences are not rewritten', async () => {
      const value = setting().inspect<boolean>('disableAIFeatures');
      assert.equal(value?.defaultValue, true);
      assert.equal(value?.globalValue, false);
      assert.equal(value?.workspaceValue, false);
      await until(() => setting().get('disableAIFeatures') === desktop);
      assert.equal(vscode.workspace.getConfiguration('editor').get('fontSize'), 17);
      if (desktop) assert.equal(vscode.workspace.getConfiguration('workbench.activityBar').get('location'), 'hidden');
    });
    if (!desktop) return;
    const host = vscode.window.createWebviewPanel('dhimantai.copilotTest', 'Course policy test', vscode.ViewColumn.One, {});
    panels.push(host);
    const select = copilotPolicy.bindPanel(host);
    await until(() => host.active);
    await step('only the explicitly approved AI coding course enables Copilot', async () => {
      const changes: boolean[] = [];
      const listener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('chat.disableAIFeatures')) changes.push(setting().get<boolean>('disableAIFeatures')!);
      });
      try {
        await select('Use AI Coding Help with Verification');
        await until(() => setting().get('disableAIFeatures') === false);
        for (const course of ['Python', 'Agentic AI Applications', 'Unknown course', undefined]) {
          await select(course);
          await until(() => setting().get('disableAIFeatures') === true);
        }
        const enabled = changes.indexOf(false);
        assert.ok(enabled >= 0 && changes.slice(enabled + 1).includes(true), 'extensions receive both effective setting transitions');
      } finally {
        listener.dispose();
      }
    });
    await step('switching away from an enabled course disables it and returning restores it', async () => {
      await select('Use AI Coding Help with Verification');
      await until(() => setting().get('disableAIFeatures') === false);
      const other = vscode.window.createWebviewPanel('dhimantai.otherCourse', 'Python', vscode.ViewColumn.One, {});
      panels.push(other); copilotPolicy.bindPanel(other, 'Python');
      await until(() => other.active && setting().get('disableAIFeatures') === true);
      host.reveal();
      await until(() => host.active && setting().get('disableAIFeatures') === false);
    });
    await step('an exercise which disallows assistance overrides the course permission', async () => {
      await select('Use AI Coding Help with Verification', false);
      await until(() => setting().get('disableAIFeatures') === true);
    });
    await step('rapid selections settle on the latest course', async () => {
      await Promise.all([select('Python'), select('Use AI Coding Help with Verification'), select('Python')]);
      await until(() => setting().get('disableAIFeatures') === true);
    });
    await step('unrelated editors do not inherit an enabled course', async () => {
      await select('Use AI Coding Help with Verification');
      await until(() => setting().get('disableAIFeatures') === false);
      const doc = await vscode.workspace.openTextDocument({content: '# Unrelated notes', language: 'markdown'});
      await vscode.window.showTextDocument(doc);
      await until(() => setting().get('disableAIFeatures') === true);
    });
    await step('course changes preserve preferences stored on disk', async () => {
      const file = vscode.workspace.workspaceFile!.fsPath;
      const contents = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(contents.settings['chat.disableAIFeatures'], false);
      contents.settings['editor.fontSize'] = 18;
      writeFileSync(file, JSON.stringify(contents));
      await until(() => vscode.workspace.getConfiguration('editor').get('fontSize') === 18);
      assert.equal(setting().inspect('disableAIFeatures')?.globalValue, false);
      assert.equal(setting().inspect('disableAIFeatures')?.workspaceValue, false);
    });
    await step('Instructor still opens with Copilot disabled', async () => {
      await vscode.commands.executeCommand('dhimantai.openLearningRoom');
      await until(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Instructor notebook')));
      await until(() => setting().get('disableAIFeatures') === true);
    });
  } finally {
    panels.forEach(panel => panel.dispose());
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify(results, null, 2));
  }
}
