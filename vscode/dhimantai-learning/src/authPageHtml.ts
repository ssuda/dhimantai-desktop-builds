export type AuthPageMode = 'signIn' | 'signUp';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const revealButton = (id: string, label: string) => `<button class="reveal" type="button" data-label="${label}" aria-controls="${id}" aria-pressed="false" aria-label="Show ${label}" title="Show ${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="slash" d="m3 3 18 18"/></svg></button>`;

/** Credentials stay in the form and are never saved in webview state or sent to a browser. */
export function authPageHtml(mode: AuthPageMode, nonce: string, environment: string, notice = ''): string {
  const signup = mode === 'signUp';
  const title = signup ? 'Create your account' : 'Sign in';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'">
<title>${title} · dhimantAI</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:14px/1.5 var(--vscode-font-family,system-ui)}
main{width:min(100%,440px);margin:clamp(24px,9vh,90px) auto;padding:24px}header{margin-bottom:28px}.brand{font-weight:600;margin:0 0 24px}.service{color:var(--vscode-descriptionForeground);font-size:12px;font-weight:400;margin-left:8px}
h1{font-size:28px;line-height:1.2;font-weight:600;margin:0 0 12px}p{margin:12px 0;color:var(--vscode-descriptionForeground)}
label{display:block;margin:18px 0 6px}input{width:100%;padding:10px 12px;border:1px solid var(--vscode-input-border,var(--vscode-widget-border,transparent));border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}
input:focus-visible,button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button{font:inherit;cursor:pointer;border:0;border-radius:4px}button:disabled{cursor:default;opacity:.65}
.password-field{position:relative}.password-field input{padding-right:46px}.reveal{position:absolute;right:3px;top:3px;bottom:3px;width:40px;background:transparent;color:var(--vscode-input-foreground)}.reveal:hover{background:var(--vscode-toolbar-hoverBackground)}.reveal svg{width:20px;height:20px;vertical-align:middle;fill:none;stroke:currentColor;stroke-width:1.6}.reveal .slash{display:none}.reveal[aria-pressed="true"] .slash{display:block}
.submit{width:100%;padding:10px 16px;margin-top:24px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}.submit:hover{background:var(--vscode-button-hoverBackground)}
.link{padding:2px;background:transparent;color:var(--vscode-textLink-foreground)}.link:hover{text-decoration:underline}.switch{text-align:center;margin-top:24px}.hint{font-size:12px;margin-top:6px}
#status{margin:16px 0 0;overflow-wrap:anywhere}#status:empty{display:none}#status.error{color:var(--vscode-errorForeground)}
</style></head><body><main>
<header><div class="brand">dhimantAI${environment === 'production' ? '' : `<span class="service">${escape(environment)}</span>`}</div>
<h1>${title}</h1><p>${signup ? 'Start learning with your own account.' : 'Continue learning with dhimantAI.'}</p></header>
<form id="auth-form">
${signup ? '<label for="name">Name</label><input id="name" name="name" autocomplete="name" required minlength="2" maxlength="100">' : ''}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<label for="password">Password</label><div class="password-field"><input id="password" name="password" type="password" autocapitalize="none" spellcheck="false" autocomplete="${signup ? 'new-password' : 'current-password'}" required${signup ? ' minlength="8" aria-describedby="password-hint"' : ''}>${revealButton('password', 'password')}</div>
${signup ? '<p class="hint" id="password-hint">Use at least 8 characters.</p><label for="confirmation">Confirm password</label><div class="password-field"><input id="confirmation" name="confirmation" type="password" autocapitalize="none" spellcheck="false" autocomplete="new-password" required minlength="8">' + revealButton('confirmation', 'password confirmation') + '</div>' : ''}
<p id="status" role="status" aria-live="polite">${escape(notice)}</p>
<button class="submit" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
</form>
<p class="switch">${signup ? 'Already have an account?' : 'New to dhimantAI?'} <button class="link" id="switch" type="button">${signup ? 'Sign in' : 'Create an account'}</button></p>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const form = document.getElementById('auth-form');
const status = document.getElementById('status');
const password = document.getElementById('password');
const confirmation = document.getElementById('confirmation');
let busy = false;
function setVisible(button, visible) {
  const input = document.getElementById(button.getAttribute('aria-controls'));
  input.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  const label = (visible ? 'Hide ' : 'Show ') + button.dataset.label;
  button.setAttribute('aria-label', label); button.title = label;
}
document.querySelectorAll('.reveal').forEach(button => button.addEventListener('click', () => {
  if (busy) return;
  const input = document.getElementById(button.getAttribute('aria-controls'));
  const start = input.selectionStart, end = input.selectionEnd;
  setVisible(button, input.type === 'password');
  input.focus(); input.setSelectionRange(start, end);
}));
function setBusy(value) {
  busy = value;
  document.querySelectorAll('.reveal').forEach(button => setVisible(button, false));
  form.setAttribute('aria-busy', String(value));
  document.querySelectorAll('input,button').forEach(control => { control.disabled = value; });
  form.querySelector('.submit').textContent = value ? '${signup ? 'Creating account…' : 'Signing in…'}' : '${signup ? 'Create account' : 'Sign in'}';
}
function validateConfirmation() {
  if (confirmation) confirmation.setCustomValidity(confirmation.value === password.value ? '' : 'Passwords do not match.');
}
password.addEventListener('input', validateConfirmation);
if (confirmation) confirmation.addEventListener('input', validateConfirmation);
form.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  validateConfirmation();
  if (!form.reportValidity()) return;
  const message = { type: 'submit', mode: '${mode}', email: document.getElementById('email').value, password: password.value,
    name: document.getElementById('name')?.value, confirmation: confirmation?.value };
  status.textContent = ''; status.className = '';
  setBusy(true);
  vscode.postMessage(message);
});
document.getElementById('switch').addEventListener('click', () => {
  if (busy) return;
  setBusy(true);
  vscode.postMessage({type:'navigate', mode:'${signup ? 'signIn' : 'signUp'}'});
});
window.addEventListener('message', event => {
  if (event.data?.type !== 'error') return;
  setBusy(false);
  password.value = ''; if (confirmation) { confirmation.value = ''; confirmation.setCustomValidity(''); }
  status.className = 'error'; status.textContent = event.data.message;
  password.focus();
});
document.getElementById('${signup ? 'name' : 'email'}').focus();
</script></body></html>`;
}
