import type { DesktopUpdateState } from './desktopUpdates';
import type { UpdateStatus } from './updates';
import { UI_TOKENS } from './uiTheme';

type ComponentState = UpdateStatus | DesktopUpdateState;

/** Both components share the native sidebar button and its accessible status. */
export function combinedUpdate(extension: ComponentState, desktop: ComponentState) {
  const parts = [extension, desktop];
  if (desktop.status === 'downloading') return {status:'downloading', message:`Downloading desktop update… ${desktop.progress ?? 0}%`};
  if (extension.status === 'installing') return {status:'downloading', message:extension.message};
  if (parts.some(part => part.status === 'checking')) return {status:'checking', message:'Checking for updates…'};
  const failure = parts.find(part => part.retry || part.status === 'unavailable');
  if (failure) return {status:'unavailable', message:`${failure.message} Click the update icon to retry.`};
  if (parts.some(part => part.status === 'available')) return {status:'available', message:'Download the update and restart dhimantAI'};
  if (parts.some(part => part.status === 'ready') && parts.every(part => part.status !== 'unchecked'))
    return {status:'ready', message:'Restart dhimantAI to apply the verified update'};
  const incompatible = parts.find(part => part.status === 'incompatible');
  if (incompatible) return {status:'unavailable', message:incompatible.message};
  if (parts.every(part => part.status === 'current')) return {status:'current', message:'dhimantAI is up to date'};
  return {status:'unchecked', message:'Check for updates'};
}

export interface ControlView {
  id: string;
  name?: string;
  contact?: string;
  initials: string;
  service: string;
  manageProfile: boolean;
}

const paths = {
  play: 'M9 6l9 6-9 6Z', courses: 'M2 9l10-5 10 5-10 5ZM6 11v6l6 3 6-3v-6',
  certificate: 'M17 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM8 14l-2 7 4-2 2 2 1-6m2-1 3 7',
  book: 'M3 5q5-1 9 2 4-3 9-2v14q-5-1-9 2-4-3-9-2ZM12 7v14',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 7 0 0 1 16 0v2',
  settings: 'M4 6h6m4 0h6M4 12h10m4 0h2M4 18h3m4 0h9M10 3v6m4 0v6M7 15v6',
  exit: 'M10 4H4v16h6m-1-8h12m-5-5 5 5-5 5', plus: 'M12 4v16M4 12h16',
  extension: 'M3 5h6a3 3 0 1 1 6 0h5v6a3 3 0 1 0 0 6v4h-6a3 3 0 1 0-6 0H3Z',
  desktop: 'M3 4h18v13H3ZM12 17v4m-5 0h10', update: 'M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5',
  close: 'M6 6l12 12M18 6 6 18', refresh: 'M20 9a8 8 0 1 0 0 7M20 3v6h-6',
  info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 11v6m0-10v1',
};
function icon(key: keyof typeof paths) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[key]}"/></svg>`;
}
function row(action: string, glyph: keyof typeof paths, label: string, detail: string, style = '') {
  return `<button type="button" class="dc-row ${style}" data-control="${action}">${icon(glyph)}<span><strong>${label}</strong><small>${detail}</small></span><span aria-hidden="true">›</span></button>`;
}
export const controlDialog = `<dialog id="dc-dialog" aria-label="dhimantAI profile" tabindex="-1">
  <button type="button" class="dc-close" data-control="close" aria-label="Close">${icon('close')}</button>
  <div id="dc-profile">
    <header class="dc-head"><span class="dc-avatar" aria-hidden="true"><span id="dc-avatar"></span><span id="dc-guest-icon">${icon('account')}</span></span><div><h2 id="dc-name"></h2><small id="dc-contact"></small><span id="dc-service"></span></div></header>
    <div class="dc-body"><div id="dc-member" hidden>
      ${row('continue','play','Continue Learning','Pick up your lesson with Instructor.','dc-primary-row')}
      <h3 class="dc-group">Learning</h3>
      ${row('courses','courses','My Courses','Your courses, chapters and practice.')}
      ${row('certificates','certificate','My Certificates','View your certificates.')}
      ${row('catalog','book','Course Catalog','Browse courses and bundles.')}
      <h3 class="dc-group">Account</h3>
      ${row('manage','account','Manage Profile','Edit your profile on the web.')}
      ${row('settings','settings','Settings','App settings and preferences.')}
      <div class="dc-signout">${row('signOut','exit','Sign Out','Sign out on this computer. Your course files stay here.')}</div>
    </div><div id="dc-guest" hidden>
      ${row('signIn','account','Sign In','Continue your courses and Instructor sessions.','dc-primary-row')}
      ${row('signUp','plus','Create Account','Start your first free chapter.')}
      ${row('catalog','book','Browse Courses','Explore the Course Catalog.')}
      ${row('settings','settings','Settings','App settings and preferences.')}
    </div></div>
  </div>
</dialog>`;

