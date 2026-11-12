import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { Auth } from './auth';
import { Environment, EnvironmentName } from './environments';
import { ensurePodman } from './podman';
import { ErpSandbox, sandboxKey } from './browserSandbox';
import {BrowserLearning, BrowserTask, ERP_COURSE, VerifiedTask} from './browserLearning';
import {FrappeServer} from './apps/frappe';
import {openInjectedTab, InjectedTab} from './apps/desktopBrowser';
import {TaskVerifier, VerifiableTask} from './apps/verifier';
import {learnerRpc,PublicCatalog} from './learnerCatalog';
import {Api} from './api';
import {DemoLesson, DemoState, demoFinished, demoKey, demoTasks, ERP_DEMO, prepareDemo} from './erpDemo';

/** Matches the training ERPNext pages on any loopback port, and nothing else served from loopback. */
export const ERP_TAB_FILTER='http://127.0.0.1:*/{desk,desk/**,app/**,login,assets/frappe/dhimantai/**}';
/** ERPNext tasks this account has verified on this computer (practice evidence, separate from Instructor coverage). */
export const verifiedKey=(environment:EnvironmentName,account:string)=>`browser.erpnext.verified.${environment}.${account}`;

/** One local ERPNext stack per service/profile, with separate ERPNext logins for dhimantAI accounts. */
export class BrowserCourses {
  private runtime?: ErpSandbox;
  private tab?: InjectedTab;
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
        return this.launch(false);
      }),
      vscode.commands.registerCommand('dhimantai.openErpDemo', () => this.launch(true)),
      auth.onDidChange(session => { if(this.scope && session?.user.id !== this.scope.account) void this.stop(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if(e.affectsConfiguration('dhimantai.environment')) void this.stop(); }),
    ];
  }
  private async credential(key:string) {
    let value = await this.context.secrets.get(key);
    if (!value) {value=randomBytes(24).toString('hex');await this.context.secrets.store(key,value);}
    return value;
  }
  private launch(demo:boolean) {
    return this.pending ??= this.open(demo).catch(error => {
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
  private async open(demo=false) {
    await this.stopping;
    const account=(await this.auth.session())?.user.id, environment=this.environment(), generation=this.generation;
    if (!account) {
      const action=await vscode.window.showInformationMessage('Sign in to open your ERPNext training account.','Sign in');
      if(action) await vscode.commands.executeCommand('dhimantai.signIn',environment);
      return;
    }
    const key=sandboxKey(this.context.globalStorageUri.fsPath + ':' + environment);
    if(demo && !this.learning)throw new Error('The demo needs the Instructor connection.');
    const id=demo ? await this.demoLearner(environment,account,key) : sandboxKey(environment + ':' + account);
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
      }),8192);
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
      const store=demo?demoKey(environment,account):verifiedKey(environment,account);
      const readVerified=()=>(demo?this.context.globalState.get<DemoState>(store)?.verified:this.context.globalState.get<Record<string,VerifiedTask>>(store))??{};
      const writeVerified=(verified:Record<string,VerifiedTask>)=>this.context.globalState.update(store,demo?{learner:id,verified} satisfies DemoState:verified);
      const lessons=demo?demoTasks(course.lessons as DemoLesson[]):course.lessons;
      if(demo) {
        const learnerServer=new FrappeServer(url,`learner-${id}@training.invalid`,password);
        const today=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
        await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'ERPNext demo',cancellable:false},async progress=>{
          progress.report({message:'Preparing the customer, supplier, item and both orders'});
          await prepareDemo(learnerServer,lessons as DemoLesson[],id.slice(0,10),today,readVerified(),
            async(task,entry)=>{if(await current())await writeVerified({...readVerified(),[task]:entry});});
        });
        if(!await current())return;
      }
      const verifier=new TaskVerifier(new FrappeServer(url,'Administrator',admin),vscode.Uri.joinPath(this.context.extensionUri,'media','browser','player').fsPath);
      fragment=await this.learning.start({origin:url,account,environment,learner:id,tasks:lessons,current,
        ...(demo?{course:{id:'erpnext-essentials',title:ERP_COURSE,finale:ERP_DEMO.finale}}:{}),
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
          await writeVerified({...readVerified(),[task]:done});
          this.verifiedChanged.fire();
          return true;
        }});
      // Resume the Instructor at the first task this account has not finished (checked and explained).
      const verified=readVerified();
      const resume=lessons.find(lesson=>!verified[lesson.id]?.explained)??(demo?lessons[lessons.length-1]:lessons[0]);
      await vscode.commands.executeCommand('dhimantai.openLearningRoom',ERP_COURSE,resume.instructorChapter);
    }
    // Preferred: the desktop browser signs the learner in and injects the player, so nothing depends on the app image.
    if (this.learning) {
      const bridge = new URLSearchParams(fragment), media = vscode.Uri.joinPath(this.context.extensionUri,'media','browser').fsPath;
      const learnerServer = new FrappeServer(url, `learner-${id}@training.invalid`, password);
      try {
        await this.tab?.dispose();
        this.tab = await openInjectedTab({url, home:'/desk', media, adapter:'frappe', learner:id, bridge, server:learnerServer});
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
    void this.tab?.dispose(); this.tab=undefined;
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
  dispose() {this.subscriptions.forEach(s=>s.dispose());this.verifiedChanged.dispose();void this.stop();}
}
