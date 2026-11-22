import * as vscode from 'vscode';
import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type { CourseEngine } from './courseEngine';
import { run } from './podman';
import { previewUrl } from './skilling';

export async function openAppBesideLesson(url: string) {
  if ((await vscode.commands.getCommands(true)).includes('workbench.action.browser.open')) {
    await vscode.commands.executeCommand('workbench.action.browser.open', {url, openToSide:true, reuseUrlFilter:url});
  } else {
    await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url), {viewColumn:vscode.ViewColumn.Two});
  }
}

/** The starter signals an explicit run. Resolve the URL from Podman, then wait for HTTP readiness. */
export function watchAppRuns(engine: CourseEngine, port: number, check: () => Promise<void>, report: (s: string) => void) {
  const marker = join(engine.root, '.dhimantai', 'preview-' + port);
  const since = Date.now();
  let generation = 0;
  async function openWhenReady(id: number) {
    const url = previewUrl(await run(engine.bin, ['port', engine.name, port + '/tcp']));
    for (let attempt = 0; id === generation && attempt < 40; attempt++) {
      const response = await fetch(url, {method:'HEAD', redirect:'manual', signal:AbortSignal.timeout(1000)}).catch(() => undefined);
      if (response?.ok) {
        await check();
        if (id === generation) await openAppBesideLesson(url);
        return;
      }
      await delay(300);
    }
    if (id === generation) report('The app did not respond on port ' + port + '. Check its startup output and run it again.');
  }
  const listener = (current: Stats, previous: Stats) => {
    if (!current.isFile() || current.mtimeMs < since || current.mtimeMs === previous.mtimeMs) return;
    void openWhenReady(++generation).catch(error => report(String(error)));
  };
  watchFile(marker, {interval:350, persistent:false}, listener);
  return {dispose() { generation++; unwatchFile(marker, listener); }};
}
