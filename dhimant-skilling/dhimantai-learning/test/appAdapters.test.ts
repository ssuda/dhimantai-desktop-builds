import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {FrappeServer} from '../src/apps/frappe';
import {OdooServer, viewFields} from '../src/apps/odoo';
import {appServer} from '../src/apps';

const json=(body:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status:200,headers});

test('Odoo form views yield the fields a person sees, with each table’s list columns but not its detail form',()=>{
  const arch=`<form><header><button name="action_confirm" type="object" string="Confirm"/></header><sheet>
    <field name="name"/><field name="partner_id" widget="res_partner_many2one"/><field name="secret" invisible="1"/>
    <field name="note" invisible="state != 'draft'"/>
    <notebook><page string="Lines"><field name="order_line" mode="list">
      <form><field name="detail_only"/></form>
      <list editable="bottom"><field name="product_id"/><field name="product_uom_qty"/><field name="internal" column_invisible="True"/></list>
    </field></page></notebook><field name="amount_total"/></sheet></form>`;
  const {fields,rows}=viewFields(arch);
  assert.deepEqual(fields,['name','partner_id','note','order_line','amount_total']);
  assert.deepEqual(rows.get('order_line'),['product_id','product_uom_qty']);
});

test('Frappe metadata becomes the common form shape with tabs, link targets, choices and table rows',async()=>{
  const docs=[{name:'Purchase Receipt',is_submittable:1,fields:[
      {fieldname:'details',fieldtype:'Tab Break',label:'Details'},{fieldname:'supplier',fieldtype:'Link',options:'Supplier',reqd:1,label:'Supplier'},
      {fieldname:'cb',fieldtype:'Column Break'},{fieldname:'status',fieldtype:'Select',options:'\nDraft\nCompleted',read_only:1},
      {fieldname:'items',fieldtype:'Table',options:'Purchase Receipt Item',reqd:1,label:'Items'}]},
    {name:'Purchase Receipt Item',fields:[{fieldname:'qty',fieldtype:'Float',label:'Quantity'},{fieldname:'purchase_order',fieldtype:'Link',options:'Purchase Order'}]}];
  const request=(async(url:string)=>url.endsWith('/api/method/login')?json({},{'set-cookie':'sid=abc; Path=/'}):json({docs})) as typeof fetch;
  const form=await new FrappeServer('http://erp','Administrator','pw',request).describe('Purchase Receipt');
  assert.deepEqual(form.actions,[{name:'submit',label:'Submit'}]);
  assert.deepEqual(form.fields.map(f=>[f.name,f.type,f.required,f.group]),[['supplier','link',true,'Details'],['status','select',false,'Details'],['items','table',true,'Details']]);
  assert.deepEqual(form.fields[1].options,['Draft','Completed']);
  assert.deepEqual(form.fields[2].fields?.map(f=>[f.name,f.type,f.target]),[['qty','number',undefined],['purchase_order','link','Purchase Order']]);
});

test('Odoo records read as people name them, and ownership comes from the creating login',async()=>{
  const calls:string[]=[];
  const request=(async(url:string,init:any)=>{
    if(url.endsWith('/web/session/authenticate'))return json({result:{uid:2}},{'set-cookie':'session_id=s1; Path=/'});
    const {model,method,args,kwargs}=JSON.parse(init.body).params;calls.push(`${model}.${method}`);
    if(method==='fields_get')return json({result:model==='sale.order'
      ?{partner_id:{type:'many2one',relation:'res.partner',string:'Customer'},order_line:{type:'one2many',relation:'sale.order.line',string:'Lines'},state:{type:'selection',string:'Status'},create_uid:{type:'many2one',relation:'res.users',string:'Created by'}}
      :{product_id:{type:'many2one',relation:'product.product',string:'Product'},product_uom_qty:{type:'float',string:'Quantity'}}});
    if(method==='read'&&model==='sale.order')return json({result:args[0][0]===7?[{id:7,partner_id:[3,'Training Customer x'],order_line:[11],state:'sale',create_uid:[9,'Learner']}]:[]});
    if(method==='read')return json({result:[{id:11,product_id:[5,'Training Widget'],product_uom_qty:2}]});
    if(method==='search_read')return json({result:kwargs&&args[0][0][2]==='learner@training.invalid'?[{id:9}]:[]});
    return json({error:{data:{message:'unexpected'}}});
  }) as typeof fetch;
  const odoo=appServer({app:'odoo',url:'http://odoo',db:'training',user:'admin',password:'pw'},request) as OdooServer;
  const order=await odoo.read('sale.order','7');
  assert.equal(order?.partner_id,'Training Customer x');assert.equal(order?.state,'sale');
  assert.deepEqual((order?.order_line as any[]).map(r=>[r.product_id,r.product_uom_qty]),[['Training Widget',2]]);
  assert.equal(await odoo.read('sale.order','not-a-number'),undefined);
  assert.equal(await odoo.createdBy(order!,'learner@training.invalid'),true);
  assert.equal(await odoo.createdBy(order!,'someone@else'),false);
  assert.throws(()=>appServer({app:'odoo',url:'x',user:'a',password:'b'}),/database name/);
});
