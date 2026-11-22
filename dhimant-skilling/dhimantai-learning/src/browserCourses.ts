import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';
import { ensurePodman, ERP_MEMORY_MIB } from './podman';
import { ErpSandbox, sandboxKey } from './browserSandbox';
import {courseAction, type SkillingTarget} from './skillingMenu';
import {BrowserLearning, BrowserTask, ERP_COURSE, VerifiedTask} from './browserLearning';
import {FrappeServer} from './apps/frappe';
import {openInjectedTab, InjectedTab} from './apps/desktopBrowser';
import {TaskVerifier, VerifiableTask} from './apps/verifier';
import {learnerRpc,PublicCatalog} from './learnerCatalog';
import {Api} from './api';
import {DemoLesson, DemoState, demoFinished, demoKey, demoTasks, ERP_DEMO, prepareDemo} from './erpDemo';
import {BusinessShift, ShiftLesson, ShiftState, checkShiftHandover, shiftFinished, shiftKey, shiftTasks} from './erpShift';
import {verifiedKey} from './browserCourseProgress';
export {verifiedKey} from './browserCourseProgress';

/** Matches the training ERPNext pages on any loopback port, and nothing else served from loopback. */
export const ERP_TAB_FILTER='http://127.0.0.1:*/{desk,desk/**,app/**,login,assets/frappe/dhimantai/**}';

