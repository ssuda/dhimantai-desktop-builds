// New-learner journey audit in the real desktop window: launch → catalog → account → first lesson,
// in Light Modern, Dark Modern and High Contrast. Screenshots, step timings and axe WCAG 2.2 AA
// results for every learning webview are written to DHIMANTAI_UX_OUT.
import * as assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium, type Frame, type Page} from 'playwright-core';
import * as vscode from 'vscode';
import type {Auth} from '../../src/auth';

const out = process.env.DHIMANTAI_UX_OUT || join(require('node:os').tmpdir(), 'dhimantai-desktop-ux');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const themes = ['Light Modern', 'Dark Modern', 'Default High Contrast'];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Content frames of the visible extension webviews (the workbench itself is upstream VS Code). */
async function webviewFrames(page: Page): Promise<Frame[]> {
  const frames: Frame[] = [];
  for (const frame of page.frames().filter(f => f.url().startsWith('vscode-webview://') && f.url().includes('/fake.html'))) {
    try { if (await frame.evaluate(() => innerWidth > 0 && innerHeight > 0)) frames.push(frame); } catch { /* detached */ }
  }
  return frames;
}

async function audit(page: Page) {
  const results = [];
  for (const frame of await webviewFrames(page)) {
    try {
      if (await frame.evaluate('typeof window.axe') !== 'object') await frame.evaluate(`(() => { ${axeSource}\n;window.axe = axe; })()`);
      const title = await frame.evaluate(() => document.title || document.querySelector('h1,h2')?.textContent?.trim() || '');
      const run: any = await frame.evaluate(() => (window as any).axe.run(document, {
        runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']}, resultTypes: ['violations', 'incomplete']}));
      results.push({title, passes: run.passes.length, incomplete: run.incomplete.map((v: any) => `${v.id}×${v.nodes.length}`), violations: run.violations.map((v: any) => ({id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.slice(0, 6).map((n: any) => ({target: n.target.join(' '), summary: n.failureSummary?.split('\n').slice(0, 3).join(' ')})),
        count: v.nodes.length}))});
    } catch (error) { results.push({error: String(error).slice(0, 200)}); }
  }
  return results;
}

/** Learning actions with neither a fill nor a border look like plain text (axe cannot see this). */
async function invisibleActions(page: Page) {
  const found: string[] = [];
  for (const frame of await webviewFrames(page)) {
    try {
      found.push(...await frame.evaluate(() => {
        const alpha = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return c === 'transparent' ? 0 : 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? Number(p[3]) : 1; };
        return [...document.querySelectorAll<HTMLButtonElement>('#feed article button, .course .actions button, .providers button')]
          .filter(b => b.offsetParent && !b.disabled)
          .filter(b => { const st = getComputedStyle(b); return alpha(st.backgroundColor) === 0 && (parseFloat(st.borderTopWidth) === 0 || alpha(st.borderTopColor) === 0); })
          .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40));
      }));
    } catch { /* frame navigated */ }
  }
  return found;
}

async function visibleText(page: Page) {
  const texts = [];
  for (const frame of await webviewFrames(page)) {
    try {
      texts.push(await frame.evaluate(() => ({
        headings: [...document.querySelectorAll('h1,h2,h3')].filter(e => (e as HTMLElement).offsetParent).map(e => e.textContent?.trim()).slice(0, 12),
        actions: [...document.querySelectorAll('button,a[href],[role=button]')].filter(e => (e as HTMLElement).offsetParent && !(e as HTMLButtonElement).disabled)
          .map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean).slice(0, 30),
        status: [...document.querySelectorAll('[role=status],[aria-live]')].map(e => e.textContent?.trim()).filter(Boolean).slice(0, 6),
      })));
    } catch { /* frame navigated */ }
  }
  return texts;
}

export async function run() {
  mkdirSync(out, {recursive: true});
  const extension = vscode.extensions.getExtension<{auth: Auth}>('optficial.dhimantai-learning')!;
  await extension.activate();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.DHIMANTAI_CDP_PORT);
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench'))!;
  page.setDefaultTimeout(20000);
  const view = page.frameLocator('iframe.webview:visible').last().frameLocator('#active-frame');
  const steps: any[] = [];
  const started = Date.now();
  let actions = 0;
  const step = async (name: string, theme = 'Light Modern') => {
    await pause(1200);
    const file = `${String(steps.length).padStart(2, '0')}-${name}-${theme.split(' ')[0].toLowerCase()}.png`;
    await page.screenshot({path: join(out, file)});
    steps.push({name, theme, file, seconds: Math.round((Date.now() - started) / 100) / 10, actions,
      title: await page.title(), invisibleActions: await invisibleActions(page), text: await visibleText(page), axe: await audit(page)});
    writeFileSync(join(out, 'journey.json'), JSON.stringify(steps, null, 2));
  };
  const act = async (fn: () => Promise<unknown>) => { actions++; await fn(); };
  try {
    await step('launch');
    // One navigation: the Learning sidebar, named like the lesson tabs and profile menu.
    await vscode.commands.executeCommand('dhimantai.learningNavigation.focus');
    const navigation = page.locator('.pane:has(.pane-header[aria-label*="Learn"]) .monaco-list-row .label-name');
    await navigation.first().waitFor();
    assert.deepEqual(await navigation.allInnerTexts(), ['Courses', 'My courses', 'Instructor', 'Doubt Solver', 'My certificates', 'Git & GitHub']);
    await vscode.commands.executeCommand('dhimantai.courseCatalog');
    await step('catalog');
    assert.equal(await view.locator('header.top nav[aria-label="Learning"]').count(), 0, 'the catalog header does not repeat the sidebar');
    assert.equal(await view.locator('header.top').getByRole('button', {name: 'Sign in', exact: true}).count(), 1);
    await act(() => view.getByRole('button', {name: 'Start Data Science with Python', exact: true}).click());
    await step('account');
    await act(() => view.locator('#name').fill('New Learner'));
    await act(() => view.locator('#email').fill('ux@example.test'));
    await act(() => view.locator('#password').fill('local-fixture-learner'));
    await act(() => view.locator('#confirmation').fill('local-fixture-learner'));
    await act(() => view.getByRole('button', {name: 'Create account', exact: true}).click());
    await pause(4000);
    await step('after-signup');
    await pause(6000);
    await step('first-lesson');
    for (const theme of themes.slice(1)) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      await step('first-lesson', theme);
      await vscode.commands.executeCommand('dhimantai.courseCatalog');
      await step('catalog', theme);
      await vscode.commands.executeCommand('workbench.action.previousEditor');
    }
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', themes[0], vscode.ConfigurationTarget.Global);
    const total = steps.reduce((sum, s) => sum + s.axe.reduce((n: number, a: any) => n + (a.violations?.length ?? 0), 0), 0);
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!, JSON.stringify({out, steps: steps.map(s => ({name: s.name, theme: s.theme, seconds: s.seconds, actions: s.actions,
      invisibleActions: s.invisibleActions, violations: s.axe.flatMap((a: any) => a.violations ?? []).map((v: any) => `${v.id}×${v.count}`)})), totalViolationRules: total}, null, 2));
    assert.ok(steps.length > 0);
    assert.deepEqual(steps.flatMap(s => s.invisibleActions.map((a: string) => `${s.theme}: ${a}`)), [], 'every learning action has a visible fill or border');
    assert.equal(total, 0, 'no axe WCAG 2.2 AA violations');
  } finally { await browser.close(); }
}
