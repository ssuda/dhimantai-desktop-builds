import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {openInjectedTab} from '../../src/apps/desktopBrowser';
import {connectPlaywright, discoverWebMcp} from '../../src/apps/playwrightBrowser';

export async function run() {
  const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Author training fixture</title><label>Customer name<input aria-label="Customer name"></label>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  let tab:Awaited<ReturnType<typeof openInjectedTab>>,driver:Awaited<ReturnType<typeof connectPlaywright>>|undefined;
  try {
    tab=await openInjectedTab({url:origin,home:'/',media:join(__dirname,'../../../media/browser'),adapter:'frappe',
      server:{app:'fixture',async login(){},sessionCookie(){return undefined;},async describe(){throw new Error('not used');},async read(){return undefined;},async createdBy(){return false;}}});
    assert.ok(tab?.transport,'The desktop exposes its integrated-browser CDP transport');
    driver=await connectPlaywright(tab.transport,origin);
    assert.equal(await driver.page.title(),'Author training fixture');
    await driver.page.getByLabel('Customer name').fill('Studio author');
    assert.equal(await driver.page.getByLabel('Customer name').inputValue(),'Studio author');
    const mcp=await discoverWebMcp(driver.page);assert.ok(['available','empty','unsupported'].includes(mcp.status));
    await driver.close();driver=undefined;
    const reply=await tab.client.call('Runtime.evaluate',{expression:'document.querySelector("input").value',returnByValue:true},tab.sessionId) as any;
    assert.equal(reply.result.value,'Studio author','Disconnect leaves the integrated app open');
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:true,nativePlaywright:true,webmcp:mcp.status}));
  } catch(error) {
    writeFileSync(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:false,error:String(error)}));throw error;
  } finally {await driver?.close();await tab!?.close?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
}
