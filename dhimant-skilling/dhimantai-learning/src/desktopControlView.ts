import type { DesktopUpdateState } from './desktopUpdates';
import type { UpdateStatus } from './updates';
import { UI_TOKENS } from './uiTheme';

export type ControlKind = 'profile' | 'updates';
type Component = 'extension' | 'desktop';
type ComponentState = UpdateStatus | DesktopUpdateState;
const statusLabels: Record<ComponentState['status'], string> = {
  unchecked: 'Not checked', checking: 'Checking…', current: 'Up to date', available: 'Update available',
  downloading: 'Downloading', installing: 'Updating', ready: 'Ready to apply', unavailable: 'Check failed', incompatible: 'Compatibility warning',
};

export function updateCard(component: Component, state: ComponentState) {
  const extension = component === 'extension';
  let action: string | undefined, label: string | undefined;
  if (state.status === 'available') {
    action = extension ? 'install' : 'download';
    label = state.retry ? (extension ? 'Retry installation' : 'Retry download') : (extension ? 'Install update' : 'Download installer');
  } else if (state.status === 'ready') {
    action = extension ? 'reload' : 'openInstaller';
    label = extension ? 'Reload to apply' : 'Open installer';
  } else if (state.status === 'unavailable') {
    action = extension ? 'checkExtension' : 'checkDesktop';
    label = 'Retry check';
  }
  const busy = ['checking', 'downloading', 'installing'].includes(state.status);
  return { ...state, action, label, busy, badge: state.retry ? 'Update failed' : statusLabels[state.status],
    tone: state.retry || state.status === 'unavailable' || state.status === 'incompatible' ? 'warning'
      : state.status === 'current' || state.status === 'ready' ? 'success' : 'neutral' };
}

