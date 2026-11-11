/** Authenticated local book fixtures. Production never generates a book from Markdown. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import MarkdownIt = require('markdown-it');
import {JSDOM} from 'jsdom';
const root=join(__dirname,'../../..');
const Zip=require(join(root,'media/study/jszip.min.js'));
export const pdfId='10000000-0000-0000-0000-000000000001';
export const epubId='10000000-0000-0000-0000-000000000002';
export async function studyFixtures(){
  const courses=JSON.parse(await readFile(join(root,'media/study/book_companions.json'),'utf8')).courses;
  const body=Array.from({length:70},(_,i)=>`## Section ${i+1}\n\nLanguage models predict tokens from context. Section ${i+1} has a visible paragraph for navigation checks.\n\n![Token diagram](figure.svg)\n\n<!-- source_pages: ${i+1} -->\n<!-- image_guide\nfig: fig_001\ndescription: hidden metadata\n-->`).join('\n\n');
  return [...courses,{id:'Large Language Models',title:'Large Language Models',reading:[],chapters:[
    {id:pdfId,title:'An Introduction to Large Language Models (PDF)',markdown:'Language models predict tokens from context.',revision:'pdf-v1'},
    {id:epubId,title:'An Introduction to Large Language Models (EPUB)',markdown:body,revision:'epub-v1'},
  ]}];
}
export async function epubFixture(chapter:{id:string;title:string;markdown:string}){
  const zip=new Zip(),markdown=new MarkdownIt({html:true,breaks:true});markdown.use(require('@vscode/markdown-it-katex').default);
  const dom=new JSDOM('<!doctype html><html><head><title></title></head><body></body></html>');
  const doc=dom.window.document;doc.title=chapter.title;doc.body.innerHTML=markdown.render(chapter.markdown);
  const style=doc.createElement('style');style.textContent=await readFile(join(root,'media/study/reader.css'),'utf8');doc.head.append(style);
  const layout=doc.createElement('style');layout.textContent='body{font-family:system-ui;line-height:1.65}img{max-width:100%;height:auto}';doc.head.append(layout);
  const styles=Array.from(doc.querySelectorAll('style'));let styleIndex=0;
  const serialized=new dom.window.XMLSerializer().serializeToString(doc).replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/g,
    (_match,open,close)=>open+'/*<![CDATA[*/'+styles[styleIndex++].textContent+'/*]]>*/'+close);
  zip.file('mimetype','application/epub+zip',{compression:'STORE'});
  zip.file('META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('package.opf',`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Book fixture</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-11-10T00:00:00Z</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="figure" href="figure.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`);
  zip.file('chapter.xhtml',serialized);
  zip.file('figure.svg','<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" fill="#dbeafe"/><text x="20" y="60" font-size="24">Tokens → Context → Prediction</text></svg>');
  for(const entry of Object.values(zip.files) as any[])entry.date=new Date('2026-11-10T00:00:00Z');
  dom.window.close();return zip.generateAsync({type:'nodebuffer'});
}
export function pdfFixture(){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'];
  for(let page=0;page<3;page++){
    const content=`BT /F1 24 Tf 48 720 Td (Language models - page ${page+1}) Tj 0 -45 Td /F1 16 Tf (Language models predict tokens from context.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4+page*2} 0 R >>`,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
}
