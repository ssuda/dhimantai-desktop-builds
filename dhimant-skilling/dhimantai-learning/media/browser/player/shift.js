/* A business shift has no DOM of its own. Briefs, questions and handoffs live in Instructor. */
(() => {
  'use strict';
  const equal=(actual,expected)=>Array.isArray(expected)?Array.isArray(actual)&&actual.length===expected.length&&expected.every((v,i)=>equal(actual[i],v))
    :expected&&typeof expected==='object'?!!actual&&Object.entries(expected).every(([k,v])=>equal(actual[k],v))
    :typeof expected==='number'?actual!==null&&actual!==undefined&&actual!==''&&Number(actual)===expected:actual===expected;
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  const actions=['open_source','prepare_draft','fill_routine','inspect_result'];
  window.dhimantaiBusinessShift={async start({app,course,connection,user,tag}) {
    if(window.dhimantaiErpGuide)return;
    const shift=course.shift,company='Training '+tag,key=`dhimantai-shift:${course.version}:${user}`;
    let state;try{state=JSON.parse(localStorage.getItem(key)||'{}');}catch{state={};}
    if(!state||typeof state!=='object'||Array.isArray(state))state={};
    for(const k of ['done','predictions','support','executions'])if(!state[k]||typeof state[k]!=='object'||Array.isArray(state[k]))state[k]={};
    // Desktop-verified evidence owns completion. Browser storage only retains attempts and predictions.
    state.done=course.verified||{};
    state.closing=!!course.handover;
    const finished=id=>state.done[id]?.explained===true;
    let taskId=shift.live.includes(state.task)?state.task:shift.live.find(id=>!finished(id))||shift.live.at(-1);
    const transport=state.transport?.launch===connection.origin?state.transport:{launch:connection.origin,failures:0,nextAt:0};
    state.transport=transport;
    let stopped=transport.failures>=3,busy=false,sequence=Date.now()*1000,questionHash='',observationHash='',lastObserved=0;
    let action='view',result=null,status='',snapshotId=uuid(),signature='',actor,dirtyGeneration=0;
    let lastAnswer='',lastTaskAction='',handoverEvidence='',handoverReady=false;
    const save=()=>{state.task=taskId;try{localStorage.setItem(key,JSON.stringify(state));}catch{}};
    const raw=id=>course.lessons.find(l=>l.id===(id||taskId));
    const resolve=value=>JSON.parse(JSON.stringify(value).replaceAll('{{today}}',app.today())
      .replace(/\{\{ref:([a-z0-9-]+)\}\}/g,(_,id)=>JSON.stringify(state.done[id]?.record||'').slice(1,-1)));
    const current=()=>resolve(raw());
    const form=()=>{const f=app.current();return f?.form===current().doctype?f:undefined;};
    const support=()=>state.support[taskId]??=( {failures:0,helpRequests:0,level:'brief',demonstrations:0} );
    const blocked=()=>shift.live.slice(0,shift.live.indexOf(taskId)).filter(id=>!finished(id));
    const request=async(path,body)=>{
      const response=await fetch(connection.origin+path,{method:body===undefined?'GET':'POST',
        headers:{Authorization:'Bearer '+connection.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error('Instructor connection or record verification was not accepted.');
      return response.json();
    };
    const say=async text=>{status=text.slice(0,600);await request('/status',{status});};
    const scalar=v=>typeof v==='string'?v.slice(0,600):typeof v==='number'&&Number.isFinite(v)?v:typeof v==='boolean'?v:null;
    function snapshot() {
      const task=current(),open=app.current(),doc=open?.values;
      const own=open?.form===task.doctype&&doc?.company===company;
      const fields={};
      if(own)for(const s of task.steps)fields[s.field]=Array.isArray(s.value)?(Array.isArray(doc[s.field])?doc[s.field].slice(0,10).map(row=>
        Object.fromEntries([...new Set(s.value.flatMap(Object.keys))].map(k=>[k,scalar(row[k])]))):[]):scalar(doc[s.field]);
      // The revision includes route/record and dirty state, not just expected-value equality.
      const next=JSON.stringify([taskId,app.route?.(),open?.form,open?.id,open?.dirty,open?.values?.docstatus,fields,dirtyGeneration]);
      if(next!==signature){signature=next;snapshotId=uuid();}
      const s=support();
      return {course:course.id,task:taskId,step:Math.max(0,task.steps.findIndex(s=>!equal(fields[s.field],s.value))),training_tag:tag,
        route:String(app.route?.()||'').slice(0,300),doctype:own?task.doctype:'',record:own?String(open.id||'').slice(0,160):'',
        dirty:own?!!open.dirty:false,docstatus:own&&[0,1,2].includes(doc.docstatus)?doc.docstatus:null,fields,
        errors:[...(own?app.errors().slice(0,2):[]),...(result==='mismatch'?[status]:[])].map(s=>s.slice(0,500)),action,result,
        shift:{id:shift.id,snapshot:snapshotId,failures:s.failures,helpRequests:s.helpRequests,support:s.level,completed:shift.live.filter(finished)}};
    }
    async function observe(force=false) {
      const data=snapshot(),hash=JSON.stringify(data);
      if(!force&&hash===observationHash&&Date.now()-lastObserved<20000)return;
      await request('/observe',{...data,sequence:++sequence});observationHash=hash;lastObserved=Date.now();
    }
    const postedText=p=>p?[...p.ledger.map(r=>`${r.account}: debit ${r.debit}, credit ${r.credit}`),
      ...p.stock.map(r=>`${r.item}: stock change ${r.change}, remaining ${r.balance}`)].join('; '):'';
    function question() {
      const task=current(),done=state.done[taskId],p=state.predictions[taskId];
      const base={task:taskId,title:task.title,options:[],context:'',minLength:30,maxLength:500};
      if(task.predict&&!p&&!finished(taskId)&&!blocked().length)return {...base,id:taskId+':prediction',kind:'prediction',
        question:task.predict.question,options:task.predict.options,minLength:1,context:'Predict the consequence. Do not reveal the outcome before the learner checks their work.'};
      if(done&&!done.explained)return {...base,id:taskId+':explanation:'+done.checkedAt,kind:'explanation',question:task.explain,
        context:[`Saved record: ${done.record}.`,done.evidence||'',p?`Learner predicted: ${p.choice}. ${p.actual||''}`:''].join('\n').slice(0,2000)};
      if(taskId===shift.live.at(-1)&&shift.live.every(finished)&&!state.closing&&handoverReady)return {...base,
        id:taskId+':reflection:'+state.done[taskId].checkedAt,kind:'reflection',title:'Hand over to the owner',question:shift.handover,
        context:handoverEvidence,minLength:40,maxLength:800};
      return null;
    }
    async function publish() {
      await observe();const q=question(),hash=JSON.stringify(q);
      if(hash!==questionHash){await request('/question',{question:q});questionHash=hash;}
    }
    async function handover() {
      handoverReady=false;const docs={};
      for(const id of shift.live) {
        const lesson=resolve(raw(id)),record=state.done[id]?.record;
        const doc=record&&await app.read(lesson.doctype,record);
        if(!doc||!equal(doc,lesson.expected))throw new Error('A submitted record changed. Review the situation before handing over.');
        docs[id]=doc;
        for(const extra of lesson.also||[])if(!equal(await app.read(extra.doctype,extra.record),extra.expected))throw new Error('A linked record changed.');
      }
      const order=await app.read(raw('buying').doctype,state.done.buying.record),spec=resolve(raw('delivery')).predict.evidence;
      const stock=await app.evidence(spec,state.done.delivery.record),books=await app.books(company);
      if(!order||order.company!==company||order.docstatus!==1||!Number.isFinite(Number(order.per_received))||!stock||!books)throw new Error('The stock or ledger could not be read.');
      for(const id of ['payables','receivables'])if(docs[id].outstanding_amount==null||!Number.isFinite(Number(docs[id].outstanding_amount)))throw new Error('The outstanding balance could not be read.');
      handoverEvidence=[`Stock remaining: ${stock}`,`Purchase order ${state.done.buying.record}: ${order.per_received}% received.`,
        `Supplier bill ${state.done.payables.record}: INR ${docs.payables.outstanding_amount} outstanding.`,
        `Customer invoice ${state.done.receivables.record}: INR ${docs.receivables.outstanding_amount} outstanding.`,
        ...books.map(r=>`${r.account} (${r.kind}): INR ${r.balance}`)].join('\n').slice(0,2000);
      handoverReady=true;
    }
    async function answerQuestion(id,text) {
      const q=question();if(!q||q.id!==id||typeof text!=='string'||text.trim().length<q.minLength||text.length>q.maxLength||q.options.length&&!q.options.includes(text))return false;
      if(q.kind==='prediction') {
        state.predictions[taskId]={choice:text,early:!form()?.final};save();
        await say('Prediction recorded. Your turn: use the business documents to complete and submit the record, then Continue here.');
      } else if(q.kind==='explanation') {
        const done=state.done[taskId];
        await request('/progress',{task:taskId,record:done.record,checkedAt:done.checkedAt,assisted:done.assisted,explained:true});
        done.explained=true;save();
        if(shift.live.every(finished)){await handover();await say('Your records are ready. Give the owner your handover here.');}
        else await say('Explanation recorded. Read Instructor’s feedback, then Continue to the next situation.');
      } else {
        await handover();await request('/handover',{text,recorded:handoverEvidence});state.closing=true;save();
        await say('Handover saved. Review Instructor’s feedback. This is practice evidence, not an automatic grade.');
      }
      await publish();return true;
    }
    async function review() {
      const task=current(),open=form(),before=snapshot().shift.snapshot;
      if(!open?.id||open.dirty){result='not_saved';await say('Save your work in ERPNext, then Continue here to review it.');return;}
      const doc=await app.read(task.doctype,open.id);
      if(before!==snapshot().shift.snapshot)throw new Error('Your form changed during the check. Continue again when ready.');
      if(!doc)throw new Error('ERPNext could not return the saved record.');
      if(doc.docstatus===0&&equal(doc,{...task.expected,docstatus:0})) {
        result='not_saved';await say('The draft matches the business documents. Your turn: Submit in ERPNext, then Continue here to inspect its effects.');return;
      }
      if(!equal(doc,task.expected)) {
        const s=support();s.failures=Math.min(99,s.failures+1);s.level=s.failures>1?'navigation':'evidence';
        delete state.done[taskId];state.closing=false;handoverReady=false;save();result='mismatch';
        const wrong=task.steps.filter(s=>!equal(doc[s.field],s.value)).map(s=>app.label(s.field)||s.field);
        await say(task.business.clue+(s.failures>1&&wrong.length?' Look at: '+wrong.join(', ')+'.':'')
          +(doc.docstatus===1?' This record is submitted; inspect downstream links with Instructor before using ERPNext’s correction workflow.':' Correct the draft, save, then Continue.'));return;
      }
      for(const extra of task.also||[])if(!equal(await app.read(extra.doctype,extra.record),extra.expected)) {
        result='mismatch';await say('The linked record does not yet show the expected business effect. '+extra.text);return;
      }
      const evidence=app.postings?postedText(await app.postings(task.doctype,open.id)):'';
      if(before!==snapshot().shift.snapshot)throw new Error('Your form changed during the check. Continue again when ready.');
      const done={record:open.id,checkedAt:new Date().toISOString(),assisted:support().demonstrations>0||support().helpRequests>0,explained:false};
      await request('/progress',{task:taskId,...done});
      state.done[taskId]={...done,evidence};support().level='brief';state.closing=false;handoverReady=false;
      const p=state.predictions[taskId];if(p&&task.predict)p.actual=await app.evidence(task.predict.evidence,open.id);
      save();result='matched';await say('ERPNext verified your saved work. Explain the business consequence here.');
    }
    async function continueTask(id) {
      if(id!==taskId)return 'The situation changed. Continue from the current brief.';
      if(actor)return 'The demonstration is handing control back. Try Continue again.';
      if(blocked().length)return 'Handle the earlier situation first.';
      if(question())return 'Answer the current question in Instructor, or ask for help.';
      if(finished(taskId)) {
        if(app.current()?.dirty)return 'Save or discard your current changes in ERPNext before continuing.';
        if(taskId===shift.live.at(-1)) {
          if(!state.closing)await handover();await publish();return state.closing?'Your shift is complete.':'Give the owner your handover here.';
        }
        taskId=shift.live[shift.live.indexOf(taskId)+1];action='next';result=null;save();
        await say('Your turn. Read the next business situation below.');await publish();return status;
      }
      action='check';await review();await publish();return status;
    }
    async function openTask(id) {
      if(!shift.live.includes(id))return 'That record was prepared before your shift.';
      if(app.current()?.dirty||actor)return 'Finish your current edit or demonstration before changing situations.';
      taskId=id;action='view';result=null;save();await publish();return blocked().length?'Handle the earlier situation first.':'Read the business brief here.';
    }
    async function demonstrate(command) {
      if(!command||!actions.includes(command.action)||!/^[a-f0-9]{32}$/.test(command.id||''))return {status:'rejected',message:'Unknown browser action.'};
      const previous=state.executions[command.id];
      if(previous)return previous.status==='running'?{status:'uncertain',message:'This action already started. Inspect the current form; it will not be replayed.'}:previous;
      if(actor||command.task!==taskId||command.snapshot!==snapshot().shift.snapshot||!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now()||command.expiresAt>Date.now()+15000)
        return {status:'rejected',message:'The form changed or the demonstration expired. Inspect the latest observation.'};
      if(blocked().length)return {status:'rejected',message:'An earlier business situation is unfinished.'};
      if(app.current()?.dirty&&!(command.action==='fill_routine'&&form()?.isNew))return {status:'rejected',message:'The student has unsaved changes. Hand control back without changing them.'};
      const started=Date.now(),owned=actor={id:command.id,interrupted:false};
      state.executions[command.id]={status:'running'};save();
      const guard=()=>{if(stopped||actor!==owned||owned.interrupted||Date.now()>command.expiresAt||app.user()!==user)throw new Error('Control returned to the student. Inspect the current form before another demonstration.');};
      const connected=async()=>{guard();if((await request('/state')).connected!==true)throw new Error('Instructor disconnected. Control is with the student.');guard();};
      const until=async(predicate)=>{for(let i=0;i<35;i++){guard();if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('ERPNext did not open the expected form in time. Control is with the student.');};
      let outcome;
      try {
        const task=current();action='help';support().helpRequests=Math.min(99,support().helpRequests+1);support().level='navigation';
        await say('Instructor is demonstrating. You can take control by interacting with ERPNext.');guard();
        if(command.action==='open_source'||command.action==='prepare_draft') {
          const source=raw(task.source.task),record=state.done[source.id]?.record;
          if(!record)throw new Error('The source record is unavailable.');
          if(form()?.isNew)throw new Error('A draft is already open. Your turn to work on it.');
          await connected();await app.openRecord(source.doctype,record);await until(()=>app.current()?.form===source.doctype&&app.current()?.id===record);
          if(command.action==='prepare_draft') {
            await connected();await app.create(task.source.action);await until(()=>form()?.isNew===true);
          }
        }
        if(command.action==='fill_routine') {
          if(!form()?.isNew||form()?.values?.company!==company)throw new Error('Open a new draft for this company first.');
          // An allowlisted scalar can be demonstrated. Decisions and child tables are always the student's work.
          for(const s of task.steps.filter(s=>!s.decide&&!Array.isArray(s.value))) {
            guard();if(!form()?.isNew)throw new Error('The form changed.');
            const old=form().values[s.field];
            if(old!==null&&old!==undefined&&old!==''&&!equal(old,s.value))throw new Error('A routine field already has a different value. Ask the student to review it.');
            if(!equal(old,s.value)){await connected();await app.setValue(s.field,s.value);}
          }
        }
        let evidence='';
        if(command.action==='inspect_result') {
          if(!form()?.id||form().dirty)throw new Error('Save your work before inspecting its effects.');
          const doc=await app.read(task.doctype,form().id);
          if(doc?.company!==company)throw new Error('This is not the learner’s training company.');
          evidence=app.postings?postedText(await app.postings(task.doctype,form().id)):'';
        }
        guard();support().demonstrations=Math.min(99,support().demonstrations+1);
        outcome={status:'completed',message:'Your turn. Decide the business values from the brief, then Save and Submit yourself. No work was graded by this demonstration.',...(evidence?{evidence:evidence.slice(0,1800)}:{})};
      } catch(error) {outcome={status:owned.interrupted?'interrupted':'failed',message:String(error.message||'The demonstration stopped.').slice(0,600)};}
      finally {if(actor===owned)actor=undefined;}
      outcome.duration_ms=Date.now()-started;
      state.executions[command.id]=outcome;
      // Keep the attempt journal bounded; action ids are generated once by the desktop and never reissued.
      for(const id of Object.keys(state.executions).slice(0,-64))delete state.executions[id];
      save();await say(outcome.message);await publish();return outcome;
    }
    const interrupt=event=>{if(!event.isTrusted)return;dirtyGeneration++;action='edit';result=null;if(actor)actor.interrupted=true;};
    for(const name of ['input','change','pointerdown','keydown'])document.addEventListener(name,interrupt,true);
    window.dhimantaiErpGuide={headless:true,user,tag,current,question,answerQuestion,continueTask,openTask,demonstrate,snapshot,status:()=>status,
      dispose(){stopped=true;if(actor)actor.interrupted=true;clearInterval(timer);for(const name of ['input','change','pointerdown','keydown'])document.removeEventListener(name,interrupt,true);}};
    async function tick() {
      if(stopped||busy||Date.now()<transport.nextAt)return;busy=true;
      try {
        if(app.user()!==user){stopped=true;return;}
        await publish();const remote=await request('/state');
        if(remote.demonstration) {
          const outcome=await demonstrate(remote.demonstration);
          await request('/demonstration-result',{id:remote.demonstration.id,...outcome});
        }
        if(remote.answer&&remote.answer.id!==lastAnswer) {
          if(await answerQuestion(remote.answer.id,remote.answer.answer))lastAnswer=remote.answer.id;
        }
        if(remote.taskAction&&remote.taskAction.id!==lastTaskAction) {
          // Claim before execution: a timeout or rejected ack cannot repeat an action.
          lastTaskAction=remote.taskAction.id;
          let message;try{message=remote.taskAction.kind==='open'?await openTask(remote.taskAction.task):await continueTask(remote.taskAction.task);}
          catch(error){message=String(error.message||'ERPNext could not complete the check.').slice(0,600);}
          await request('/continue-result',{id:remote.taskAction.id,status:message});
        }
        transport.failures=0;transport.nextAt=0;save();
      } catch {
        transport.failures++;transport.nextAt=Date.now()+1000*2**transport.failures;
        if(transport.failures>=3){stopped=true;if(actor)actor.interrupted=true;}
        save();
      } finally {busy=false;}
    }
    const timer=setInterval(()=>{void tick();},1000);
    save();
    window.addEventListener('pagehide',()=>window.dhimantaiErpGuide.dispose(),{once:true});
    // A reopened Instructor still needs the actual consequences, not a cached explanation.
    const pending=state.done[taskId];
    if(pending&&!pending.explained)try {
      const task=current(),doc=await app.read(task.doctype,pending.record);
      let matches=equal(doc,task.expected);
      for(const extra of task.also||[])matches=matches&&equal(await app.read(extra.doctype,extra.record),extra.expected);
      if(matches)pending.evidence=app.postings?postedText(await app.postings(task.doctype,pending.record)):'';
      else{delete state.done[taskId];state.closing=false;save();}
    }catch{pending.evidence='ERPNext could not refresh the postings. Inspect the saved record before explaining its effects.';}
    if(shift.live.every(finished)&&!state.closing)try{await handover();}catch{}
    await tick();
  }};
})();
