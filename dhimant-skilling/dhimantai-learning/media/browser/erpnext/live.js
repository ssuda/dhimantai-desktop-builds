/* Form observations go to the owning dhimantAI session on loopback, never to a third-party browser service. */
(() => {
  'use strict';
  async function boot() {
    const guide=window.dhimantaiErpGuide;
    if(!guide)return setTimeout(boot,500);
    let connection;
    try{connection=JSON.parse(sessionStorage.getItem('dhimantai-erpnext-instructor')||'null');}catch{}
    if(!connection || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)
        || !/^[a-f0-9]{64}$/.test(connection.token) || guide.user!==`learner-${connection.learner}@training.invalid`)return;
    const root=guide.root, area=guide.live||root.getElementById('body');
    area.insertAdjacentHTML('beforeend','<button id="ask-instructor">Ask Instructor</button><label><input id="follow-browser" type="checkbox" checked> Instructor follows this form</label><small id="live-status" role="status">Connecting to Instructor…</small>');
    const follow=root.getElementById('follow-browser'),status=root.getElementById('live-status'),ask=root.getElementById('ask-instructor');
    let enabled=true,connected=false,sequence=0,latestHash='',lastSent=0,lastError='',problem=false,action='view',result=null;
    let pending=Promise.resolve(),closed=false;
    const nextSequence=()=>{sequence=Math.max(sequence+1,Date.now()*1000);return sequence;};
    const request=async(path,body)=>{
      const response=await fetch(connection.origin+path,{method:body===undefined?'GET':'POST',
        headers:{Authorization:'Bearer '+connection.token,...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(9000)});
      if(!response.ok)throw new Error(response.status===401 || response.status===410?'Reopen ERPNext from dhimantAI to reconnect.':'Instructor connection is unavailable.');
      return response.json();
    };
    const scalar=v=>typeof v==='string'?v.slice(0,600):typeof v==='number'&&Number.isFinite(v)?v:typeof v==='boolean'?v:null;
    function snapshot() {
      const task=guide.current(),frm=window.cur_frm,doc=frm?.doc,company='Training '+guide.tag;
      const own=frm?.doctype===task.doctype && (frm.is_new()
        ? !doc.company || doc.company===company
        : task.doctype==='Company'?doc.name===company
        : task.expected.company?doc.company===company
        : task.doctype==='Customer'?doc.customer_name===task.expected.customer_name
        : task.doctype==='Supplier'?doc.supplier_name===task.expected.supplier_name
        : task.doctype==='Item'?doc.item_code===task.expected.item_code:false);
      const fields={};
      if(own)for(const s of task.steps) {
        fields[s.field]=Array.isArray(s.value)?(Array.isArray(doc[s.field])?doc[s.field].slice(0,10).map(row=>
          Object.fromEntries([...new Set(s.value.flatMap(Object.keys))].map(k=>[k,scalar(row[k])]))):[]):scalar(doc[s.field]);
      }
      const errors=own?[...document.querySelectorAll('.modal.show .msgprint, .alert-danger')].filter(e=>e.getClientRects().length)
        .map(e=>e.textContent.trim().slice(0,500)).filter(Boolean).slice(0,2):[];
      if(result==='mismatch'||result==='not_saved')errors.push(guide.status().slice(0,500));
      return {course:'erpnext-essentials',task:task.id,step:guide.step(),training_tag:guide.tag,
        route:(window.frappe.get_route?.()||[]).map(s=>String(s)).join('/').slice(0,300),
        doctype:own?frm.doctype:'',record:own?String(doc.name||'').slice(0,160):'',dirty:own?!!frm.is_dirty():false,
        docstatus:own&&[0,1,2].includes(doc.docstatus)?doc.docstatus:null,fields,errors,action,result};
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
    /** Help is always the learner's choice. A problem only changes what the button offers. */
    function offer(active) {
      problem=active;
      ask.textContent=active?'Ask Instructor about this':'Ask Instructor';
      ask.classList.toggle('primary',active);
    }
    async function help() {
      if(!enabled || !connected || closed)return;
      const message=problem?'ERPNext reported a problem with this step. What should I look at?':'Help me with this ERPNext step.';
      ask.disabled=true;
      try {
        await observe(true);
        if(!enabled || closed)return;
        await request('/help',{message});
        offer(false);status.textContent='Instructor is answering in the left pane.';
      }catch(error){status.textContent=error.message;}finally{ask.disabled=!connected||!enabled;}
    }
    ask.onclick=()=>{void help();};
    follow.onchange=()=>{
      enabled=follow.checked;latestHash='';ask.disabled=!enabled||!connected;
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
      const {title,question,text,prediction}=event.detail;
      if(!enabled || !connected || closed)return;
      void observe(true).then(()=>request('/help',{message:(`My explanation for “${title}”.\n${prediction?'Prediction: '+prediction.slice(0,500)+'\n':''}Question: ${question}\nMy answer: ${text}\n`
        +'Check my reasoning against my records: say what is right, correct one gap, and ask me one follow-up. Do not give me a model answer before I try again.').slice(0,1500)}))
        .then(()=>{status.textContent='Instructor is reading your explanation in the left pane.';}).catch(error=>{status.textContent=error.message;});
    });
    const observationTimer=setInterval(()=>{
      if(document.hidden || !enabled)return;
      void observe().catch(()=>{});
      const error=snapshot().errors.filter(e=>e!==guide.status().slice(0,500)).join('\n');
      if(error && error!==lastError){lastError=error;offer(true);}else if(!error && lastError){lastError='';if(result!=='mismatch')offer(false);}
    },900);
    const stateTimer=setInterval(async()=>{
      try{const state=await request('/state');connected=state.connected===true;
        if(enabled)status.textContent=typeof state.detail==='string'?state.detail:'Instructor connection changed.';
      }catch(error){connected=false;if(enabled)status.textContent=error.message;}
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