export const controlStyles = `
#dc-dialog{--dc-line:var(--vscode-widget-border,var(--dh-border));--dc-accent:var(--vscode-textLink-foreground);box-sizing:border-box;
  position:fixed;inset:10px 10px auto auto;margin:0;padding:0;width:min(370px,calc(100% - 20px));max-width:none;max-height:calc(100% - 20px);overflow:auto;
  border:1px solid var(--dc-line);border-radius:12px;background:var(--vscode-editor-background);color:var(--vscode-foreground);
  font: max(14px,var(--vscode-font-size,13px))/1.45 var(--vscode-font-family,system-ui);box-shadow:0 8px 36px var(--vscode-widget-shadow,#0003);overflow-wrap:anywhere}
#dc-dialog::backdrop{background:rgb(0 0 0 / .17)}
#dc-dialog *{box-sizing:border-box}#dc-dialog [hidden]{display:none!important}
#dc-dialog svg{width:19px;height:19px;flex:none;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.7}
#dc-dialog h2,#dc-dialog h3,#dc-dialog p{margin:0}
#dc-dialog h2{font-size:1.32em;line-height:1.25;letter-spacing:-.025em}
#dc-dialog h3{font-size:1em}#dc-dialog small{display:block;color:var(--dh-muted);font-size:.9em;line-height:1.4}
#dc-dialog button{cursor:pointer;font:inherit}
#dc-dialog button{margin:0;min-height:34px;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px;text-align:start}
#dc-dialog button:hover{background:var(--vscode-list-hoverBackground);filter:none}
#dc-dialog :focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
#dc-dialog .dc-close{position:absolute;inset:10px 10px auto auto;width:34px;display:grid;place-items:center;padding:0}
.dc-head{display:flex;align-items:center;gap:12px;padding:19px 48px 18px 18px;border-bottom:1px solid var(--dc-line);
  background:linear-gradient(105deg,color-mix(in srgb,var(--dc-accent) 12%,var(--vscode-editor-background)),var(--vscode-editor-background))}
.dc-avatar{width:40px;height:40px;display:grid;place-items:center;flex:none;border-radius:10px;background:color-mix(in srgb,var(--dc-accent) 12%,var(--vscode-editor-background));color:var(--dc-accent)}
.dc-avatar{background:var(--dh-accent);color:var(--dh-accent-fg);border-radius:50%;font-weight:650}
#dc-service{display:inline-block;border:1px solid var(--dc-line);border-radius:20px;padding:1px 8px;font-size:.82em;font-weight:600}
#dc-service{margin-top:4px}.dc-body{padding:12px}
#dc-dialog .dc-row{display:grid;width:100%;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:11px;padding:7px 10px}
.dc-row svg,.dc-row>span:last-child{color:var(--dc-accent)}.dc-row strong{font-weight:600}
#dc-dialog .dc-primary-row{background:color-mix(in srgb,var(--dc-accent) 10%,var(--vscode-editor-background));border-color:color-mix(in srgb,var(--dc-accent) 35%,var(--dc-line))}
#dc-dialog .dc-group{margin:10px 0 2px;padding:8px 10px 0;border-top:1px solid var(--dc-line);font-size:.86em;color:var(--dh-muted)}
.dc-signout{margin-top:8px;padding-top:6px;border-top:1px solid var(--dc-line)}.dc-signout strong,.dc-signout svg{color:color-mix(in srgb,var(--vscode-errorForeground) 68%,var(--vscode-foreground))}
@media(max-width:340px){.dc-body{padding:8px}}
@media(forced-colors:active){#dc-dialog button{border-color:ButtonText}}
`;

/** Runs inside the existing catalog webview or the same dialog in its own editor. */
export function desktopControlsClient(api: {postMessage(message: unknown): void}) {
  const dialog = document.querySelector<HTMLDialogElement>('#dc-dialog')!;
  const el = (id: string) => document.getElementById(id)!;
  let view: ControlView | undefined;
  const text = (node: Element, value: string) => { if (node.textContent !== value) node.textContent = value; };
  window.addEventListener('message', event => {
    if (event.data?.type !== 'desktopControlView') return;
    const next: ControlView | undefined = event.data.view;
    if (!next) { view = undefined; if (dialog.open) dialog.close(); return; }
    const opening = !dialog.open || next.id !== view?.id;
    view = next;
    dialog.dataset.kind = 'profile';
    dialog.setAttribute('aria-label', 'Profile');
    const member = !!next.contact;
    text(el('dc-name'), next.name || next.contact || 'Your profile');
    text(el('dc-contact'), next.name ? next.contact ?? '' : '');
    text(el('dc-avatar'), next.initials);
    el('dc-guest-icon').hidden = !!next.initials;
    text(el('dc-service'), next.service);
    el('dc-member').hidden = !member; el('dc-guest').hidden = member;
    dialog.querySelector<HTMLButtonElement>('[data-control=manage]')!.hidden = !next.manageProfile;
    if (opening) {
      window.focus();
      if (!dialog.open) dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(next.contact ? '[data-control=continue]' : '[data-control=signIn]')!.focus();
      dialog.scrollTop = 0;
    } else if (!dialog.contains(document.activeElement) || document.activeElement?.closest('[hidden], :disabled')) dialog.focus();
  });
  dialog.addEventListener('click', event => {
    const action = (event.target as Element).closest<HTMLButtonElement>('button[data-control]')?.dataset.control;
    if (view && action) api.postMessage({type:'desktopControlAction', id:view.id, action});
    else if (event.target === dialog) {
      const {left, right, top, bottom} = dialog.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dialog.close();
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (view) api.postMessage({type:'desktopControlAction', id:view.id, action:'close'});
  });
  dialog.addEventListener('close', () => {
    if (view && !dialog.open) api.postMessage({type:'desktopControlAction', id:view.id, action:'close'});
  });
  queueMicrotask(() => api.postMessage({type:'desktopControlReady'}));
}

export function standaloneControls(nonce: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <style nonce="${nonce}">${UI_TOKENS}${controlStyles}#dc-dialog{inset:12px auto auto 50%;transform:translateX(-50%)}#dc-dialog::backdrop{background:transparent}</style>
  </head><body>${controlDialog}<script nonce="${nonce}">(${desktopControlsClient.toString()})(acquireVsCodeApi());</script></body></html>`;
}
