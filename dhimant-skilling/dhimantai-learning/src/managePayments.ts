import type {LearningPurchases} from './api';
import {accessPeriod, CatalogCourse} from './learnerCatalog';
import {priceLabel} from './learningBilling';
type Purchase=LearningPurchases['purchases'][number];
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date=(value:string)=>new Date(value).toLocaleString('en-IN');
export const paymentStatus={paid:'Paid',refunded:'Refunded',created:'Awaiting payment',creating:'Confirming checkout'};
export function paymentReceipt(purchase:Purchase) {
  if(!['paid','refunded'].includes(purchase.status))throw new Error('A receipt is available after payment is confirmed.');
  return ['dhimantAI · Payment receipt','Optficial Labs Pvt Ltd',purchase.title,
    'Amount: '+priceLabel(purchase.amount,purchase.currency),'Status: '+paymentStatus[purchase.status],
    'Purchase reference: '+purchase.id,'Checkout created: '+date(purchase.created_at),
    ...(purchase.paid_at?['Paid: '+date(purchase.paid_at)]:[]),
    ...(purchase.razorpay_payment_id?['Payment reference: '+purchase.razorpay_payment_id]:[]),
    'Payment acknowledgement. This is not a tax invoice.'].join('\n')+'\n';
}
export function paymentsHtml(billing:LearningPurchases|undefined,courses:CatalogCourse[],signedIn:boolean) {
  const purchases=billing?.purchases??[];
  return '<p>Payment status, receipts and current course access.</p>'
    +(!signedIn?'<p>Sign in to view your payments.</p>':!billing?'<p>Payments could not be loaded. Refresh to try again.</p>':!purchases.length?'<p>No purchases yet.</p>':'')
    +purchases.map(p=>`<article class="course"><h3>${escape(p.title)}</h3><p>${escape(priceLabel(p.amount,p.currency))} · ${escape(paymentStatus[p.status]??p.status)}</p>
      <p>Created ${escape(date(p.created_at))}</p><p class="small">Purchase reference: ${escape(p.id)}</p>
      <ul>${p.course_ids.map(id=>{const course=courses.find(c=>c.id===id);return `<li>${escape(course?.title??id)} · ${escape(course?.access_until?accessPeriod(course):p.status==='refunded'?'Access revoked':p.status==='paid'?'Access expiry unavailable; refresh to check':'Access pending payment')}</li>`;}).join('')}</ul>
      ${['paid','refunded'].includes(p.status)?`<button class="secondary" data-action="receipt" data-id="${escape(p.id)}">Save receipt</button>`:''}</article>`).join('');
}
