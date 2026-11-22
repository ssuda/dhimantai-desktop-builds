import { authInputErrors } from './authValidation';
export type AuthPageMode = 'signIn' | 'signUp' | 'forgotPassword' | 'resetPassword';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const revealButton = (id: string, label: string) => `<button class="reveal" type="button" data-label="${label}" aria-controls="${id}" aria-pressed="false" aria-label="Show ${label}" title="Show ${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="slash" d="m3 3 18 18"/></svg></button>`;

/** Credentials stay in the form and are never saved in webview state or sent to a browser. */
export function authPageHtml(mode: AuthPageMode, nonce: string, environment: string, assets: { root: string; source: string }, notice = '', courseTitle?: string): string {
  const signup = mode === 'signUp', forgot = mode === 'forgotPassword', reset = mode === 'resetPassword';
  const newPassword = signup || reset;
  const accountEntry = signup || mode === 'signIn';
  const destination = courseTitle && accountEntry ? `Continue to ${courseTitle} after signing in.`
    : signup ? 'Start learning with your own account.'
    : forgot ? 'Enter your registered email address to get a password reset link.'
    : reset ? 'Choose a password for your next sign-in.' : 'Continue learning with dhimantAI.';
  const root = escape(assets.root);
  const providers = [
    { id: 'google', label: 'Google', icon: 'google.png' },
    { id: 'github', label: 'GitHub', icon: 'github.svg' },
    { id: 'azure', label: 'Microsoft', icon: 'microsoft.svg' },
  ];
  const title = signup ? 'Create your account' : forgot ? 'Forgot password' : reset ? 'Choose a new password' : 'Sign in';
  const submit = signup ? 'Create account' : forgot ? 'Send reset link' : reset ? 'Update password' : 'Sign in';
  const submitting = signup ? 'Creating account…' : forgot ? 'Sending reset link…' : reset ? 'Updating password…' : 'Signing in…';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escape(assets.source)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'">
<title>${title} · dhimantAI</title>
<link rel="stylesheet" nonce="${nonce}" href="${root}/auth.css">
</head><body><main class="account">
<aside class="brand-panel" aria-label="About dhimantAI">
  <div class="brand">
    <img src="${root}/dhimantai.png" width="58" height="44" alt="">
    <span>dhimant<b>AI</b></span>
    ${environment === 'production' ? '' : `<span class="service">${escape(environment)}</span>`}
  </div>
  <div class="brand-story">
    <p class="tagline">Code it. Break it.<br><strong>Understand it.</strong></p>
    <p class="product-message">Build real projects with an AI Instructor that asks questions and helps you work through the answer.</p>
    <figure class="example" aria-label="A question from the Instructor">
      <div class="editor">
        <div class="editor-bar"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span>shelf/repository.py</div>
        <pre><code><span class="line"><i aria-hidden="true">1</i><span class="keyword">def</span> <span class="function">get_book</span>(book_id):</span>
<span class="line highlighted"><i aria-hidden="true">2</i>    <span class="keyword">return</span> books[book_id]</span></code></pre>
      </div>
      <figcaption class="question">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7Z"/></svg>
        <div><b>Instructor</b><p>What happens if the book ID is missing from the dictionary?</p></div>
      </figcaption>
    </figure>
  </div>
  <ul class="features" aria-label="Learning tools">
    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0 0 4h12M5 20a2 2 0 0 1 2-2"/></svg>Courses</li>
    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 17c0-3-3-3-3-7a6 6 0 0 1 12 0c0 4-3 4-3 7Zm1 4h4"/></svg>Doubt solver</li>
    <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>Practice</li>
  </ul>
</aside>
<section class="form-panel" aria-labelledby="page-title"><div class="form-content">
<header><h1 id="page-title">${title}</h1><p id="destination">${escape(destination)}</p></header>
${accountEntry ? `<div class="providers">${providers.map(provider => `<button type="button" data-provider="${provider.id}">
  <img src="${root}/${provider.icon}" alt="" width="19" height="19">Continue with ${provider.label}
</button>`).join('')}</div><p class="divider">or ${signup ? 'sign up' : 'sign in'} with email</p>` : ''}
<form id="auth-form" novalidate>
${signup ? '<div class="field"><label for="name">Name</label><input id="name" name="name" placeholder="Your name" autocomplete="name" required minlength="2" maxlength="100"></div>' : ''}
${reset ? '' : `<div class="field"><label for="email">Email</label>
<input id="email" name="email" type="email" placeholder="name@example.com" autocomplete="username" autocapitalize="none" spellcheck="false" required aria-describedby="email-hint">
<p class="hint" id="email-hint">${signup ? 'Use an address you can check for a confirmation link.' : 'Use your registered email address.'}</p></div>`}
${newPassword ? '<div class="password-pair">' : ''}
${forgot ? '' : `<div class="field"><div class="label-row"><label for="password">${reset ? 'New password' : 'Password'}</label>
${mode === 'signIn' ? '<button class="link" id="forgot" type="button">Forgot password?</button>' : ''}</div>
<div class="password-field"><input id="password" name="password" type="password" placeholder="${newPassword ? 'New password' : 'Enter your password'}" autocapitalize="none" spellcheck="false" autocomplete="${newPassword ? 'new-password' : 'current-password'}" required aria-describedby="password-hint"${newPassword ? ' minlength="8"' : ''}>${revealButton('password', 'password')}</div>
<p class="hint" id="password-hint">${newPassword ? 'Use at least 8 characters.' : 'Passwords are case-sensitive.'}</p></div>`}
${newPassword ? `<div class="field"><label for="confirmation">Confirm password</label><div class="password-field"><input id="confirmation" name="confirmation" type="password" placeholder="Repeat password" autocapitalize="none" spellcheck="false" autocomplete="new-password" required minlength="8">${revealButton('confirmation', 'password confirmation')}</div></div></div>` : ''}
<p id="status" role="status" aria-live="polite">${escape(notice)}</p>
<button class="link" id="cancel-provider" type="button" hidden>Cancel browser sign-in</button>
<button class="submit" type="submit">${submit}</button>
</form>
<p class="switch">${forgot || reset ? '' : signup ? 'Already have an account?' : 'New to dhimantAI?'} <button class="link" id="switch" type="button">${forgot || reset ? 'Back to sign in' : signup ? 'Sign in' : 'Create an account'}</button></p>
</div></section>
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
  form.querySelector('.submit').textContent = value ? '${submitting}' : '${submit}';
}
const cancelProvider = document.getElementById('cancel-provider');
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => {
  if (busy) return;
  setBusy(true);
  form.querySelector('.submit').textContent = '${submit}';
  status.className = ''; status.textContent = 'Continue in your browser, then return to Skilling.';
  cancelProvider.hidden = false; cancelProvider.disabled = false; cancelProvider.focus();
  vscode.postMessage({type:'provider', provider:button.dataset.provider, mode:'${mode}'});
}));
cancelProvider.addEventListener('click', () => {
  cancelProvider.disabled = true;
  vscode.postMessage({type:'cancelProvider'});
});
const authInputErrors = ${authInputErrors.toString()};
function validateFields() {
  const errors = authInputErrors(Object.fromEntries(new FormData(form)), ${forgot || reset ? JSON.stringify(mode) : signup});
  form.querySelectorAll('input').forEach(input => {
    input.setCustomValidity(errors[input.name] || '');
    input.setAttribute('aria-invalid', String(!!errors[input.name]));
  });
  return errors;
}
form.addEventListener('input', validateFields);
form.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const errors = validateFields();
  if (Object.keys(errors).length) { status.textContent = Object.values(errors)[0]; status.className = 'error'; }
  if (!form.reportValidity()) return;
  const message = { type: 'submit', mode: '${mode}', email: document.getElementById('email')?.value, password: password?.value,
    name: document.getElementById('name')?.value, confirmation: confirmation?.value };
  status.textContent = ''; status.className = '';
  setBusy(true);
  vscode.postMessage(message);
});
document.getElementById('switch').addEventListener('click', () => {
  if (busy) return;
  setBusy(true);
  vscode.postMessage({type:'navigate', mode:'${signup || forgot || reset ? 'signIn' : 'signUp'}'});
});
document.getElementById('forgot')?.addEventListener('click', () => {
  if (busy) return;
  setBusy(true);
  vscode.postMessage({type:'navigate', mode:'forgotPassword'});
});
window.addEventListener('message', event => {
  if (event.data?.type === 'courseDestination') {
    document.getElementById('destination').textContent = 'Continue to ' + event.data.title + ' after signing in.';
    return;
  }
  if (event.data?.type !== 'error') return;
  cancelProvider.hidden = true;
  setBusy(false);
  if (password) password.value = ''; if (confirmation) { confirmation.value = ''; confirmation.setCustomValidity(''); }
  status.className = 'error'; status.textContent = event.data.message;
  (password || document.getElementById('email')).focus();
});
document.getElementById('${signup ? 'name' : reset ? 'password' : 'email'}').focus({preventScroll: true});
</script></body></html>`;
}
