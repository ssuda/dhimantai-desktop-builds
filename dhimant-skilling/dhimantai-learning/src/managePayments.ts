import type {LearningPurchases} from './api';
import {accessPeriod, CatalogCourse} from './learnerCatalog';
import {priceLabel} from './learningBilling';
import {UI_TOKENS} from './uiTheme';
import {paymentsClient} from './paymentsClient';

type Purchase = LearningPurchases['purchases'][number];
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));
const date = (value: string) => new Date(value).toLocaleString('en-IN', {dateStyle:'medium', timeStyle:'short'});
const shortDate = (value: string) => new Date(value).toLocaleDateString('en-IN', {dateStyle:'medium'});
const hasReceipt = (p: Purchase) => p.status === 'paid' || p.status === 'refunded';
const group = (p: Purchase) => p.status === 'paid' || p.status === 'refunded' ? p.status
  : p.status === 'created' && p.attempt_state === 'failed' ? 'failed' : 'pending';
const labels = {paid:'Paid', refunded:'Refunded', failed:'Failed', pending:'Pending'};
export const canResumePurchase = (p: Purchase) => p.status === 'created' && p.can_resume === true && p.attempt_state !== 'processing';

function accessLabel(p: Purchase, course?: CatalogCourse) {
  if (course?.expired && course.access_until) return 'Access ended ' + shortDate(course.access_until);
  if (course?.unlocked || (course?.access_until && course.unlocked === undefined && p.status === 'paid'))
    return course.access_until ? accessPeriod(course) : 'Active access';
  if (course?.enrolled && course.access_until) return 'First chapter until ' + shortDate(course.access_until);
  if (p.status === 'refunded') return 'Purchase refunded';
  if (p.status === 'paid') return 'Access unconfirmed';
  return 'Awaiting payment';
}

function purchaseRow(p: Purchase, courses: Map<string, CatalogCourse>, ready: boolean) {
  const status = group(p), price = escape(priceLabel(p.amount, p.currency)), id = escape(p.id);
  const access = p.course_ids.map(id => ({title:courses.get(id)?.title ?? id, label:accessLabel(p, courses.get(id))}));
  const periods = new Set(access.map(entry => entry.label));
  const validity = periods.size === 1 ? access[0].label : 'See course details';
  const field = (name: string, value: string) => `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`;
  const receipt = hasReceipt(p) ? `<button class="secondary" data-action="receipt" data-id="${id}">Download Receipt</button>` : '';
  const checkout = ready && canResumePurchase(p)
    ? `<button data-action="resume" data-id="${id}">${status === 'failed' ? 'Retry Payment' : 'Complete Payment'}</button>` : '';
  const pendingNote = p.status === 'creating' ? 'Confirming checkout' : p.status === 'created' && p.attempt_state === 'processing' ? 'Confirming payment' : '';
  return `<tr data-group="${status}">
    <th scope="row">${escape(p.title)}</th><td data-label="Amount" class="amount">${price}</td>
    <td data-label="Purchase date"><time datetime="${escape(p.created_at)}">${escape(shortDate(p.created_at))}</time></td>
    <td data-label="Payment status"><span class="badge ${status}">${labels[status]}</span>${pendingNote ? `<small>${pendingNote}</small>` : ''}</td>
    <td data-label="Access validity">${escape(validity)}</td>
    <td class="row-actions"><div class="buttons">${checkout}${receipt}<button class="text-button" data-details aria-haspopup="dialog" aria-controls="detail-${id}">View Details</button></div>
    <dialog id="detail-${id}" aria-labelledby="title-${id}"><form method="dialog"><button class="secondary" autofocus>Close</button></form>
      <h2 id="title-${id}">${escape(p.title)}</h2><dl class="fields">
      ${field('Purchase reference', p.id)}${field('Amount', priceLabel(p.amount, p.currency))}
      ${field('Payment status', pendingNote || labels[status])}${field('Purchase date', date(p.created_at))}
      ${p.paid_at ? field('Paid on', date(p.paid_at)) : ''}${p.razorpay_payment_id ? field('Payment reference', p.razorpay_payment_id) : ''}
      </dl><h3>Course access</h3><dl class="fields">${access.map(entry => field(entry.title, entry.label)).join('')}</dl>
      </dialog></td></tr>`;
}

