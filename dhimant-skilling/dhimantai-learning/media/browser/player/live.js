/* Form observations go to the owning dhimantAI session on loopback, never to a third-party browser service. */
(() => {
  'use strict';
  if (window.__dhimantaiLive) return;
  window.__dhimantaiLive = true;
  async function boot() {
    const guide=window.dhimantaiErpGuide;
    if(!guide)return setTimeout(boot,500);
    let connection;
    try{connection=JSON.parse(sessionStorage.getItem('dhimantai-erpnext-instructor')||'null');}catch{}
    if(!connection || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)
        || !/^[a-f0-9]{64}$/.test(connection.token) || guide.user!==`learner-${connection.learner}@training.invalid`)return;
    const root=guide.root, area=guide.live||root.getElementById('body');
    area.insertAdjacentHTML('beforeend','<button id="ask-instructor" class="link" disabled>Ask Instructor</button><small id="live-status" role="status">Connecting to Instructor…</small>');
    (root.getElementById('connection-options')||area).insertAdjacentHTML('beforeend','<label><input id="follow-browser" type="checkbox" checked> Share this task’s fields with Instructor</label>');
    const follow=root.getElementById('follow-browser'),status=root.getElementById('live-status'),ask=root.getElementById('ask-instructor');
    let enabled=true,connected=false,sequence=0,latestHash='',lastSent=0,lastError='',problem=false,action='view',result=null;
    let pending=Promise.resolve(),closed=false,questionHash='',questionSync=Promise.resolve(),lastTaskAction,readingState=false;
    const nextSequence=()=>{sequence=Math.max(sequence+1,Date.now()*1000);return sequence;};
    const request=async(path,body)=>{
      const response=await fetch(connection.origin+path,{method:body===undefined?'GET':'POST',
        headers:{Authorization:'Bearer '+connection.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw new Error(response.status===401 || response.status===410?'Reopen the course from dhimantAI to reconnect.':'Instructor connection is unavailable.');
      return response.json();
    };
    const scalar=v=>typeof v==='string'?v.slice(0,600):typeof v==='number'&&Number.isFinite(v)?v:typeof v==='boolean'?v:null;
    function snapshot() {
      const app=window.dhimantaiApp,task=guide.current(),open=app.current(),doc=open?.values,company='Training '+guide.tag;
      const formName=task.form||task.doctype;
      // Only the learner's own record for this task leaves the page; another company's or person's record never does.
      const identity=task.identity||['customer_name','supplier_name','item_code'].find(k=>typeof task.expected[k]==='string');
      const own=!!open && open.form===formName && (open.isNew
        ? !doc.company || doc.company===company
        : task.readOnly && task.record ? open.id===task.record
        : task.expected.company ? doc.company===company
        : identity ? doc[identity]===task.expected[identity] : false);
      const fields={};
      if(own)for(const s of task.steps) {
        fields[s.field]=Array.isArray(s.value)?(Array.isArray(doc[s.field])?doc[s.field].slice(0,10).map(row=>
          Object.fromEntries([...new Set(s.value.flatMap(Object.keys))].map(k=>[k,scalar(row[k])]))):[]):scalar(doc[s.field]);
      }
      const errors=own?app.errors().slice(0,2):[];
      if(result==='mismatch'||result==='not_saved')errors.push(guide.status().slice(0,500));
      return {course:guide.course,task:task.id,step:guide.step(),training_tag:guide.tag,
        route:String(app.route()||'').slice(0,300),
        doctype:own?formName:'',record:own?String(open.id||'').slice(0,160):'',dirty:own?!!open.dirty:false,
        docstatus:own?(open.final?1:0):null,fields,errors,action,result};
    }
    function observe(force=false) {
      if(!enabled || closed)return Promise.resolve();
      const data=snapshot(),hash=JSON.stringify(data);
      if(!force && hash===latestHash && Date.now()-lastSent<20000)return pending;
      latestHash=hash;lastSent=Date.now();const body={...data,sequence:nextSequence()};
      pending=pending.catch(()=>{}).then(()=>enabled&&!closed?request('/observe',body):undefined).then(()=>{});
      void pending.catch(error=>{connected=false;status.textContent=error.message;});
      return pending;
    }
    function publishQuestion() {
      if(!enabled || closed || !guide.question)return Promise.resolve();
      questionSync=questionSync.catch(()=>{}).then(async()=>{
        await observe();
        if(!enabled || closed)return;
        const question=guide.question(),hash=JSON.stringify(question);
        if(hash===questionHash)return;
        await request('/question',{question});questionHash=hash;
      });
      return questionSync;
    }
    /** Help is always the learner's choice. A problem only changes what the button offers. */
    function offer(active) {
      problem=active;
      ask.textContent=active?'Ask Instructor about this':'Ask Instructor';
    }
    async function help() {
      if(!enabled || !connected || closed)return;
      const product=window.dhimantaiApp?.title||'The application';
      const message=problem?`${product} reported a problem with this step. What should I look at?`:`Help me with this ${product} step.`;
      ask.disabled=true;
      try {
        await observe(true);
        if(!enabled || closed)return;
        await request('/help',{message});
        offer(false);guide.reportStatus('Instructor is answering in the Instructor panel.');
      }catch(error){guide.reportStatus(error.message);}finally{ask.disabled=!connected||!enabled;}
    }
    ask.onclick=()=>{void help();};
    window.addEventListener('dhimantai-erp-focus',event=>{
      void (async()=>{
        if(!enabled) {guide.reportStatus('Turn on “Share this task’s fields with Instructor” in About this task to continue.');return;}
        try {
          await publishQuestion();
          if(guide.question()?.id!==event.detail.id)return;
          await request('/focus',{id:event.detail.id});
          guide.reportStatus('Answer in the Instructor message box. Your saved work stays here.');
        }catch(error){guide.reportStatus(error.message);}
      })();
    });
    follow.onchange=()=>{
      enabled=follow.checked;latestHash='';questionHash='';ask.disabled=!enabled||!connected;
      if(enabled)void observe(true);
      else {
        status.textContent='Observation paused. No form updates are sent.';
        void request('/observe',{sequence:nextSequence(),clear:true}).catch(()=>{});
      }
    };
    document.addEventListener('input',()=>{action='edit';result=null;},true);
    document.addEventListener('change',()=>{action='edit';result=null;},true);
    window.addEventListener('dhimantai-erp-activity',event=>{
      action=event.detail.action;result=event.detail.result;
      offer(result==='mismatch');
      void observe(true).catch(()=>{});
    });
    window.addEventListener('dhimantai-erp-verified',event=>{
      const {task,record,checkedAt,assisted,explained}=event.detail;
      void request('/progress',{task,record,checkedAt,assisted,explained:explained===true}).catch(()=>{});
    });
    // The learner's own explanation, in their words, for the Instructor to check: the course's teach-back.
    window.addEventListener('dhimantai-erp-explained',event=>{
      if(event.detail.fromInstructor)return; // The answer already went through the notebook's chat transport.
      const {title,question,text,prediction,recorded}=event.detail;
      if(!enabled || !connected || closed)return;
      const product=window.dhimantaiApp?.title||'The application';
      // What the application actually posted goes first, so the Instructor checks the reasoning against real entries.
      void observe(true).then(()=>request('/help',{message:(`My explanation for “${title}”.\n${recorded?product+' recorded: '+String(recorded).slice(0,600)+'\n':''}${prediction?'Prediction: '+prediction.slice(0,400)+'\n':''}Question: ${question}\nMy answer: ${text.slice(0,800)}\n`
        +'Check my reasoning against my records: say what is right, correct one gap, and ask me one follow-up. Do not give me a model answer before I try again.').slice(0,1500)}))
        .then(()=>{status.textContent='Instructor is reading your explanation in the left pane.';}).catch(error=>{status.textContent=error.message;});
    });
    const observationTimer=setInterval(()=>{
      if(document.hidden || !enabled)return;
      void observe().catch(()=>{});
      void publishQuestion().catch(error=>{status.textContent=error.message;});
      const error=snapshot().errors.filter(e=>e!==guide.status().slice(0,500)).join('\n');
      if(error && error!==lastError){lastError=error;offer(true);}else if(!error && lastError){lastError='';if(result!=='mismatch')offer(false);}
    },900);
    const stateTimer=setInterval(async()=>{
      if(readingState || closed)return;readingState=true;
      try{const state=await request('/state');connected=state.connected===true;
        if(enabled && state.answer && guide.answerQuestion) {
          await guide.answerQuestion(state.answer.id,state.answer.answer);
          await publishQuestion();
        }
        if(enabled && state.taskAction && guide.continueTask) {
          if(lastTaskAction?.id!==state.taskAction.id) {
            const status=state.taskAction.kind==='open'
              ? await guide.openTask(state.taskAction.task) : await guide.continueTask(state.taskAction.task);
            lastTaskAction={id:state.taskAction.id,status};
          }
          await observe(true);await publishQuestion();
          await request('/continue-result',lastTaskAction);
        }
        if(enabled)status.textContent=connected?'':typeof state.detail==='string'?state.detail:'Instructor connection changed.';
      }catch(error){connected=false;if(enabled)status.textContent=error.message;}
      finally{readingState=false;}
      ask.disabled=!connected||!enabled;
    },3000);
    window.addEventListener('pagehide',()=>{
      closed=true;clearInterval(observationTimer);clearInterval(stateTimer);
      void fetch(connection.origin+'/observe',{method:'POST',keepalive:true,
        headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},
        body:JSON.stringify({sequence:nextSequence(),clear:true})}).catch(()=>{});
    });
    void observe(true).catch(()=>{});
  }
  boot().catch(()=>{});
})();
