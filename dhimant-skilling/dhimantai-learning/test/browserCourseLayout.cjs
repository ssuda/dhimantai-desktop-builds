// Chromium layout check for the actual player, with a local ERPNext form/dialog fixture.
const {chromium}=require('playwright-core');
const {readFileSync,mkdirSync}=require('node:fs');
const {createServer}=require('node:http');
const assert=require('node:assert/strict');
const {resolve}=require('node:path');
const base=resolve(__dirname,'../media/browser');
const output=process.env.ERP_LAYOUT_ARTIFACTS||'/tmp/dhimantai-feedback-layout';
const course=JSON.parse(readFileSync(base+'/erpnext/course.json'));
const html=`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:20px;font:14px system-ui}input{width:100%;box-sizing:border-box}.modal{position:fixed;inset:20px;z-index:1050;background:white;box-shadow:0 0 0 50px #0005;padding:16px}.modal button{position:absolute;bottom:16px;right:16px;padding:12px}</style></head><body><h2>Company accounts</h2><label>Currency<input id="currency" value="INR"></label><div id="modal" class="modal" hidden><h3>ERPNext dialog</h3><p>Confirm this field change.</p><button id="confirm">Confirm</button></div></body></html>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try {
 const page=await browser.newPage({viewport:{width:420,height:650}});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(course=>{
 const company={doctype:'Company',name:'Training 0123456789',default_currency:'INR',default_receivable_account:'Debtors - 0123456789',default_payable_account:'Creditors - 0123456789'};
 window.frappe={session:{user:'learner-0123456789abcdef0123@training.invalid'},ui:{form:{}},datetime:{get_today:()=> '2026-11-13'},get_route:()=>['Form','Company',company.name]};
 window.cur_frm={doctype:'Company',doc:company,is_new:()=>false,is_dirty:()=>false,fields_dict:{default_currency:{wrapper:document.querySelector('#currency')}}};
 sessionStorage.setItem('dhimantai-erpnext-instructor',JSON.stringify({origin:'http://127.0.0.1:40000',token:'a'.repeat(64),learner:'0123456789abcdef0123'}));
 window.fetch=async url=>({ok:true,text:async()=>JSON.stringify(course),json:async()=>url.endsWith('/state')?{connected:false,detail:'Instructor could not receive this task. Reconnect to retry.'}:{data:company,ok:true}});
 document.getElementById('confirm').onclick=()=>{window.confirmed=true;document.getElementById('modal').hidden=true;};
 },course);
 for(const file of ['apps/frappe.js','player/guide.js','player/live.js'])await page.addScriptTag({path:base+'/'+file});
 await page.waitForFunction(()=>!!window.dhimantaiErpGuide);
 await page.evaluate(()=>window.dhimantaiErpGuide.continueTask('company'));
 await page.waitForFunction(()=>{const root=document.querySelector('#dhimantai-guide').shadowRoot;return root.querySelector('#ask-instructor').disabled===false && root.querySelector('#live-status').textContent.includes('Reconnect');});
 mkdirSync(output,{recursive:true});
 for(const width of [320,420,720]){
 await page.setViewportSize({width,height:650});
 const check=page.getByRole('button',{name:'Check saved work',exact:true});
 await check.scrollIntoViewIfNeeded();assert.equal(await check.isEnabled(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(await page.locator('#dhimantai-guide').evaluate(host=>{const el=host.shadowRoot.querySelector('section');return el.scrollWidth>el.clientWidth}),false);
 await page.screenshot({path:resolve(output,'erp-'+width+'.png')});
 await page.evaluate(()=>document.getElementById('modal').hidden=false);
 await page.getByRole('button',{name:'Confirm',exact:true}).click({timeout:3000});
 assert.equal(await page.evaluate(()=>window.confirmed),true);
 }
 console.log('Chromium: 320, 420 and 720px layouts pass; saved-work check and dialog confirmation remain reachable.');
 } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
