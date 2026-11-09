import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

/** Real extension panel/message handler, driven by its rendered form against a local test service. */
export class AuthPageDriver {
  private readonly create = vscode.window.createWebviewPanel;
  panel?: vscode.WebviewPanel;
  private receive?: (message: any) => Promise<void>;
  private dom?: JSDOM;
  private html?: string;
  private delivered: Promise<void>[] = [];
  created = 0;

  constructor() {
    (vscode.window as any).createWebviewPanel = (...args: any[]) => {
      const panel = (this.create as any)(...args) as vscode.WebviewPanel;
      if (args[0] !== 'dhimantai.auth') return panel;
      this.created++;
      this.panel = panel;
      panel.onDidDispose(() => { this.panel = undefined; this.dom?.window.close(); this.dom = undefined; this.html = undefined; });
      (panel.webview as any).onDidReceiveMessage = (handler: any) => { this.receive = handler; return new vscode.Disposable(() => {}); };
      (panel.webview as any).postMessage = async (message: any) => {
        this.dom?.window.dispatchEvent(new this.dom.window.MessageEvent('message', {data: message}));
        return true;
      };
      return panel;
    };
  }

  async waitForPage() {
    for (let i = 0; i < 100 && !this.panel; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(this.panel, 'The authentication command opens a page');
  }

  document() {
    assert.ok(this.panel);
    if (this.html !== this.panel.webview.html) {
      this.dom?.window.close();
      this.html = this.panel.webview.html;
      this.dom = new JSDOM(this.html, {runScripts: 'outside-only'});
      (this.dom.window as any).acquireVsCodeApi = () => ({postMessage: (message: any) => {
        this.delivered.push(this.receive!(message));
      }});
      for (const script of this.dom.window.document.querySelectorAll('script')) this.dom.window.eval(script.textContent!);
    }
    return this.dom!.window.document;
  }

  async submit(values: Record<string, string>) {
    const doc = this.document();
    for (const [id, value] of Object.entries(values)) {
      const input = doc.getElementById(id) as HTMLInputElement;
      assert.ok(input, `Form has ${id}`);
      input.value = value;
      input.dispatchEvent(new this.dom!.window.Event('input', {bubbles: true}));
    }
    doc.querySelector('form')!.requestSubmit();
    await this.flush();
  }

  async navigate() { (this.document().getElementById('switch') as HTMLButtonElement).click(); await this.flush(); }
  async flush() { await Promise.all(this.delivered.splice(0)); }
  close() { this.panel?.dispose(); }
  dispose() { this.close(); (vscode.window as any).createWebviewPanel = this.create; }
}