export function paymentsHtml(billing: LearningPurchases | undefined, courses: CatalogCourse[], signedIn: boolean, loading = false) {
  if (loading) return '';
  if (!signedIn) return '<p>Sign in to view your payments.</p>';
  if (!billing) return '<p>Purchases could not be loaded. Select Refresh Status to try again.</p>';
  const purchases = billing.purchases, counts = {paid:0, pending:0, failed:0, refunded:0, all:purchases.length};
  for (const p of purchases) counts[group(p)]++;
  const tabs = [['all','All Purchases'], ['paid','Completed'], ['pending','Pending'], ['failed','Failed']] as const;
  const summary = [['paid','Paid'], ['pending','Pending'], ['failed','Failed'], ['all','Total Purchases']] as const;
  const byId = new Map(courses.map(course => [course.id, course]));
  return `<dl class="summary" aria-label="Payment summary">${summary.map(([key,label]) =>
    `<div class="${key}"><dt>${label}</dt><dd>${counts[key]}</dd></div>`).join('')}</dl>
    ${billing.payments_ready ? '' : '<p>Checkout is currently unavailable.</p>'}
    <div role="tablist" aria-label="Filter purchases">${tabs.map(([key,label], index) =>
      `<button role="tab" id="tab-${key}" aria-controls="history" aria-selected="${!index}" tabindex="${index ? -1 : 0}" data-filter="${key}">${label}</button>`).join('')}</div>
    <section id="history" role="tabpanel" aria-labelledby="tab-all" tabindex="0">
    <table aria-label="Purchase history"${purchases.length ? '' : ' hidden'}><thead><tr>${['Course / purchase','Amount','Purchase date','Payment status','Access validity','Actions']
      .map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>
    ${purchases.map(p => purchaseRow(p, byId, billing.payments_ready)).join('')}</tbody></table>
    <p id="payment-empty" role="status"${purchases.length ? ' hidden' : ''}>No purchases yet.</p></section>`;
}

interface PaymentPage {
  nonce: string; scope: string; environment: string; account?: string; accountLabel?: string;
  billing?: LearningPurchases; courses: CatalogCourse[]; message: string; loading: boolean;
}

