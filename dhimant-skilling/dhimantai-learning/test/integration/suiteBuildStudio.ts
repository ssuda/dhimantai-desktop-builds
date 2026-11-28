import {installVoicePeer} from '../voiceRoomFixture';
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {request} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {chromium, type Page} from 'playwright-core';
import type {SpokenReply} from '../../src/coachAudio';
import {StudioJsx} from '../../src/studioJsx';
import {StudioLesson, type StudioService} from '../../src/buildStudio';
import type {StudioAccess,StudioDefinition} from '../../src/studioTypes';
import {StudioRun,studioCheckFeedback,type CheckoutEvidence} from '../../src/studioRuntime';
import {Api} from '../../src/api';
import {EMAIL, PASSWORD} from './contractServer';
import {run as shell} from '../../src/podman';
import {learningFrame} from './learningFrame';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>Promise<T|undefined>,message:string,seconds=25):Promise<T>{
  const limit=Date.now()+seconds*1000;
  while(Date.now()<limit){const result=await read();if(result)return result;await pause(150);}
  throw new Error(message);
}
async function native(page:Page,root:string){
  const component=join(root,'resources/js/ItemCard.jsx');
  assert.ok(!vscode.workspace.textDocuments.some(doc=>doc.fileName===component));
  const doc=await vscode.workspace.openTextDocument(join(root,'resources/js/Desk.jsx'));
  const editor=await vscode.window.showTextDocument(doc,{preview:false});
  assert.equal(vscode.workspace.getConfiguration('editor',doc.uri).get('minimap.enabled'),false);
  const end=doc.positionAt(doc.getText().length);
  await editor.edit(e=>e.insert(end,'\nconst preview = <ItemCa'));
  editor.selection=new vscode.Selection(doc.positionAt(doc.getText().length),doc.positionAt(doc.getText().length));
  async function accept(expected:string){
    await vscode.commands.executeCommand('editor.action.triggerSuggest');
    const item=page.locator('.suggest-widget .monaco-list-row').filter({has:page.getByText('ItemCard',{exact:true})}).first();
    await item.click({timeout:10000});
    await until(async()=>doc.getText().includes(expected) && /import\s*\{\s*ItemCard\s*\}\s*from\s*['"]\.\/ItemCard['"]/.test(doc.getText()),'Missing native completion or import');
  }
  await accept('const preview = <ItemCard');
  assert.ok(!vscode.workspace.textDocuments.some(doc=>doc.fileName===component));
  await until(async()=>await page.locator('.monaco-editor .minimap:visible').count()===0,'Learner editor still shows a minimap');
  await vscode.commands.executeCommand('type',{text:' />;\nconst second = <ItemCa'});await accept('const second = <ItemCard');
  assert.equal((doc.getText().match(/from ['"]\.\/ItemCard['"]/g)??[]).length,1);
  const identifier=doc.getText().lastIndexOf('<ItemCard')+2;
  const defs=await vscode.commands.executeCommand<(vscode.Location|vscode.LocationLink)[]>('vscode.executeDefinitionProvider',doc.uri,doc.positionAt(identifier));
  assert.ok(defs.some(d=>('uri' in d?d.uri:d.targetUri).fsPath===join(root,'resources/js/ItemCard.jsx')));
}
export async function run(){
  const ext=vscode.extensions.getExtension('optficial.dhimantai-learning')!;
  const root=vscode.workspace.workspaceFolders![0].uri.fsPath;
  const def:StudioDefinition=JSON.parse(await readFile(join(ext.extensionPath,'media/build-studio/entries.json'),'utf8'));
  const scenario=process.env.DHIMANTAI_STUDIO_CASE??'native';
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+process.env.DHIMANTAI_CDP_PORT);
  const page=browser.contexts()[0].pages()[0];
  // Keep first-launch extension notifications off the learner controls during UI automation.
  await vscode.commands.executeCommand('notifications.toggleDoNotDisturbMode');
  const bin=process.env.DHIMANTAI_PROJECT_PODMAN??'podman';
  let access:StudioAccess={id:randomUUID(),mode:'guided',entry:'request',lesson:'request',release:{
    version:def.version,image:process.env.DHIMANTAI_STUDIO_IMAGE??'',checkpoints:Object.fromEntries(def.entries.map(e=>[e.checkpoint,e.commit]))}};
  let observed:CheckoutEvidence|undefined;
  let predicted:string|undefined;
  let service:StudioService={studioEntry:async lesson=>({...access,lesson}),studioTurn:async body=>{
    const checkout=(body as {checkout?:CheckoutEvidence}).checkout;
    if(!checkout)return {guidance:'What did you observe in your console?'};
    observed=checkout;predicted=(body as {prediction?:string}).prediction;
    return {guidance:'Practice inventory returned HTTP '+observed.status+' for '+observed.quantity+'. Stock was '+observed.before+' before and '+observed.after+' after.'};
  }};
  if(process.env.DHIMANTAI_STUDIO_TEST_URL && scenario!=='unified'){
    const base=new URL('notebook-coach/project',process.env.DHIMANTAI_STUDIO_TEST_URL).href;
    const post=async(path:string,body:object)=>{
      const res=await fetch(base+path,{method:'POST',headers:{'Authorization':'Bearer '+process.env.DHIMANTAI_STUDIO_TEST_USER,
        'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!res.ok)throw new Error('Project endpoint returned '+res.status);
      return res.json();
    };
    service={
      studioEntry:async(lesson,mode,attempt)=>{
        const result=await post('/equipment-desk/entry',{lesson,mode,attempt}) as StudioAccess;
        return process.env.DHIMANTAI_STUDIO_IMAGE
          ? {...result,release:{...result.release,image:process.env.DHIMANTAI_STUDIO_IMAGE}} : result;
      },
      studioTurn:async(body)=>{
        const reply=await post('',{...body,project_id:'equipment-desk'});
        if('checkout' in body){
          observed=body.checkout as CheckoutEvidence;
          predicted=(body as {prediction?:string}).prediction;
        }
        return reply;
      }
    };
    access=await service.studioEntry('request','guided');
  }
  const context={extensionUri:ext.extensionUri,extensionPath:ext.extensionPath} as vscode.ExtensionContext;
  let saved:ConstructorParameters<typeof StudioLesson>[6]={history:[]};
  const requestedSpeech: SpokenReply[] = [];
  const voice:ConstructorParameters<typeof StudioLesson>[10]={
    account:'test-learner', environment:'local',
    playback:{bind(view,current){
      return view.onDidReceiveMessage(message=>{
        if(message.type!=='audioJoin')return;
        const reply=current();
        assert.ok(reply && reply.id===message.id);
        requestedSpeech.push(reply);
        void view.postMessage({...message,type:'audioError'});
      });
    }},
    dictation:{async voiceInputGrant(language){assert.equal(language, 'te-IN'); return {url:'ws://localhost:7880',token:'test'};}},
  };
  const openLesson=()=>new StudioLesson(context,root,dirname(root),access,def,service,structuredClone(saved),
    async progress=>{saved=structuredClone(progress);},async()=>{},async()=>true,voice,studioSurface);
  const {auth, studioSurface} = await ext.activate();
  let lesson=openLesson();
  try{
    if(scenario==='unified'){
      await auth.signInWithPassword(EMAIL,PASSWORD);
      const originalEntry=Api.prototype.studioEntry, originalRun=StudioRun.start;
      // Exercise actual attempt storage, switches and UI independently of Podman startup.
      // The practice, replay and diagnostic scenarios run the learner app in its pinned image.
      StudioRun.start=async (_root, attempt, _image, kind, revision) => ({
        attempt,kind,revision,url:process.env.DHIMANTAI_TEST_SERVER!,evidence:async()=>null,
        inventory:async()=>new Map([['Camera',3]]),
        check:async()=>studioCheckFeedback({passed:false,observations:[
          {stock:1,quantity:1,expected:201,status:201,stockAndLoans:'0\t1\t1',passed:true},
          {stock:1,quantity:2,expected:409,status:500,stockAndLoans:'1\t1\t1',passed:false},
        ]},revision),
        close:async()=>{},
      } as Pick<StudioRun,'attempt'|'kind'|'revision'|'inventory'|'check'|'close'|'url'|'evidence'> as StudioRun);
      const attempts:string[]=[];
      const entries=new Map<string,StudioAccess['entry']>();
      Api.prototype.studioEntry=async (lesson,mode,attempt) => {
        const id=attempt ?? randomUUID();
        attempts.push(id);
        if (!attempt) entries.set(id,lesson);
        return {...access,id,mode,entry:entries.get(id)!,lesson};
      };
      try {
        // The catalog and sidebar pass the published chapter ID to this command.
        await vscode.commands.executeCommand('dhimantai.openLearningRoom',
          'Web App Development with PHP, Laravel, MySQL & React','6050fa5c-6bfc-5532-a4b9-39e464db5810');
        const walkthrough=await learningFrame(page,'#next');
        await walkthrough.getByRole('button',{name:'Run App',exact:true}).waitFor();
        await walkthrough.getByRole('button',{name:'Continue',exact:true}).click();
        const desk=await learningFrame(page,'#replyType');
        const controller=vscode.window.visibleTextEditors.find(e=>e.document.fileName.endsWith('LoanController.php'))!;
        assert.ok(controller);
        const folder=vscode.workspace.getWorkspaceFolder(controller.document.uri)!;
        assert.equal(await desk.locator('#run').isVisible(),false,'The guided PHP lesson starts with a prediction');
        await desk.locator('#message').fill('I expect the stock to stay the same.');
        await desk.locator('.composer-submit').click();
        await desk.locator('#history').getByText(/Your prediction.*stock to stay the same/).waitFor();
        await desk.locator('#check').click();
        await desk.locator('#history').getByText(/Project check.*Checked revision.*Needs work/).waitFor({timeout:90000});
        const check=desk.locator('#history details').filter({hasText:'Checked revision'});
        await check.locator('summary').click();
        assert.equal(await check.locator('li:visible').count(),2);
        await desk.locator('#history').getByText(/Project Mentor.*available and.*requested/).waitFor();

        await desk.locator('#message').fill('Which case should I trace next?');
        await desk.locator('#run').click();
        const preview=await learningFrame(page,'#back');
        await preview.getByRole('button',{name:'Back to Project Mentor'}).click();
        const returned=await learningFrame(page,'#tools');
        assert.equal(await returned.locator('#message').inputValue(),'Which case should I trace next?');
        assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath,controller.document.uri.fsPath);

        // The old keybinding opens the same surface on a different project.
        await vscode.commands.executeCommand('dhimantai.openProjectCoach', root);
        const personal=await learningFrame(page,'#coach');
        await personal.getByText('Open a file and tell the mentor what you want to build, understand or fix.').waitFor();
        assert.equal(await personal.locator('#step').isVisible(),false);
        assert.equal(await personal.locator('#checkpointDetails').isVisible(),false);
        assert.equal(await personal.locator('#replyType').count(),0);
        await vscode.commands.executeCommand('dhimantai.openBuildStudio',folder.uri);
        const resumed=await learningFrame(page,'#tools');
        await resumed.locator('#history').getByText(/Your prediction.*stock to stay the same/).waitFor();
        assert.deepEqual(attempts,[attempts[0],attempts[0]],'Continuing and reopening reuse the course attempt');
        await vscode.commands.executeCommand('dhimantai.openProjectMentor',{project:'equipment-desk', mode:'independent',fresh:true});
        const independent=await learningFrame(page,'#next:text-is("Open stock task")');
        assert.equal(await independent.locator('#history p').count(),0,'Independent attempt must start fresh');
        await independent.getByRole('button',{name:'Open stock task'}).click();
        const stock=await learningFrame(page,'#check');
        const assignmentFile=vscode.window.activeTextEditor!.document.uri;
        assert.ok(assignmentFile.fsPath.includes(attempts.at(-1)!),'The stock task opens the independent attempt’s source');
        await vscode.commands.executeCommand('dhimantai.openProjectMentor',assignmentFile);
        // The assignment offers the prediction as optional practice. Run App stays available without it.
        await stock.locator('#question').getByText(/^Optional prediction: /).waitFor();
        assert.equal(await stock.locator('#replyType').inputValue(),'ask');
        await stock.getByText('Make checkout handle requests for available and unavailable stock.', {exact:false}).waitFor();
        await stock.getByRole('button',{name:'Run App',exact:true}).click();
        const assignmentPreview=await learningFrame(page,'#back');
        await assignmentPreview.getByRole('button',{name:'Back to Project Mentor'}).click();
        await learningFrame(page,'#check');
        await vscode.commands.executeCommand('dhimantai.openProjectMentor',folder.uri.fsPath);
        const original=await learningFrame(page,'#tools');
        await original.locator('#history').getByText(/Project check.*Checked revision/).waitFor();
        const [guided,,assignment]=attempts;
        assert.notEqual(assignment,guided);
        assert.deepEqual(attempts,[guided,guided,assignment,assignment,guided]);
      } finally { Api.prototype.studioEntry=originalEntry; StudioRun.start=originalRun; }
    }else if(scenario==='checkout'){
      await lesson.open();
      const walkthrough=await learningFrame(page,'#run');
      await walkthrough.getByRole('button',{name:'Run App',exact:true}).click();
      const app=await until(async()=>page.frames().find(f=>/^http:\/\/[a-f0-9-]+\.localhost:\d+\//.test(f.url())),
        'Equipment Desk did not open from the first chapter',90);
      await app.locator('select[name=item]').selectOption({label:'Camera'});
      await app.getByText('Camera · 3 available',{exact:true}).waitFor();
      await app.getByLabel('Borrower alias').fill('chapter-one');
      await app.getByLabel('Quantity').fill('2');
      const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/loans'));
      await app.getByRole('button',{name:'Check out'}).click();
      assert.equal((await response).status(),201);
      await app.getByText('Camera · 1 available',{exact:true}).waitFor();
    }else if(scenario==='native'){await native(page,root);}
    else if(scenario==='voice'){
      await lesson.open();
      const frame=await learningFrame(page,'#tools');
      const form=frame.locator('#composer');
      const mic=form.getByRole('button',{name:'Start microphone'});
      await form.getByRole('button',{name:'Spoken explanation options'}).click();
      assert.ok(await form.getByLabel('Voice playback speed').isVisible());
      await form.getByRole('button',{name:'Spoken explanation options'}).click();
      await form.getByRole('button',{name:'Enable spoken explanations'}).click();
      await until(async()=>requestedSpeech.length===1,'Missing lesson prompt playback');
      assert.equal(requestedSpeech[0].text,def.entries[0].task);
      assert.equal(requestedSpeech[0].path,'/notebook-coach/project/equipment-desk');
      assert.equal(new URLSearchParams(requestedSpeech[0].query).get('attempt'),access.id);
      await form.getByRole('button',{name:'Retry spoken explanation'}).waitFor();
      assert.ok(await form.locator('#audio-status').isVisible());
      await form.getByRole('button',{name:'Spoken explanation options'}).click();
      await form.getByRole('button',{name:'System default',exact:true}).click();
      await until(async()=>requestedSpeech.length===2,'Selecting an output did not retry the current reply');
      assert.equal(requestedSpeech[1].id,requestedSpeech[0].id);
      await frame.evaluate(`(${installVoicePeer})(window)`);
      await frame.evaluate(()=>{
        const w = window as any;
        w.navigator.mediaDevices.getUserMedia = async () => new MediaStream([new w.MediaStreamTrackGenerator({kind:'audio'})]);
      });
      await form.getByLabel('Spoken language').selectOption('te-IN');
      assert.equal(await form.getByLabel('Voice input').count(),0);
      const dictate=async()=>{
        await mic.click();
        await form.getByRole('button',{name:'Finish speaking'}).waitFor();
        await frame.evaluate(() => (window as any).finishTestUtterance('My voice draft','te-IN'));
      };
      await dictate();
      await until(async()=>requestedSpeech.some(r=>r.text==='What did you observe in your console?'),'Missing Instructor reply playback');
      assert.equal(new URLSearchParams(requestedSpeech.at(-1)!.query).get('language'), 'te-IN');
      await frame.locator('#next').click();
      await form.locator('#replyType').waitFor();
      await dictate();
      await frame.locator('#history p').filter({hasText:'Your prediction · My voice draft'}).waitFor();
    }
    else if(scenario==='cell'){
      await lesson.open(false);
      const frame=await learningFrame(page,'#tools');
      await frame.getByText('Project Console',{exact:true}).click();
      assert.equal(await frame.locator('.practice-code-editor').count(),1);
      assert.equal(await frame.locator('#composer').count(),1);
      await frame.getByLabel('Code cell language').selectOption('jsx');
      const text=frame.locator('.cm-content');
      await text.click();await page.keyboard.insertText('const preview = <ItemCa');
      async function accept(){
        await text.press('Control+Space');
        const row=frame.locator('.cm-completionLabel').filter({hasText:/^ItemCard$/});
        await row.first().click({timeout:12000});
        await until(async()=>!!(await text.textContent())?.includes('from "./ItemCard"')||!!(await text.textContent())?.includes("from './ItemCard'"),'Missing cell import');
      }
      await accept();await text.press('Mod+z'.replace('Mod',process.platform==='darwin'?'Meta':'Control'));
      assert.equal(await text.textContent(),'const preview = <ItemCa');
      await accept();await page.keyboard.insertText(' />;\nconst second = <ItemCa');await accept();
      assert.equal(((await text.textContent())??'').match(/from ['"]\.\/ItemCard['"]/g)?.length,1);
      const sdk:typeof import('typescript')=require(join(vscode.env.appRoot,'extensions/node_modules/typescript/lib/typescript.js'));
      const config=sdk.readConfigFile(join(root,'jsconfig.json'),sdk.sys.readFile);
      const options=sdk.parseJsonConfigFileContent(config.config,sdk.sys,root).options;
      const imported=(await text.textContent())!.match(/from ["']([^"']+)["']/)![1];
      assert.equal(sdk.resolveModuleName(imported,join(root,'resources/js/desk-cell.jsx'),options,sdk.sys).resolvedModule?.resolvedFileName,
        join(root,'resources/js/ItemCard.jsx'));
      assert.ok(!(await readFile(join(root,'resources/js/Desk.jsx'),'utf8')).includes('ItemCard'));
      assert.ok(!vscode.workspace.textDocuments.some(doc=>doc.fileName.endsWith('/ItemCard.jsx')));
      // Hold the provider's resolved auto-import until after the learner edits the cell.
      await text.fill('const stale = <ItemCa');
      await text.press('End');
      await text.press('Control+Space');
      const choice=frame.locator('.cm-completionLabel').filter({hasText:/^ItemCard$/}).first();
      await choice.waitFor();
      const originalResolve=StudioJsx.prototype.resolve;
      let release: (()=>void) | undefined;
      StudioJsx.prototype.resolve=async function(...args){
        const edits=await originalResolve.call(this,...args);
        await new Promise<void>(resolve=>{release=resolve;});
        return edits;
      };
      try {
        await choice.click();
        await until(async()=>release,'The provider did not resolve the pending import');
        await text.press('End');await page.keyboard.insertText('Edited');
        assert.equal(await text.textContent(),'const stale = <ItemCaEdited');
        release!();await pause(200);
      } finally { release?.();StudioJsx.prototype.resolve=originalResolve; }
      assert.equal(await text.textContent(),'const stale = <ItemCaEdited');

    }else if(scenario==='console'){
      assert.ok(process.env.DHIMANTAI_STUDIO_TEST_URL);
      await lesson.open();
      const frame=await learningFrame(page,'#consoleBox');
      for(const language of ['sql','php']){
        await frame.locator('#message').fill(language);
        await frame.locator('.composer-submit').press('Enter');
        await until(async()=>await frame.locator('#originChoice').isVisible() &&
          await frame.getByLabel('Code cell language').inputValue()===language, 'The Instructor did not present the example');
        assert.equal(await frame.locator('.practice-code-editor').count(),1);
        assert.equal(await frame.getByLabel('Run against').count(),0);
        const buffer=frame.locator('.cm-content');
        const source=(await buffer.innerText()).replace("'Camera'",'"Tripod"').replace("'name'",'"name"');
        await buffer.fill(language==='sql'?source.replace(/\s*=\s*/,'=').replace(/;$/,''):'<?php\n'+source);
        await frame.locator('.practice-code-editor').getByRole('button',{name:'Run',exact:true}).click();
        await frame.locator('.practice-output').filter({hasText:'5'}).waitFor({timeout:60000});
        await until(async()=> (await frame.locator('#history').innerText()).includes(
          language==='php'?'PHP returned the count as an integer.':'5 available for Tripod.'),'Missing grounded console observation');
      }
      const container=await shell(bin,['ps','-q','--filter','label=ai.dhimant.attempt='+access.id]);
      const cameras=()=>shell(bin,['exec',container,'python3','-c',"import sys;sys.path.insert(0,'/opt/build-studio');from runtime import sql;print(sql(\"SELECT available FROM items WHERE name='Camera'\"))"]);
      const run=frame.locator('.practice-code-editor').getByRole('button',{name:'Run',exact:true});
      for(const tag of ['', '<?php\n']){
        const line=tag?3:2;
        await frame.locator('.cm-content').fill(tag+"$missing = 'unknown';\n\\App\\Models\\Item::where('name', $missing)->firstOrFail();");
        await run.click();
        await frame.locator('.practice-output').filter({hasText:'ModelNotFoundException · line '+line}).waitFor();
        await frame.locator('#history').filter({hasText:'The snippet reported an error on line '+line+'.'}).waitFor();
      }
      await frame.locator('.cm-content').fill("file_put_contents('console-note.txt',str_repeat('x',100000)); return \\App\\Models\\Item::where('name','Camera')->increment('available');");
      assert.equal(await cameras(),'3');
      await run.click();
      await until(async()=>await cameras()==='4','The edited Instructor example did not update the live project');
      assert.equal(await shell(bin,['exec',container,'stat','--format=%s','/course/console-note.txt']),'100000');
      await frame.locator('#origin').selectOption('own');
      assert.equal(await frame.locator('.cm-content').textContent(),'');
      await frame.getByLabel('Code cell language').selectOption('sql');
      await frame.locator('.cm-content').fill('SELECT 5 AS available');
      const prior=saved.history.length;
      await run.click();
      await until(async()=>saved.history.length>prior,'The learner query had no Instructor reply');
      assert.match(saved.history.at(-1)!,/The snippet ran in your desk/);
      await frame.locator('.cm-content').fill('UPDATE items SET available=available+1;');
      await frame.locator('.practice-code-editor').getByRole('button',{name:'Run',exact:true}).click();
      await until(async()=>await cameras()==='5','The learner SQL update was not visible to a fresh connection');
    }else if(scenario==='languages'){
      const model=join(root,'app/Models/Item.php');
      const original=await readFile(model,'utf8');
      await writeFile(model,original.replace(/}\s*$/, '    public function loanWindowForDesk(): int {return 1;}\n}\n'));
      await lesson.open();
      const frame=await learningFrame(page,'#consoleBox');
      await frame.getByText('Project Console',{exact:true}).click();
      const language=frame.getByLabel('Code cell language');
      const text=frame.locator('.practice-buffer .cm-content');
      const container=await shell(bin,['ps','-q','--filter','label=ai.dhimant.attempt='+access.id]);
      assert.ok(container);
      await shell(bin,['exec',container,'python3','-c',"import sys;sys.path.insert(0,'/opt/build-studio');from runtime import sql;sql('ALTER TABLE items ADD COLUMN desk_serial_hint INT','desk')"]);
      const provider=vscode.extensions.getExtension<{
        complete(uri:vscode.Uri,language:string,source:string,offset:number):Promise<unknown[]>
      }>('optficial.equipment-desk-languages')!.exports;
      for(const [lang,prefix,word] of [['php','$item->loanWindowF','loanWindowForDesk'],['php','<?php\n$item->loanWindowF','loanWindowForDesk'],['sql','SELECT desk_serial_h','desk_serial_hint']]){
        const complete=provider.complete;
        const calls:{source:string;offset:number}[]=[];
        provider.complete=(uri,language,source,offset)=>{
          calls.push({source,offset});
          return complete(uri,language,source,offset);
        };
        try{
          await language.selectOption(lang);
          await text.fill('');await text.click();await page.keyboard.insertText(prefix);
          const row=frame.locator('.cm-completionLabel').filter({hasText:new RegExp('^'+word+'$')}).first();
          await text.press('Control+Space');
          await row.click({timeout:10000});
          const expected=(lang==='php' && !prefix.startsWith('<?php')?'<?php\n':'')+prefix;
          assert.ok(calls.some(call=>call.source===expected && call.offset===expected.length));
        }finally{provider.complete=complete;}
        assert.equal(await text.innerText(),prefix.replace(/[a-zA-Z_]+$/,word));
        const file=join(root,(prefix.startsWith('<?php')?'tagged-completion.':'completion.')+lang);
        await writeFile(file,(lang==='php'&&!prefix.startsWith('<?php')?'<?php\n':'')+prefix);
        const doc=await vscode.workspace.openTextDocument(file);
        const editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
        const end=doc.positionAt(doc.getText().length);editor.selection=new vscode.Selection(end,end);
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await page.locator('.suggest-widget .monaco-list-row').filter({has:page.getByText(word,{exact:true})}).first().click();
        assert.ok(doc.getText().endsWith(word));
        await lesson.open(false);
      }
    }else if(scenario==='replay'){
      // The same response can be committed on the service and lost on the way to the desktop.
      const delivered:string[]=[];
      const originalTurn=service.studioTurn;
      service.studioTurn=async body=>{
        const reply=await originalTurn(body);
        if('checkout' in body && 'turn' in body){
          const event=body.checkout as CheckoutEvidence;
          assert.equal(body.turn,event.request);
          delivered.push(event.request);
          if(delivered.length===1)throw new Error('Test interrupted the reply');
        }
        return reply;
      };
      const routes=join(root,'routes/web.php');
      await writeFile(routes,(await readFile(routes,'utf8'))+
        "\nRoute::match(['GET','HEAD','PUT','PATCH','DELETE','OPTIONS'], '/preview-info', function (\\Illuminate\\Http\\Request $r) {\n"+
        "    return response()->json(['method'=>$r->method(),'url'=>url('/items'),'body'=>$r->getContent()])->header('X-Preview-Host',$r->getHttpHost());\n});\n");
      await lesson.open();
      const frame=await learningFrame(page,'#run');
      await frame.locator('#run').click();
      const preview=await until(async()=>page.frames().find(f=>/^http:\/\/[a-f0-9-]+\.localhost:\d+\//.test(f.url())),'Preview did not open',90);
      const origin=new URL(preview.url());
      const token=await preview.locator('meta[name="csrf-token"]').getAttribute('content');
      assert.ok(token);
      for(const method of ['GET','HEAD','PUT','PATCH','DELETE','OPTIONS']){
        const result:{status:number;host:string|null;body:string}=await preview.evaluate(async({method,token})=>{
          const res=await fetch('/preview-info',{method,headers:{'X-CSRF-TOKEN':token},body:['HEAD','GET'].includes(method)?undefined:'sample'});
          return {status:res.status,host:res.headers.get('X-Preview-Host'),body:await res.text()};
        },{method,token});
        assert.equal(result.status,200);
        assert.equal(result.host,origin.host);
        if(method==='HEAD')assert.equal(result.body,'');
        else assert.deepEqual(JSON.parse(result.body),{method,url:origin.origin+'/items',body:method==='GET'?'':'sample'});
      }
      const streamed=await new Promise<string>((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port:origin.port,path:'/preview-info',method:'OPTIONS',
          headers:{host:origin.host,'Transfer-Encoding':'chunked'}},res=>{
          let body='';res.setEncoding('utf8');
          res.on('data',part=>{body+=part;});
          res.on('end',()=>res.statusCode===200?resolve(body):reject(new Error('Streamed preview returned HTTP '+res.statusCode)));
        });
        req.on('error',reject);req.write('first ');req.end('part');
      });
      assert.equal(JSON.parse(streamed).body,'first part');
      const live=await shell(bin,['ps','-q','--filter','label=ai.dhimant.attempt='+access.id]);
      const invalidLength=await shell(bin,['exec',live,'python3','-c',[
        'import http.client,os',
        'conn=http.client.HTTPConnection("127.0.0.1",8000,timeout=3)',
        'conn.request("POST","/preview-info",headers={"X-Studio-Run":os.environ["STUDIO_RUN"],"Content-Length":"invalid"})',
        'print(conn.getresponse().status)',
      ].join('\n')]);
      assert.equal(invalidLength,'400');
      const status=await preview.evaluate(async token=>(await fetch('/items/1/loans?source=practice',{
        method:'POST',headers:{'X-CSRF-TOKEN':token,'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({borrower:'learner',quantity:0})})).status,token);
      assert.equal(status,422);
      const previewShell=await learningFrame(page,'#back');
      await previewShell.locator('#back').click();
      await until(async()=>delivered.length===1 && saved.pendingCheckout,'Pending checkout was lost');
      assert.equal(saved.evidence?.quantity,0);
      assert.equal(saved.evidence?.status,422);
      assert.equal(saved.evidence?.before,3);assert.equal(saved.evidence?.after,3);
      await lesson.dispose();
      lesson=openLesson();await lesson.open();
      assert.deepEqual(delivered,[saved.evidence!.request,saved.evidence!.request]);
      assert.equal(saved.pendingCheckout,undefined);
      assert.equal(saved.history.filter(s=>s.includes('HTTP 422 for 0')).length,1);
      await lesson.dispose();
      lesson=openLesson();await lesson.open();
      // A reattached preview can still return the previously observed checkout on close.
      const originalEvidence=StudioRun.prototype.evidence;
      const lastEvent=structuredClone(saved.evidence!);
      let evidenceReads=0;
      try{
        StudioRun.prototype.evidence=async()=>{evidenceReads++;return lastEvent;};
        await (await learningFrame(page,'#run')).locator('#run').click();
        await (await learningFrame(page,'#back')).locator('#back').click();
        await until(async()=>evidenceReads===1 && vscode.window.activeTextEditor?.document.uri.fsPath===join(root,def.entries[0].file),'Preview did not return');
        assert.equal(delivered.length,2);
        assert.equal(saved.history.filter(s=>s.includes('HTTP 422 for 0')).length,1);
      }finally{StudioRun.prototype.evidence=originalEvidence;}
    }else{
      await lesson.open();
      const frame=await learningFrame(page,'#next');
      // Set distinctive live stock through the same Run button as any query.
      await frame.getByText('Project Console',{exact:true}).click();
      await frame.getByLabel('Code cell language').selectOption('sql');
      await frame.locator('.practice-buffer .cm-content').fill('UPDATE items SET available=20;');
      await frame.locator('.practice-code-editor').getByRole('button',{name:'Run',exact:true}).click();
      await frame.locator('.practice-output').filter({hasText:'Query completed.'}).waitFor({timeout:90000});
      const label='ai.dhimant.attempt='+access.id;
      const live=await shell(bin,['ps','-q','--filter','label='+label,'--filter','label=ai.dhimant.studio-kind=live']);
      assert.ok(live);
      if(scenario==='diagnostic'){
        // Simulate missing runtime credentials. Laravel already has its connection settings.
        await shell(bin,['exec',live,'mv','/studio-state/credentials.json','/studio-state/credentials.test-backup']);
      }
      await frame.locator('#next').click();await frame.locator('#practice').waitFor();
      if(scenario==='diagnostic'){
        assert.match(await frame.locator('#question').innerText(),/reader is unavailable/);
        await shell(bin,['exec',live,'mv','/studio-state/credentials.test-backup','/studio-state/credentials.json']);
      }
      await frame.locator('#practice').click();await frame.locator('#message').fill('The request should be rejected and one camera should remain.');
      await vscode.commands.executeCommand('notifications.clearAll');
      await frame.locator('#composer .composer-submit').focus();
      await frame.locator('#composer .composer-submit').press('Enter');
      const doc=await vscode.workspace.openTextDocument(join(root,def.entries[1].file));
      const editor=await vscode.window.showTextDocument(doc,vscode.ViewColumn.One);
      const at=doc.positionAt(doc.getText().indexOf('        // Decide'));
      await editor.edit(edit=>edit.insert(at,"        abort_if($item->available < (int) $fields['quantity'], 409, 'Stock too low');\n"));
      assert.ok(await doc.save());
      const selection=new vscode.Selection(13,8,13,15);editor.selection=selection;
      await frame.locator('#run').click();
      const preview=await until(async()=>page.frames().find(f=>/^http:\/\/[a-f0-9-]+\.localhost:\d+\//.test(f.url())), 'Practice app did not open',90);
      await preview.locator('select[name=item]').selectOption({label:'Camera'});
      await preview.getByText('Camera · 1 available',{exact:true}).waitFor();
      await preview.getByLabel('Borrower alias').fill('practice-student');await preview.getByLabel('Quantity').fill('2');
      const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/loans'));
      await preview.getByRole('button',{name:'Check out'}).click();assert.equal((await response).status(),409);
      const practice=await shell(bin,['ps','-q','--filter','label='+label,'--filter','label=ai.dhimant.studio-kind=practice']);
      const rows=async (id:string)=>shell(bin,['exec',id,'python3','-c',"import sys;sys.path.insert(0,'/opt/build-studio');from runtime import sql;print(sql(\"SELECT available,(SELECT COUNT(*) FROM loans) FROM items WHERE name='Camera'\",'desk'))"]);
      assert.equal(await rows(practice),'1\t0');
      const previewShell=await learningFrame(page,'#back');
      if(scenario==='diagnostic')await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      else await previewShell.locator('#back').click();
      await until(async()=>observed,'Checkout evidence was not delivered');
      assert.equal(observed!.kind,'practice');assert.equal(observed!.before,1);assert.equal(observed!.after,1);
      assert.equal(observed!.status,409);assert.match(observed!.revision,/^[0-9a-f]{40}$/);
      assert.ok(predicted?.trim(),'The learner prediction was not sent with the checkout evidence');
      assert.equal(await rows(live),'20\t0');
      assert.equal(await shell(bin,['exec',live,'python3','/opt/build-studio/runtime.py','evidence']),'null');
      await until(async()=>vscode.window.activeTextEditor?.document.uri.fsPath===doc.uri.fsPath&&vscode.window.activeTextEditor.selection.isEqual(selection),'Editor selection was not restored');
      const returned=await learningFrame(page,'#tools');
      assert.match(await returned.locator('#history').innerText(),/Practice inventory returned HTTP 409/);
      // The checkout matched the predicted request, so it used the prediction up and asks for a new one.
      assert.doesNotMatch(await returned.locator('#history').innerText(),/still open/);
      assert.equal(saved.prediction,undefined);assert.equal(saved.predicted,true);
      await until(async()=>!await returned.locator('#replyKind').isHidden(),'A new prediction was not requested');
    }
    await writeFile(process.env.DHIMANTAI_TEST_RESULTS!,JSON.stringify({passed:scenario,unopenedExport:scenario==='cell'||scenario==='native',observed}));
  }finally{
    await lesson.dispose();
    if(scenario!=='native' && scenario!=='unified')for(const volume of ['desk-state-attempt-'+access.id,'desk-state-'+createHash('sha256').update(root).digest('hex').slice(0,16)])await shell(bin,['volume','rm',volume]).catch(()=>{});
    await browser.close();
  }
}
