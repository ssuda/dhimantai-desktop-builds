// Local visual acceptance: compile and bundle authoring first; requires an installed Chrome.
const {chromium}=require('../out/vendor/playwright-core');
const {authoringHtml}=require('../out/src/apps/authoringHtml');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const state={courses:[{id:'erpnext-essentials',title:'ERPNext Essentials'}],chapters:[{id:'customer',chapter_name:'A customer’s first order',guided_form:{id:'customer',doctype:'Customer',title:'Create a customer',scenario:'A local café is buying its first batch of products. Create its customer record so the sales team can prepare an order.',why:'Reuse customer details across sales documents.',guidance:'full',steps:[{field:'customer_name',text:'Give the café a clear training name.',value:'Café {{tag}}'},{field:'customer_type',text:'Choose whether you are selling to a person or a company.',value:'Company',decide:true}],expected:{customer_name:'Café {{tag}}',customer_type:'Company'},explain:'Why did you choose this customer type?'}}],history:[],draft:{course:'erpnext-essentials',chapter:'customer',prompt:'Help a new sales assistant create a customer, choose the right customer type and explain how that record connects to their first order.'},busy:false,notice:'',connected:true,capturing:false,replayed:false};
  const html=authoringHtml(state,'preview').replace('<script nonce="preview">','<script nonce="preview">globalThis.acquireVsCodeApi=()=>({postMessage(){}});');
  for(const width of [480,920]){
   const page=await browser.newPage({viewport:{width,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setContent(html);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No horizontal overflow');
   assert.equal(await page.getByRole('button',{name:'Prepare update',exact:true}).isEnabled(),true);
   assert.equal(await page.getByText('Learner decides',{exact:true}).count(),1);
   await page.screenshot({path:`/tmp/dhimantai-authoring-studio-${width}.png`,fullPage:true});
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Studio visual checks passed at 480 px and 920 px.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
