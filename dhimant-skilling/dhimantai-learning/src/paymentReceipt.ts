import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as pdfMake from 'pdfmake/build/pdfmake.min';
import type {Content, CustomTableLayout, TDocumentDefinitions} from 'pdfmake/interfaces';
import type {LearningPurchases} from './api';
import type {CatalogCourse} from './learnerCatalog';
import {priceLabel} from './learningBilling';

type Purchase = LearningPurchases['purchases'][number];
const media = resolve(__dirname, '../../media');
// The standalone renderer includes its Unicode data in the extension bundle.
const logo = 'auth/dhimantai.png', regular = 'fonts/paper-sans.ttf', bold = 'fonts/paper-sans-bold.ttf';
pdfMake.addVirtualFileSystem(Object.fromEntries([regular, bold, logo].map(file =>
  [file, readFileSync(resolve(media, file), 'base64')])));
pdfMake.setFonts({Receipt: {normal: regular, bold}});

const date = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
function purchaseValidity(purchase: Purchase, course?: CatalogCourse): string {
  if (purchase.status === 'refunded') return 'Ended by refund';
  if (!course?.access_days) return 'Validity unavailable';
  const paid = Date.parse(purchase.paid_at ?? '');
  if (!Number.isFinite(paid)) return course.access_days + ' days from payment';
  // A renewal extends the account's access_until, but belongs to a different receipt.
  return 'Until ' + date.format(paid + course.access_days * 86_400_000);
}

export function receiptCourses(purchase: Purchase, courses: CatalogCourse[]): string[][] {
  const byId = new Map(courses.map(course => [course.id, course]));
  const access = purchase.course_ids.map(id => {
    const course = byId.get(id);
    return [course?.title ?? (purchase.course_ids.length === 1 ? purchase.title : id), purchaseValidity(purchase, course)];
  });
  if (!access.length) access.push([purchase.title, purchaseValidity(purchase)]);
  return access;
}

export async function paymentReceipt(purchase: Purchase, courses: CatalogCourse[]): Promise<Uint8Array> {
  if (purchase.status !== 'paid' && purchase.status !== 'refunded') {
    throw new Error('A receipt is available after payment is confirmed.');
  }
  const muted = '#46576B', blue = '#134E78';
  const ruled: CustomTableLayout = {
    hLineWidth: i => i === 0 ? 0 : 0.5, hLineColor: () => '#C5D3DE', vLineWidth: () => 0,
    paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 7, paddingBottom: () => 7,
  };
  const field = (text: string): Content => ({text, fontSize: 9, color: muted});
  const details = [
    [field('Purchase date'), date.format(new Date(purchase.created_at))],
    ...(purchase.paid_at ? [[field('Paid on'), date.format(new Date(purchase.paid_at))]] : []),
    [field('Purchase reference'), purchase.id],
    ...(purchase.razorpay_payment_id ? [[field('Payment reference'), purchase.razorpay_payment_id]] : []),
  ];
  const receipt: TDocumentDefinitions = {
    pageSize: 'A4', pageMargins: [46, 42, 46, 64], language: 'en-IN',
    info: {title: 'dhimantAI payment receipt', author: 'Optficial Labs Pvt Ltd', subject: purchase.id},
    defaultStyle: {font: 'Receipt', fontSize: 10, color: '#172B40', lineHeight: 1.18},
    content: [
      {columns: [
        {image: logo, width: 56},
        {margin: [0, 10, 0, 0], stack: [
          {text: 'dhimantAI', bold: true, color: blue, fontSize: 19}, field('Optficial Labs Pvt Ltd'),
        ]},
      ], columnGap: 10, margin: [0, 0, 0, 20]},
      {canvas: [{type: 'line', x1: 0, y1: 0, x2: 503, y2: 0, lineWidth: 1.5, lineColor: blue}]},
      {text: 'Payment receipt', bold: true, fontSize: 30, margin: [0, 22, 0, 4]},
      {text: purchase.title, fontSize: 14, margin: [0, 0, 0, 22]},
      {columns: [
        {stack: [field('Amount paid'), {text: priceLabel(purchase.amount, purchase.currency), bold: true, fontSize: 22}]},
        {stack: [field('Payment status'), {text: purchase.status === 'paid' ? 'Paid' : 'Refunded', bold: true, fontSize: 16}]},
      ], margin: [0, 0, 0, 18]},
      {table: {widths: [136, '*'], body: details}, layout: {...ruled, paddingLeft: () => 0}},
      {text: 'Course access', bold: true, fontSize: 16, margin: [0, 24, 0, 8]},
      {table: {widths: ['*', 196], headerRows: 1, dontBreakRows: true, body: [
        ['Course', 'Access validity'].map(text => ({text, bold: true, color: blue, fillColor: '#EDF4F8'})),
        ...receiptCourses(purchase, courses),
      ]}, layout: ruled},
    ],
    footer: (page, total) => ({
      margin: [46, 17, 46, 0], columns: [
        {text: 'Payment acknowledgement. This is not a tax invoice.', width: '*'},
        {text: page + ' / ' + total, alignment: 'right', width: 'auto'},
      ], color: muted, fontSize: 8,
    }),
  };
  return pdfMake.createPdf(receipt).getBuffer();
}
