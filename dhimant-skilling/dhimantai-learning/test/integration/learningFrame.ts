import type { Page } from 'playwright-core';

/** The sidebar and editor are separate nested workbench webviews. Locate the one with this control. */
export async function learningFrame(page: Page, selector: string) {
  for (let attempt=0; attempt<80; attempt++) {
    for (const frame of page.frames().filter(frame=>frame.url().startsWith('vscode-webview://'))) {
      if (await frame.locator(selector).first().isVisible().catch(()=>false)) return frame;
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('Desktop webview did not show '+selector);
}

/** Follow the same editor panel when VS Code replaces its inner document during sign-in or refresh. */
export async function learningPanel(page: Page, selector: string) {
  const content = await learningFrame(page, selector);
  const host = await content.parentFrame()!.frameElement();
  const name = await host.getAttribute('name');
  if (!name) throw new Error('Desktop webview has no panel name');
  return page.frameLocator(`iframe.webview[name="${name}"]`).frameLocator('#active-frame');
}