/** One local ERPNext stack per service/profile, with separate ERPNext logins for dhimantAI accounts. */
export class BrowserCourses {
  private runtime?: ErpSandbox;
  private tab?: InjectedTab;
  private readonly menuChanged = new vscode.EventEmitter<void>();
  readonly onMenuChange = this.menuChanged.event;
  menuTarget(): SkillingTarget | undefined {
    const scope = this.scope;
    if (!this.tab?.active || !scope || scope.environment !== this.environment()) return;
    const chapter = this.learning?.latest(scope.account, scope.environment)?.chapter;
    return {course: courseAction('erpnext-essentials', chapter),
      ask: () => vscode.commands.executeCommand('dhimantai.openLearningRoom', ERP_COURSE, chapter)};
  }
  private pending?: Promise<void>;
  private generation = 0;
  private scope?: {account:string; environment:EnvironmentName; learner:string};
  private starting?: Promise<string>;
  private stopping: Promise<void> = Promise.resolve();
  private subscriptions: vscode.Disposable[];
  private readonly verifiedChanged = new vscode.EventEmitter<void>();
  /** Fires when the learner verifies a task, so Course Catalog can show it without a refocus. */
  readonly onDidVerify = this.verifiedChanged.event;
  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: Auth,
      private readonly environment: () => EnvironmentName, private readonly output: vscode.OutputChannel,
      private readonly learning?:BrowserLearning,private readonly service?:()=>Environment) {
    this.subscriptions = [
      vscode.commands.registerCommand('dhimantai.openBrowserCourse', (id?:string) => {
        if (id && id !== 'erpnext-essentials') return;
        return this.launch('course');
      }),
      vscode.commands.registerCommand('dhimantai.openErpDemo', () => this.launch('demo')),
      vscode.commands.registerCommand('dhimantai.openErpShift', () => this.launch('shift')),
      auth.onDidChange(session => { if(this.scope && session?.user.id !== this.scope.account) void this.stop(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if(e.affectsConfiguration('dhimantai.environment')) void this.stop(); }),
    ];
  }
  private async credential(key:string) {
    let value = await this.context.secrets.get(key);
    if (!value) {value=randomBytes(24).toString('hex');await this.context.secrets.store(key,value);}
    return value;
  }
  private launch(mode:'course'|'demo'|'shift') {
    return this.pending ??= this.open(mode).catch(error => {
      this.output.appendLine(String(error));
      void vscode.window.showErrorMessage('ERPNext: ' + (error instanceof Error ? error.message : String(error)));
    }).finally(() => { this.pending=undefined; });
  }
  /** The demo learner: the current one to continue, or a new learner with a fresh company. Undefined when cancelled. */
  private async demoLearner(environment:EnvironmentName, account:string, key:string) {
    const stateKey=demoKey(environment,account), previous=this.context.globalState.get<DemoState>(stateKey);
    if(previous) {
      const choice=await vscode.window.showInformationMessage('ERPNext demo', {modal:true,
        detail:demoFinished(previous)?'This demo is finished. Show its books again, or start over with a fresh company?':'Continue the demo where you left off, or start over with a fresh company?'},
        demoFinished(previous)?'Show the finished demo':'Continue', 'Start fresh');
      if(!choice)return undefined;
      if(choice!=='Start fresh')return previous.learner;
      await this.context.secrets.delete('browser.erpnext.learner.'+key+'.'+previous.learner);
    }
    const learner=sandboxKey(environment+':'+account+':demo:'+randomBytes(8).toString('hex'));
    await this.context.globalState.update(stateKey,{learner,verified:{}} satisfies DemoState);
    return learner;
  }
  private async open(mode:'course'|'demo'|'shift'='course') {
    await this.stopping;
    const account=(await this.auth.session())?.user.id, environment=this.environment(), generation=this.generation;
    if (!account) {
      const action=await vscode.window.showInformationMessage('Sign in to open your ERPNext training account.','Sign in');
      if(action) await vscode.commands.executeCommand('dhimantai.signIn',environment);
      return;
    }
    const key=sandboxKey(this.context.globalStorageUri.fsPath + ':' + environment);
    const demo=mode==='demo';
    const shift:BusinessShift|undefined=mode==='shift'
      ? JSON.parse(await readFile(vscode.Uri.joinPath(this.context.extensionUri,'media','browser','erpnext','shift.json').fsPath,'utf8')):undefined;
    if(shift && !this.learning)throw new Error('The business shift needs the Instructor connection.');
    if(demo && !this.learning)throw new Error('The demo needs the Instructor connection.');
    let id=demo ? await this.demoLearner(environment,account,key) : sandboxKey(environment + ':' + account);
    if(shift) {
      const store=shiftKey(environment,account),previous=this.context.globalState.get<ShiftState>(store);
      // Resume automatically; a completed shift offers a fresh company without deleting its old records.
      let fresh=!previous;
      if(shiftFinished(previous,shift)) {
        const choice=await vscode.window.showInformationMessage('Your business shift is complete.','Review handover','Start a new shift');
        if(!choice)return;
        fresh=choice==='Start a new shift';
      }
      id=fresh?sandboxKey(environment+':'+account+':shift:'+randomBytes(8).toString('hex')):previous!.learner;
      if(fresh)await this.context.globalState.update(store,{learner:id,verified:{}} satisfies ShiftState);
    }
    if(!id)return;
    this.scope={account,environment,learner:id};
    const [admin,password]=await Promise.all([this.credential('browser.erpnext.admin.'+key),this.credential('browser.erpnext.learner.'+key+'.'+id)]);
    const current=async()=>generation===this.generation && environment===this.environment() && (await this.auth.session())?.user.id===account;
    const url=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'ERPNext training',cancellable:false},async progress=>{
      const report=(message:string)=>progress.report({message}), log=(s:string)=>this.output.append(s);
      const bin=await ensurePodman(report,log,(file,args)=>new Promise<void>((resolve,reject)=>{
        const terminal=vscode.window.createTerminal({name:'Install course runtime',shellPath:'/usr/bin/sudo',shellArgs:[file,...args]});
        const closed=vscode.window.onDidCloseTerminal(t=>{if(t!==terminal)return;closed.dispose();t.exitStatus?.code===0?resolve():reject(new Error('Runtime installation did not finish.'));});
        terminal.show();
      }),ERP_MEMORY_MIB, async () => await vscode.window.showInformationMessage(
        'ERPNext needs 6 GB of runtime memory. Restart the runtime to allocate it? Active containers will restart; save any running work first.',
        {modal:true}, 'Restart and continue') === 'Restart and continue');
      if(!await current())return;
      this.runtime=new ErpSandbox(bin,vscode.Uri.joinPath(this.context.extensionUri,'media','browser','erpnext').fsPath,key,log);
      this.starting=this.runtime.start(admin,{id,password},report);
      try {return await this.starting;} finally {this.starting=undefined;}
    });
    if(!await current()) {await this.runtime?.stop();return;}
    if(!url)return;
    // Frappe re-encodes query strings inside redirect-to. Carry the account in
    // a same-origin launch page instead, and keep the login destination plain.
    let fragment='learner='+id;
    if(this.learning) {
      if(this.service) {
        const service=this.service(),token=await this.auth.accessToken();
        const catalog=await learnerRpc<PublicCatalog>(service,'public_learning_catalog',{},token);
        if(!await current())return;
        const published=catalog.courses.find(c=>c.id==='erpnext-essentials');
        if(!published?.is_free)throw new Error('The ERPNext Instructor course is not published on this service yet.');
        if(catalog.individual && !published.enrolled) {
          if(!published.can_join)throw new Error('ERPNext course enrollment is unavailable.');
          await learnerRpc(service,'join_learning_course',{p_course:published.id},token);
          if(!await current())return;
        }
      }
      const course=this.service
        ? await new Api(this.auth,this.service,account).guidedErpForms()
        : JSON.parse(await readFile(vscode.Uri.joinPath(this.context.extensionUri,'media','browser','erpnext','course.json').fsPath,'utf8')) as {lessons:BrowserTask[]};
      if(!await current())return;
      if(!course.lessons.length)throw new Error('No guided tasks are published for your ERPNext course access.');
      // The demo keeps its own progress with its own learner, so it never counts toward the account's course.
      const store=shift?shiftKey(environment,account):demo?demoKey(environment,account):verifiedKey(environment,account);
      const actionTotals=this.context.globalState.get<ShiftState>(store)?.actions??{};
      let storeWrites=Promise.resolve();
      const writeShift=(update:(old:ShiftState|undefined)=>ShiftState)=>{
        const next=storeWrites.then(()=>this.context.globalState.update(store,update(this.context.globalState.get<ShiftState>(store))));
        storeWrites=next.catch(()=>{});return next;
      };
      const readVerified=()=>((demo||shift)?this.context.globalState.get<DemoState>(store)?.verified:this.context.globalState.get<Record<string,VerifiedTask>>(store))??{};
      const writeVerified=(verified:Record<string,VerifiedTask>)=>shift?writeShift(()=>({learner:id,verified,actions:actionTotals}))
        :this.context.globalState.update(store,demo?{learner:id,verified}:verified);
      const lessons=shift?shiftTasks(course.lessons as ShiftLesson[],shift):demo?demoTasks(course.lessons as DemoLesson[]):course.lessons;
      const verifier=new TaskVerifier(new FrappeServer(url,'Administrator',admin),vscode.Uri.joinPath(this.context.extensionUri,'media','browser','player').fsPath);
      const verify=async(task:string,record:string)=>{
        const definition=lessons.find(l=>l.id===task) as unknown as VerifiableTask|undefined;
        return !!definition && verifier.verify(definition,record,`learner-${id}@training.invalid`,id.slice(0,10),
          Object.fromEntries(Object.entries(readVerified()).map(([k,v])=>[k,v.record])));
      };
      if(demo || shift) {
        const learnerServer=new FrappeServer(url,`learner-${id}@training.invalid`,password);
        const today=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:shift?'Preparing your business shift':'ERPNext demo',cancellable:false},async progress=>{
          progress.report({message:'Preparing the customer, supplier, item and both orders'});
          await prepareDemo(learnerServer,lessons as DemoLesson[],id.slice(0,10),today,readVerified(),
            async(task,entry)=>{
              if(!await current())throw new Error('The training account changed during preparation.');
              if(shift && !await verify(task,entry.record))throw new Error('ERPNext could not verify the prepared '+task+'.');
              await writeVerified({...readVerified(),[task]:entry});
            });
        });
        if(!await current())return;
      }
      fragment=await this.learning.start({origin:url,account,environment,learner:id,tasks:lessons,current,
        ...(shift?{course:{id:'erpnext-essentials',title:ERP_COURSE,finale:shift.finale,shift},
          handover:()=>this.context.globalState.get<ShiftState>(store)?.handover,
          recordHandover:async(text:string,recorded:string)=>{
            if(!await current() || !await checkShiftHandover(shift,readVerified(),verify) || !await current())return false;
            await writeShift(old=>({...old,learner:id,verified:readVerified(),actions:actionTotals,handover:{text,recorded,at:new Date().toISOString()}}));
            return true;
          },
          recordAction:(command,result)=>{
            const previous=actionTotals[command.task]??{calls:0,durationMs:0,failures:0};
            actionTotals[command.task]={calls:previous.calls+1,durationMs:previous.durationMs+(result.duration_ms||0),failures:previous.failures+(result.status==='completed'?0:1)};
            void writeShift(old=>({...old,learner:id,verified:old?.verified??{},actions:actionTotals})).catch(()=>this.output.appendLine('Could not retain the local shift action totals.'));
            this.output.appendLine('BUSINESS_SHIFT_USAGE '+JSON.stringify({schema:1,kind:'action',shift:shift.id,run:id.slice(0,10),
              request:command.id,task:command.task,action:command.action,outcome:result.status,duration_ms:result.duration_ms,model_calls:0}));
          }}:demo?{course:{id:'erpnext-essentials',title:ERP_COURSE,finale:ERP_DEMO.finale}}:{}),
        signIn:{usr:`learner-${id}@training.invalid`,pwd:password},
        verified:readVerified,
        recordVerified:async(task,done)=>{
          if(!await current())return false;
          // Never trust the page: re-read the record as the sandbox administrator before counting it.
          const saved=readVerified();
          const definition=lessons.find(lesson=>lesson.id===task) as unknown as VerifiableTask|undefined;
          const earlier=Object.fromEntries(Object.entries(saved).map(([id,entry])=>[id,entry.record]));
          let verified=false;
          try {verified=!!definition && await verifier.verify(definition,done.record,`learner-${id}@training.invalid`,id.slice(0,10),earlier);}
          catch(error){this.output.appendLine('ERPNext progress check failed: '+(error instanceof Error?error.message:String(error)));}
          if(!verified || !await current())return false;
          const demonstrated=shift&&!!actionTotals[task]?.calls;
          await writeVerified({...readVerified(),[task]:{...done,assisted:done.assisted||!!demonstrated}});
          this.verifiedChanged.fire();
          return true;
        }});
      // Resume the Instructor at the first task this account has not finished (checked and explained).
      const verified=readVerified();
      const resume=lessons.find(lesson=>!verified[lesson.id]?.explained)??((demo||shift)?lessons[lessons.length-1]:lessons[0]);
      await vscode.commands.executeCommand('dhimantai.openLearningRoom',ERP_COURSE,resume.instructorChapter);
    }
    // Preferred: the desktop browser signs the learner in and injects the player, so nothing depends on the app image.
    if (this.learning) {
      const bridge = new URLSearchParams(fragment), media = vscode.Uri.joinPath(this.context.extensionUri,'media','browser').fsPath;
      const learnerServer = new FrappeServer(url, `learner-${id}@training.invalid`, password);
      try {
        await this.tab?.dispose();
        this.tab = await openInjectedTab({url, home:'/desk', media, adapter:'frappe', learner:id, bridge, server:learnerServer, onFocusChange: () => this.menuChanged.fire()});
        this.menuChanged.fire();
        if (this.tab) return;
      } catch (error) { this.output.appendLine('Desktop browser injection unavailable: '+(error instanceof Error?error.message:String(error))); }
    }
    const destination = `${url}/assets/frappe/dhimantai/launch.html#${fragment}`;
    if ((await vscode.commands.getCommands(true)).includes('workbench.action.browser.open')) {
      await vscode.commands.executeCommand('workbench.action.browser.open',
        // The loopback port changes when the runtime restarts; reuse any earlier ERPNext training tab.
        {url:destination, openToSide:true, reuseUrlFilter:ERP_TAB_FILTER});
    } else {
      await vscode.env.openExternal(vscode.Uri.parse(destination));
    }
    // With the Instructor bridge, the launch page signs in by itself.
    if(this.learning)return;
    void (async()=>{
      const action=await vscode.window.showInformationMessage(`ERPNext login: learner-${id}@training.invalid. Your practice is saved in this computer’s shared ERPNext instance.`, 'Copy login', 'Copy password');
      if(!await current())return;
      if(action==='Copy login') {
        await vscode.env.clipboard.writeText(`learner-${id}@training.invalid`);
        const next=await vscode.window.showInformationMessage('Login copied. Paste it into ERPNext, then copy your password.','Copy password');
        if(next && await current())await vscode.env.clipboard.writeText(password);
      } else if(action==='Copy password')await vscode.env.clipboard.writeText(password);
    })();
  }
  stop() {
    this.generation++;
    void this.tab?.dispose(); this.tab=undefined; this.menuChanged.fire();
    void this.learning?.stop();
    const runtime=this.runtime, scope=this.scope, starting=this.starting;
    return this.stopping=this.stopping.then(async()=>{
      await starting?.catch(()=>{});
      if(scope) await runtime?.revoke(scope.learner);
      await runtime?.stop();
      if(this.scope===scope)this.scope=undefined;
    }).catch(error=>{this.output.appendLine('Could not stop ERPNext: '+String(error));});
  }
  async shutdown() {
    await this.stop();
    const runtime=this.runtime;this.runtime=undefined;
    await runtime?.shutdown();
  }
  dispose() {this.subscriptions.forEach(s=>s.dispose());this.verifiedChanged.dispose();void this.stop();this.menuChanged.dispose();}
}