export interface ControlView {
  kind: ControlKind;
  id: string;
  name?: string;
  contact?: string;
  initials: string;
  service: string;
  manageProfile: boolean;
  extension: ReturnType<typeof updateCard>;
  desktop: ReturnType<typeof updateCard>;
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
function card(part: Component, title: string, description: string) {
  return `<section class="dc-card" data-part="${part}" aria-labelledby="dc-${part}">
    <div class="dc-card-head"><span class="dc-tile">${icon(part)}</span><div><h3 id="dc-${part}">${title}</h3><small data-version></small></div><span class="dc-badge" role="status"></span></div>
    <p>${description}</p><p data-message></p><progress max="100" aria-label="${title} update progress" hidden></progress>
    <button type="button" class="dc-secondary" data-card-action hidden></button></section>`;
}
export const controlDialog = `<dialog id="dc-dialog" aria-label="dhimantAI profile" tabindex="-1">
  <button type="button" class="dc-close" data-control="close" aria-label="Close">${icon('close')}</button>
  <div id="dc-profile" hidden>
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
  <div id="dc-updates" hidden>
    <header class="dc-head"><span class="dc-tile">${icon('update')}</span><div><h2>dhimantAI Updates</h2><small>Learning extension and desktop application</small></div></header>
    <div class="dc-body">
    ${card('extension','Learning Extension','Instructor, Doubt Solver and coding practice.')}
    ${card('desktop','Desktop Application','The app for your courses, notebooks and projects.')}
    <p class="dc-info">${icon('info')}Updates never restart an active lesson automatically.</p>
    <div class="dc-footer"><button type="button" class="dc-primary" data-control="check">${icon('refresh')}Check for Updates</button>
      <button type="button" class="dc-secondary" data-control="updateSettings">${icon('settings')}Update Settings</button></div>
    <details class="dc-notes"><summary>Release Notes</summary><button type="button" data-control="extensionNotes">Learning extension notes</button><button type="button" data-control="desktopNotes">Desktop release notes ↗</button></details>
    </div>
  </div>
</dialog>`;

export const controlStyles = `
#dc-dialog{--dc-line:var(--vscode-widget-border,var(--dh-border));--dc-accent:var(--vscode-textLink-foreground);box-sizing:border-box;
  position:fixed;inset:10px 10px auto auto;margin:0;padding:0;width:min(370px,calc(100% - 20px));max-width:none;max-height:calc(100% - 20px);overflow:auto;
  border:1px solid var(--dc-line);border-radius:12px;background:var(--vscode-editor-background);color:var(--vscode-foreground);
  font: max(14px,var(--vscode-font-size,13px))/1.45 var(--vscode-font-family,system-ui);box-shadow:0 8px 36px var(--vscode-widget-shadow,#0003);overflow-wrap:anywhere}
#dc-dialog[data-kind=updates]{width:min(530px,calc(100% - 20px))}
#dc-dialog::backdrop{background:rgb(0 0 0 / .17)}
#dc-dialog *{box-sizing:border-box}#dc-dialog [hidden]{display:none!important}
#dc-dialog svg{width:19px;height:19px;flex:none;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.7}
#dc-dialog h2,#dc-dialog h3,#dc-dialog p{margin:0}
#dc-dialog h2{font-size:1.32em;line-height:1.25;letter-spacing:-.025em}
#dc-dialog h3{font-size:1em}#dc-dialog small{display:block;color:var(--dh-muted);font-size:.9em;line-height:1.4}
#dc-dialog button,#dc-dialog summary{cursor:pointer;font:inherit}
#dc-dialog button{margin:0;min-height:34px;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px;text-align:start}
#dc-dialog button:hover,#dc-dialog summary:hover{background:var(--vscode-list-hoverBackground);filter:none}
#dc-dialog :focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:-2px}
#dc-dialog .dc-close{position:absolute;inset:10px 10px auto auto;width:34px;display:grid;place-items:center;padding:0}
.dc-head{display:flex;align-items:center;gap:12px;padding:19px 48px 18px 18px;border-bottom:1px solid var(--dc-line);
  background:linear-gradient(105deg,color-mix(in srgb,var(--dc-accent) 12%,var(--vscode-editor-background)),var(--vscode-editor-background))}
.dc-avatar,.dc-tile{width:40px;height:40px;display:grid;place-items:center;flex:none;border-radius:10px;background:color-mix(in srgb,var(--dc-accent) 12%,var(--vscode-editor-background));color:var(--dc-accent)}
.dc-avatar{background:var(--dh-accent);color:var(--dh-accent-fg);border-radius:50%;font-weight:650}
#dc-service,.dc-badge{display:inline-block;border:1px solid var(--dc-line);border-radius:20px;padding:1px 8px;font-size:.82em;font-weight:600}
#dc-service{margin-top:4px}.dc-body{padding:12px}
#dc-dialog .dc-row{display:grid;width:100%;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:11px;padding:7px 10px}
.dc-row svg,.dc-row>span:last-child{color:var(--dc-accent)}.dc-row strong{font-weight:600}
#dc-dialog .dc-primary-row{background:color-mix(in srgb,var(--dc-accent) 10%,var(--vscode-editor-background));border-color:color-mix(in srgb,var(--dc-accent) 35%,var(--dc-line))}
#dc-dialog .dc-group{margin:10px 0 2px;padding:8px 10px 0;border-top:1px solid var(--dc-line);font-size:.86em;color:var(--dh-muted)}
.dc-signout{margin-top:8px;padding-top:6px;border-top:1px solid var(--dc-line)}.dc-signout strong,.dc-signout svg{color:color-mix(in srgb,var(--vscode-errorForeground) 68%,var(--vscode-foreground))}
.dc-card{padding:14px;border:1px solid var(--dc-line);border-radius:9px;background:var(--dh-surface)}.dc-card+.dc-card{margin-top:9px}
.dc-card-head,.dc-footer,.dc-info{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dc-card-head>div{flex:1;min-width:min(150px,100%)}.dc-card .dc-tile{width:34px;height:34px}.dc-card .dc-badge{max-width:100%}
.dc-badge[data-tone=success]{color:color-mix(in srgb,var(--vscode-testing-iconPassed,var(--vscode-foreground)) 35%,var(--vscode-foreground));border-color:currentColor}
.dc-badge[data-tone=warning]{color:color-mix(in srgb,var(--vscode-editorWarning-foreground,var(--vscode-foreground)) 35%,var(--vscode-foreground));border-color:currentColor}
#dc-dialog .dc-card p{font-size:.92em;margin-top:8px}#dc-dialog [data-message]{color:var(--dh-muted);margin-top:3px}
.dc-card progress{display:block;width:100%;accent-color:var(--dh-accent);height:8px;margin:8px 0}
#dc-dialog .dc-primary,#dc-dialog .dc-secondary{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:6px 10px;border:1px solid var(--dc-line);font-weight:550}
#dc-dialog .dc-primary{color:var(--dh-accent-fg);background:var(--dh-accent);border-color:var(--dh-button-border)}
#dc-dialog .dc-primary:hover{background:var(--vscode-button-hoverBackground,var(--dh-accent));color:var(--dh-accent-fg)}
#dc-dialog button:disabled{opacity:.65;cursor:default}#dc-dialog .dc-card button{margin-top:8px}
#dc-dialog .dc-info{flex-wrap:nowrap;align-items:flex-start;font-size:.92em;margin:12px 0}.dc-info svg{color:var(--dc-accent)}
.dc-notes{margin-top:10px}.dc-notes summary,.dc-notes button{color:var(--dc-accent)!important;text-decoration:underline}.dc-notes summary{width:fit-content;padding:4px}
@media(max-width:340px){.dc-body{padding:8px}.dc-footer>button{width:100%}.dc-head{padding-left:12px}}
@media(forced-colors:active){#dc-dialog button,.dc-card,.dc-badge{border-color:ButtonText}}
`;

/** Runs inside the existing catalog webview or the same dialog in its own editor. */
export function desktopControlsClient(api: {postMessage(message: unknown): void}) {
  const dialog = document.querySelector<HTMLDialogElement>('#dc-dialog')!;
  const el = (id: string) => document.getElementById(id)!;
  let view: ControlView | undefined;
  const text = (node: Element, value: string) => { if (node.textContent !== value) node.textContent = value; };
  function renderCard(component: Component, state: ControlView['desktop']) {
    const card = dialog.querySelector<HTMLElement>(`[data-part="${component}"]`)!;
    const badge = card.querySelector<HTMLElement>('.dc-badge')!;
    badge.dataset.tone = state.tone;
    text(badge, state.badge);
    const installed = state.installed ? 'Installed ' + state.installed : 'Version unavailable';
    const target = state.available && state.available !== state.installed && state.status !== 'current' ? ' · Update ' + state.available : '';
    text(card.querySelector('[data-version]')!, installed + target);
    const detail = state.action === 'reload' ? state.message + ' Reloading now ends the active lesson in this window.' : state.message;
    const message = card.querySelector<HTMLElement>('[data-message]')!;
    message.hidden = state.status === 'current' && (!state.available || state.available === state.installed);
    text(message, detail);
    const progress = card.querySelector('progress')!;
    progress.hidden = !state.busy;
    if (state.progress === undefined) progress.removeAttribute('value'); else progress.value = state.progress;
    const action = card.querySelector<HTMLButtonElement>('[data-card-action]')!;
    action.hidden = !state.action;
    action.dataset.control = state.action ?? '';
    text(action, state.label ?? '');
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'desktopControlView') return;
    const next: ControlView | undefined = event.data.view;
    if (!next) { view = undefined; if (dialog.open) dialog.close(); return; }
    const opening = !dialog.open || next.id !== view?.id;
    view = next;
    const profile = next.kind === 'profile';
    dialog.dataset.kind = next.kind;
    dialog.setAttribute('aria-label', profile ? 'Profile' : 'dhimantAI Updates');
    el('dc-profile').hidden = !profile; el('dc-updates').hidden = profile;
    if (profile) {
      const member = !!next.contact;
      text(el('dc-name'), next.name || next.contact || 'Your profile');
      text(el('dc-contact'), next.name ? next.contact ?? '' : '');
      text(el('dc-avatar'), next.initials);
      el('dc-guest-icon').hidden = !!next.initials;
      text(el('dc-service'), next.service);
      el('dc-member').hidden = !member; el('dc-guest').hidden = member;
      dialog.querySelector<HTMLButtonElement>('[data-control=manage]')!.hidden = !next.manageProfile;
    } else {
      renderCard('extension', next.extension); renderCard('desktop', next.desktop);
      dialog.querySelector<HTMLButtonElement>('[data-control=check]')!.disabled = next.extension.busy || next.desktop.busy;
    }
    if (opening) {
      dialog.querySelector('details')!.open = false;
      window.focus();
      if (!dialog.open) dialog.showModal();
      (profile ? dialog.querySelector<HTMLButtonElement>(next.contact ? '[data-control=continue]' : '[data-control=signIn]')! : dialog).focus();
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
