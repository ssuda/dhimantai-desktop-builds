/**
 * Puts the task player into an application page through the browser's DevTools protocol, so no
 * application image or server has to be modified. Works for apps we host (ERPNext, Odoo) and for
 * SaaS apps we cannot change (Salesforce, Workday), as long as the page opens in the desktop browser.
 */

/** A browser-level DevTools connection: VS Code's BrowserCDPSession, or Playwright's in tests. */
export interface CdpTransport {
  send(message: unknown): PromiseLike<void>;
  onMessage(listener: (message: unknown) => void): {dispose(): void};
}

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }

export class CdpClient {
  private id = 0;
  private pending = new Map<number, Pending>();
  private subscription: {dispose(): void};
  constructor(private readonly transport: CdpTransport) {
    this.subscription = transport.onMessage(raw => {
      const message = raw as {id?: number; result?: Record<string, unknown>; error?: {message?: string}};
      if (typeof message?.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'DevTools request failed.'));
      else entry.resolve(message.result ?? {});
    });
  }
  call(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, {resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }});
      Promise.resolve(this.transport.send({id, method, params, ...(sessionId ? {sessionId} : {})})).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
  dispose() { this.subscription.dispose(); for (const entry of this.pending.values()) entry.reject(new Error('DevTools session closed.')); this.pending.clear(); }
}

/** What to put into the page and how to sign the learner in. */
export interface Injection {
  /** Only pages on this origin receive the player. */
  origin: string;
  /** Adapter, player and live-link sources, in load order. */
  scripts: string[];
  /** Values the player reads at start (bridge connection, learner identity), stored in sessionStorage. */
  session: Record<string, string>;
  /** The application's own session cookie for the learner, obtained by the desktop. */
  cookie?: {name: string; value: string};
  /** Where to send the browser once everything is in place. */
  home: string;
}

/** The page script: runs on every document of the origin, before the application's own scripts. */
export function pageScript(injection: Injection): string {
  const guarded = injection.scripts.map(source => `try{${source}\n}catch(error){console.error('dhimantAI player',error);}`).join('\n');
  return `(()=>{if(location.origin!==${JSON.stringify(injection.origin)}||window.__dhimantaiInjected)return;window.__dhimantaiInjected=true;
for(const [k,v] of Object.entries(${JSON.stringify(injection.session)}))sessionStorage.setItem(k,v);
const start=()=>{${guarded}};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();})();`;
}

/** Attaches to the application's tab, signs the learner in and installs the player. Returns the page session id. */
export async function injectPlayer(client: CdpClient, injection: Injection): Promise<string> {
  const {targetInfos} = await client.call('Target.getTargets') as {targetInfos: {targetId: string; type: string; url: string}[]};
  const pages = targetInfos.filter(t => t.type === 'page');
  const target = pages.find(t => t.url.startsWith(injection.origin)) ?? (pages.length === 1 ? pages[0] : undefined);
  if (!target) throw new Error('The application tab is not open.');
  const {sessionId} = await client.call('Target.attachToTarget', {targetId: target.targetId, flatten: true}) as {sessionId: string};
  await client.call('Page.enable', {}, sessionId);
  if (injection.cookie) {
    await client.call('Network.enable', {}, sessionId);
    const url = new URL(injection.origin);
    const {success} = await client.call('Network.setCookie', {name: injection.cookie.name, value: injection.cookie.value,
      domain: url.hostname, path: '/', httpOnly: true, secure: url.protocol === 'https:', sameSite: 'Lax'}, sessionId) as {success?: boolean};
    if (success === false) throw new Error('The browser did not accept the application session.');
  }
  await client.call('Page.addScriptToEvaluateOnNewDocument', {source: pageScript(injection)}, sessionId);
  await client.call('Page.navigate', {url: injection.origin + injection.home}, sessionId, 30000);
  return sessionId;
}