export function paymentsPage(page: PaymentPage) {
  const {nonce, account, accountLabel, environment, billing, courses, loading} = page;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Manage payments</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
    <style nonce="${nonce}">${UI_TOKENS}
    *{box-sizing:border-box}body{margin:0;padding:clamp(14px,3vw,44px);font:var(--vscode-font-size,14px)/1.5 var(--vscode-font-family,system-ui);
      color:var(--vscode-foreground);background:var(--vscode-editor-background)}
    main{max-width:1440px;margin:auto}h1{font-size:clamp(24px,3vw,32px);line-height:1.2;margin:0}h2{font-size:1.45em}h3{font-size:1.08em}
    header,.heading,.buttons{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 16px}
    header{border-bottom:1px solid var(--dh-border);padding-bottom:12px;color:var(--dh-muted)}.heading{margin:24px 0 16px}.buttons{justify-content:flex-start;gap:6px 10px}
    button{font:inherit;font-weight:550;line-height:1.3;min-height:32px;cursor:pointer;padding:6px 12px;border-radius:var(--dh-radius-sm);
      border:1px solid var(--dh-button-border);background:var(--dh-accent);color:var(--dh-accent-fg)}
    button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.65;cursor:wait}
    .secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--dh-border)}
    .secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .text-button{padding:4px;color:var(--vscode-textLink-foreground);background:transparent;border-color:transparent}.text-button:hover{background:transparent;text-decoration:underline}
    :focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}[hidden]{display:none!important}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 22px}
    .summary div{padding:12px 16px;border:1px solid var(--dh-border);border-radius:var(--dh-radius);background:var(--dh-surface)}
    .summary dt,.badge{display:flex;align-items:center;gap:7px;font-weight:600}.summary dt{font-size:.94em}
    .summary dd{font-size:1.8em;font-weight:650;line-height:1.2;margin:5px 0 0;font-variant-numeric:tabular-nums}
    .paid{--mark:var(--dh-success)}.pending{--mark:var(--vscode-charts-orange)}.failed{--mark:var(--vscode-testing-iconFailed)}.all{--mark:var(--dh-accent)}
    .summary dt::before,.badge::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mark,var(--dh-muted))}
    [role=tablist]{display:flex;gap:2px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--dh-border)}
    [role=tab]{border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--dh-muted);padding:8px 12px}
    [role=tab]:hover{background:var(--vscode-toolbar-hoverBackground)}[role=tab][aria-selected=true]{border-color:var(--dh-accent);color:var(--vscode-foreground);font-weight:650}
    table{width:100%;border-collapse:collapse;text-align:left}thead{background:var(--dh-surface);color:var(--dh-muted)}th,td{padding:12px 10px;border-bottom:1px solid var(--dh-border);vertical-align:middle}
    thead th{font-size:.9em}th[scope=row]{width:25%;overflow-wrap:anywhere}.amount{font-variant-numeric:tabular-nums;white-space:nowrap}
    .badge{display:inline-flex;padding:2px 8px;border-radius:12px;background:color-mix(in srgb,var(--mark,var(--dh-muted)) 12%,transparent);white-space:nowrap}
    small{display:block;color:var(--dh-muted)}#status-message:empty{display:none}.account{overflow-wrap:anywhere}.row-actions button{font-size:.95em}
    dialog{width:min(480px,calc(100% - 24px));max-height:90vh;overflow:auto;padding:22px;border-radius:var(--dh-radius);border:1px solid var(--dh-border);
      color:var(--vscode-foreground);background:var(--vscode-editor-background);box-shadow:var(--dh-shadow)}dialog::backdrop{background:rgb(0 0 0 / .5)}
    dialog form{float:right;margin:0 0 8px 12px}dialog h2{margin:0 0 16px;overflow-wrap:anywhere}.fields{clear:both}
    .fields div{display:grid;grid-template-columns:2fr 3fr;gap:12px;padding:7px 0;border-bottom:1px solid var(--dh-border)}
    .fields dt{color:var(--dh-muted)}.fields dd{margin:0;overflow-wrap:anywhere}
    @media(max-width:760px){thead{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}
      table,tbody{display:block}tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;padding:12px 0;border-bottom:1px solid var(--dh-border)}
      tbody th,tbody td{padding:0;border:0}th[scope=row],.row-actions{width:auto;grid-column:1/-1}td[data-label]::before{content:attr(data-label);display:block;color:var(--dh-muted);font-size:.86em}
      .row-actions{padding-top:4px}}
    @media(max-width:480px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.summary div{padding:8px 12px}
      [role=tab]{padding:7px 6px}.heading{margin-top:16px}header .buttons{gap:5px}.fields div{grid-template-columns:1fr;gap:2px}}
    @media(forced-colors:active){[role=tab][aria-selected=true]{border-color:Highlight}.badge{border:1px solid CanvasText}}
    </style></head><body><main id="manage-payments" data-scope="${escape(page.scope)}"><header>
    <button class="text-button" data-action="catalog">← Back to courses</button><div class="buttons">
    ${environment !== 'production' ? `<span>${escape(environment)} service</span>` : ''}
    ${accountLabel ? `<span class="account">${escape(accountLabel)}</span>` : ''}
    <button class="secondary" data-action="${account ? 'signOut' : 'signIn'}">${account ? 'Sign out' : 'Sign in'}</button></div></header>
    <div class="heading"><h1>Manage payments</h1>${account ? `<button class="secondary" data-action="refresh"${loading ? ' disabled' : ''}>Refresh Status</button>` : ''}</div>
    <p id="status-message" role="status">${escape(page.message)}</p>
    ${paymentsHtml(billing, courses, !!account, loading)}</main>
    <script nonce="${nonce}">(${paymentsClient.toString()})();</script></body></html>`;
}
