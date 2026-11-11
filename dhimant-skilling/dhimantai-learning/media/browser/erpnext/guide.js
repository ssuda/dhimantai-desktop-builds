/* Reusable authored browser guide. Runs only inside the bundled ERPNext training image. */
(() => {
  'use strict';
  const equal = (actual, expected) => {
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v,i) => equal(actual[i],v));
    if (expected && typeof expected === 'object') return !!actual && Object.entries(expected).every(([k,v]) => equal(actual[k],v));
    return typeof expected === 'number' ? Number(actual) === expected && actual !== '' && actual != null : actual === expected;
  };
  /** A table row is identified by its first authored key (item_code, reference_doctype…). */
  const rowKey = expected => Array.isArray(expected) && expected[0] && typeof expected[0] === 'object' ? Object.keys(expected[0])[0] : undefined;
  /** Rows ERPNext adds empty (no item yet) are not the learner's work. */
  const rows = (value, expected) => { const k=rowKey(expected); return k && Array.isArray(value) ? value.filter(row => row && row[k]) : value; };
  const stepDone = (doc, s) => !!doc && equal(rows(doc[s.field], s.value), s.value);
  /** Earlier tasks a task depends on: records it links to, and the record it is created from. */
  const dependencies = lesson => [...new Set([...JSON.stringify(lesson).matchAll(/\{\{ref:([a-z0-9-]+)\}\}/g)].map(m => m[1]).concat(lesson.source ? [lesson.source.task] : []))];
  // A pure export keeps regression tests on the same predicates used by real ERPNext records.
  if (typeof module !== 'undefined') { module.exports = {equal, stepDone, dependencies}; return; }
  async function boot() {
    if (!window.frappe?.session?.user || !window.frappe?.ui?.form) return setTimeout(boot,500);
    const user = frappe.session.user, match = /^learner-([a-f0-9]{20})@training\.invalid$/.exec(user);
    const requested=new URLSearchParams(location.search).get('dhimantai-user') || sessionStorage.getItem('dhimantai-erpnext-learner');
    if(requested && /^[a-f0-9]{20}$/.test(requested)) {
      if(user!==`learner-${requested}@training.invalid`) {
        const result=await fetch('/api/method/logout',{method:'POST',credentials:'same-origin',headers:{'X-Frappe-CSRF-Token':frappe.csrf_token}});
        // The launch page signs the requested learner in again through dhimantAI when it can.
        if(result.ok)location.replace('/assets/frappe/dhimantai/launch.html');
        return;
      }
      const clean=new URL(location.href);clean.searchParams.delete('dhimantai-user');history.replaceState(null,'',clean);
    }
    if (!match || document.getElementById('dhimantai-guide')) return;
    let connection;
    try { connection=JSON.parse(sessionStorage.getItem('dhimantai-erpnext-instructor')||'null'); } catch {}
    const connected=connection && /^http:\/\/127\.0\.0\.1:\d+$/.test(connection.origin)
      && /^[a-f0-9]{64}$/.test(connection.token) && connection.learner===match[1];
    const response = connected
      ? await fetch(connection.origin+'/course',{headers:{Authorization:'Bearer '+connection.token},cache:'no-store',signal:AbortSignal.timeout(15000)})
      : await fetch('/assets/frappe/dhimantai/course.json');
    if (!response.ok) return;
    const template = await response.text(), tag = match[1].slice(0,10);
    const course = JSON.parse(template.replaceAll('{{tag}}',tag).replaceAll('{{company}}','Training ' + tag));
    const key = 'dhimantai-browser:' + course.id + ':v' + course.version + ':' + user;
    let state;
    try { state = JSON.parse(localStorage.getItem(key) || '{}'); } catch { state = {}; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    for (const name of ['done','assisted','revealed','predictions']) state[name] = state[name] && typeof state[name] === 'object' && !Array.isArray(state[name]) ? state[name] : {};
    // dhimantAI keeps verified tasks per account, so they survive cleared browser storage.
    if (course.verified && typeof course.verified === 'object')
      for (const [id,done] of Object.entries(course.verified)) if (!state.done[id]?.explained && course.lessons.some(l=>l.id===id)) state.done[id]=done;
    const finished = id => state.done[id]?.explained === true;
    const resolve = value => JSON.parse(JSON.stringify(value).replaceAll('{{today}}',frappe.datetime.get_today())
      .replace(/\{\{ref:([a-z0-9-]+)\}\}/g,(_,id)=>JSON.stringify(state.done[id]?.record ?? '').slice(1,-1)));
    const firstOpen = Math.max(0, course.lessons.findIndex(l => !finished(l.id)));
    let index = Number.isInteger(state.lesson) ? Math.max(0,Math.min(course.lessons.length - 1,state.lesson)) : firstOpen;
    let revision = 0, checking = false, filling = false, focusStep, lastSignature = '';
    const status = {textContent:''};
    const save = () => { state.lesson = index; try { localStorage.setItem(key,JSON.stringify(state)); } catch { setStatus('Browser storage is unavailable. Your ERPNext records are still saved.'); } };
    const host = document.createElement('aside'); host.id = 'dhimantai-guide';
    const shadow = host.attachShadow({mode:'open'});
    // Colours come from ERPNext's own theme variables, so the bar follows its light and dark themes.
    shadow.innerHTML = `<style>
      :host{position:fixed;left:0;right:0;bottom:0;z-index:10020;font:13px/1.45 var(--font-stack,system-ui);color:var(--text-color,#171717)}
      *{box-sizing:border-box}
      section{background:var(--fg-color,#fff);border-top:1px solid var(--border-color,#ededed);box-shadow:0 -4px 16px rgba(0,0,0,.08);padding:8px 16px;max-height:45vh;overflow:auto}
      .row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
      .brand{font-weight:600;white-space:nowrap}
      select,button,textarea{font:inherit;color:inherit;border-radius:var(--border-radius,6px)}
      select{padding:4px 8px;border:1px solid var(--border-color,#ededed);background:var(--control-bg,#f3f3f3);max-width:280px}
      button{border:1px solid var(--border-color,#ededed);padding:4px 10px;background:var(--btn-default-bg,#f3f3f3);cursor:pointer;white-space:nowrap}
      button.primary{background:var(--btn-primary,var(--primary,#171717));color:var(--neutral,#fff);border-color:transparent}
      button.link{border:0;background:none;padding:0 2px;text-decoration:underline;color:var(--text-muted,#525252)}
      button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible,textarea:focus-visible{outline:2px solid var(--primary,#171717);outline-offset:2px}
      .actions{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
      ol{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;padding:0;list-style:none}
      ol button{border-radius:999px;padding:1px 10px;background:transparent;color:var(--text-muted,#525252)}
      ol button[aria-current="step"]{border-color:var(--primary,#171717);color:var(--text-color,#171717);font-weight:600}
      #now{margin:6px 0 0}#now strong{font-weight:600}#example{font-family:var(--font-stack-monospace,ui-monospace,monospace);overflow-wrap:anywhere}
      #status{margin:4px 0 0}#status:empty{display:none}
      #explain{margin-top:8px;padding:8px 10px;border:1px solid var(--border-color,#ededed);border-radius:var(--border-radius,6px)}
      #explain label{display:block;font-weight:600;margin-bottom:4px}#explain textarea{width:100%;min-height:56px;padding:6px 8px;border:1px solid var(--border-color,#ededed);background:var(--control-bg,#f3f3f3);resize:vertical}
      #explain .row{margin-top:4px}#explain small{color:var(--text-muted,#525252)}
      details{margin-top:6px;color:var(--text-muted,#525252)}summary{cursor:pointer;width:max-content}details p{margin:4px 0}
      fieldset{margin:8px 0 0;padding:8px 10px;border:1px solid var(--border-color,#ededed);border-radius:var(--border-radius,6px)}
      legend{font-weight:600;padding:0 4px}fieldset label{display:block;margin:2px 0;cursor:pointer}fieldset .row{margin-top:4px}
      #result{margin:8px 0 0;padding:8px 10px;border-left:3px solid var(--border-color,#ededed)}#result.right{border-color:var(--green-500,#2f9e44)}#result.wrong{border-color:var(--orange-500,#e8590c)}
      #result strong{font-weight:600}
      a{color:inherit}#live:empty{display:none}#live{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:6px}
      [hidden]{display:none!important}
    </style><section aria-label="dhimantAI ERPNext task"><div class="row"><span class="brand">dhimantAI task</span>
      <select id="lesson" aria-label="Course task"></select>
      <span id="count"></span>
      <span class="actions"><button id="open">Open task</button><button id="fill">Fill this field</button><button id="check" class="primary">Check saved work</button><button id="toggle" aria-expanded="true">Hide</button></span></div>
      <div id="body"><ol id="steps" aria-label="Fields in this task"></ol><p id="now"></p>
      <p id="status" role="status" aria-live="polite"></p>
      <fieldset id="predict" hidden><legend id="predict-question"></legend><div id="predict-options"></div>
        <div class="row"><button id="lock-prediction" class="primary" disabled>Lock in my prediction</button><small id="predict-note">Predict before you Submit. After the check you will see what ERPNext actually did.</small></div></fieldset>
      <p id="result" hidden></p>
      <div id="explain" hidden><label for="explanation" id="question"></label><textarea id="explanation" maxlength="500" placeholder="Answer in your own words, using your own records."></textarea>
        <div class="row"><button id="send-explanation" class="primary" disabled>Send my explanation</button><small>The Instructor checks your reasoning. The task counts as done once you have explained it.</small></div></div>
      <div id="live"></div>
      <details><summary>About this task</summary><p id="scenario"></p><p id="why"></p><p id="progress"></p><p>Checks confirm your saved ERPNext records; they are practice evidence, not a grade. <a href="https://school.frappe.io/lms/courses/erpnext-training" target="_blank" rel="noopener">Frappe School reference</a></p></details>
    </div></section>`;
    document.body.append(host);
    const $ = id => shadow.getElementById(id), statusEl = $('status');
    const setStatus = text => { status.textContent = text; statusEl.textContent = text; };
    // Keep every ERPNext field above the bar. Desk scrolls inside its own containers (div.main-section in v16),
    // not the body, so reserve the bar's height in whichever scrolling containers reach under it.
    const reserved = new Map();
    let scrollers = [];
    const reserve = (scan = false) => {
      const height = Math.ceil(host.getBoundingClientRect().height), top = innerHeight - height;
      if (scan || !scrollers.length) {
        scrollers = [document.scrollingElement || document.documentElement, ...document.querySelectorAll('.main-section, .layout-main, .page-container, .modal-body')];
        for (const el of document.querySelectorAll('body *')) {
          if (el === host || el === outline) continue;
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4) scrollers.push(el);
        }
        scrollers = [...new Set(scrollers)];
      }
      for (const el of scrollers) {
        const rect = el.getBoundingClientRect(), covers = rect.bottom > top + 1 && rect.height > 0;
        if (!reserved.has(el)) reserved.set(el, el.style.paddingBottom);
        el.style.paddingBottom = covers ? height + 'px' : reserved.get(el);
        el.style.scrollPaddingBottom = covers ? height + 'px' : '';
      }
      document.body.style.paddingBottom = height + 'px';
    };
    const outline = document.createElement('div');
    Object.assign(outline.style,{position:'fixed',pointerEvents:'none',border:'2px solid var(--primary,#171717)',borderRadius:'6px',zIndex:'10019',display:'none'});
    document.body.append(outline);
    const raw = () => course.lessons[index];
    const current = () => resolve(raw());
    const lessonOf = id => course.lessons.find(l => l.id === id);
    const missing = () => dependencies(raw()).filter(id => !state.done[id]?.record);
    const activity=(action,result=null)=>window.dispatchEvent(new CustomEvent('dhimantai-erp-activity',{detail:{action,result}}));
    const form = () => window.cur_frm?.doctype === current().doctype ? window.cur_frm : undefined;
    /** On the earlier record this task is created from, before using its Create menu. */
    const onSource = () => { const src=current().source; return !!src && !form() && window.cur_frm?.doctype===lessonOf(src.task)?.doctype && window.cur_frm?.doc?.name===state.done[src.task]?.record; };
    /** The step follows the learner's form: the first field that does not yet hold the task's value. */
    const step = () => {
      const lesson = current(), doc = form()?.doc;
      if (Number.isInteger(focusStep) && focusStep < lesson.steps.length && !stepDone(doc, lesson.steps[focusStep])) return focusStep;
      const open = lesson.steps.findIndex(s => !stepDone(doc, s));
      return open < 0 ? lesson.steps.length - 1 : open;
    };
    const complete = () => { const doc=form()?.doc; return !!doc && current().steps.every(s => stepDone(doc, s)); };
    const field = () => form()?.fields_dict?.[current().steps[step()]?.field];
    const activeRecord = () => form() && !form().is_new() && !form().is_dirty() ? form().doc.name : undefined;
    const label = name => form()?.fields_dict?.[name]?.df?.label || name.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
    const labels={item_code:'Item',qty:'Qty',rate:'Rate (INR)',basic_rate:'Basic rate (INR)',schedule_date:'Required by',delivery_date:'Delivery date',
      t_warehouse:'Target warehouse',warehouse:'Warehouse',purchase_order:'Purchase order',purchase_receipt:'Purchase receipt',against_sales_order:'Sales order',
      delivery_note:'Delivery note',reference_doctype:'Type',reference_name:'Name',allocated_amount:'Allocated (INR)'};
    const show = value => Array.isArray(value) ? value.map(row=>Object.entries(row).map(([k,v])=>(labels[k]||k)+' '+v).join(' · ')).join('; ') : String(value);
    const revealed = at => !raw().steps[at]?.decide || !!state.revealed[raw().id+':'+at];
    const docstatus = () => current().expected.docstatus;
    /** full: field-by-field help; goals: the situation only; none: an independent challenge. */
    const level = () => raw().guidance || 'full';
    const predicted = () => state.predictions[raw().id];
    /** Prediction is still open: the task has one, it is unanswered, and either the record is not submitted yet or the check passed without one. */
    const predicting = () => !!current().predict && !predicted() && (!!state.done[raw().id] || !!form() && Number(form().doc?.docstatus ?? 0) === 0);
    function highlight(scroll=false) {
      if (level() !== 'full') { outline.style.display='none'; return; }
      const s=current().steps[step()];
      if(scroll)form()?.scroll_to_field?.(s?.field,false);
      const element = field()?.wrapper, rect = element?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height || $('body').hidden) { outline.style.display='none'; return; }
      if (scroll) element.scrollIntoView({behavior:'smooth',block:'center'});
      Object.assign(outline.style,{display:'block',left:rect.left-3+'px',top:rect.top-3+'px',width:rect.width+6+'px',height:rect.height+6+'px'});
    }
    function render() {
      const lesson = current(), at = step(), s = lesson.steps[at], doc = form()?.doc, done = state.done[lesson.id], blocked = missing();
      $('lesson').replaceChildren(...course.lessons.map((l,i) => {const o=document.createElement('option');o.value=String(i);
        o.textContent=(finished(l.id)?'✓ ':state.done[l.id]?'… ':'')+l.title;return o;}));
      $('lesson').value=String(index); $('scenario').textContent=lesson.scenario||''; $('why').textContent=lesson.why;
      const filled = lesson.steps.filter(x => stepDone(doc, x)).length;
      $('count').textContent = finished(lesson.id) && !form() ? 'Done' : done && !form() ? 'Checked · explain it'
        : level() === 'full' ? `${filled} of ${lesson.steps.length} fields` : level() === 'goals' ? 'Situation only' : 'Challenge · no hints';
      $('steps').replaceChildren(...lesson.steps.map((x,i) => {
        const li=document.createElement('li'), b=document.createElement('button'), ok=stepDone(doc,x);
        b.textContent=(ok?'✓ ':'')+label(x.field); b.dataset.step=String(i);
        if(i===at && form())b.setAttribute('aria-current','step');
        b.onclick=()=>{focusStep=i;render();highlight(true);};
        li.append(b); return li;
      }));
      $('steps').hidden = !form() || level() !== 'full';
      const now=$('now'); now.replaceChildren();
      const say = (...parts) => now.append(...parts);
      if (blocked.length) say('Finish “' + blocked.map(id => lessonOf(id)?.title ?? id).join('”, “') + '” first: this task starts from that record.');
      else if (onSource() && level() === 'full') say(`On this ${window.cur_frm.doctype}, choose Create → ${lesson.source.action}.`);
      else if (onSource() && level() === 'goals') say(`Start from this ${window.cur_frm.doctype}. ${lesson.scenario || ''}`);
      else if (level() !== 'full' && !done) say(lesson.scenario || '', ' ', form() ? 'Save' + (docstatus()===1?' and Submit':'') + ' when you think it is right, then check your work.' : '');
      else if (!form()) say(lesson.scenario || (lesson.readOnly ? 'Open the task to look at your company record.' : 'Open the task to start a new ' + lesson.doctype + '.'));
      else if (complete() && (form().is_new() || form().is_dirty())) say('Every field matches. Save in ERPNext' + (docstatus()===1?', then Submit,':'') + ' and check your work.');
      else if (complete() && docstatus()===1 && doc.docstatus!==1) say('Every field matches. Submit it in ERPNext, then check your work.');
      else if (complete()) say(done ? 'Saved work verified.' : 'Check your saved work.');
      else {
        const strong=document.createElement('strong'); strong.textContent=label(s.field)+': '; say(strong, s.text+' ');
        if (revealed(at)) { const ex=document.createElement('span'); ex.id='example'; ex.textContent=show(s.value); say(ex); }
        else { const reveal=document.createElement('button'); reveal.className='link'; reveal.id='reveal'; reveal.textContent='Show the value';
          reveal.onclick=()=>{state.revealed[raw().id+':'+at]=true;state.assisted[raw().id]=true;save();render();}; say(reveal); }
      }
      $('open').textContent = form() ? 'Reopen task' : lesson.source && level() !== 'none' ? 'Open ' + (lessonOf(lesson.source.task)?.doctype ?? 'record') : 'Open task';
      $('open').disabled = blocked.length > 0;
      $('fill').hidden=level() !== 'full' || !!lesson.readOnly || !form() || !form().is_new() || complete(); $('fill').disabled=filling;
      const asking = predicting();
      $('predict').hidden = !asking;
      if (asking && $('predict-question').textContent !== lesson.predict.question) {
        $('predict-question').textContent = lesson.predict.question;
        $('predict-options').replaceChildren(...lesson.predict.options.map((option,i) => {
          const l=document.createElement('label'), r=document.createElement('input'); r.type='radio'; r.name='prediction'; r.value=String(i);
          r.onchange=()=>{$('lock-prediction').disabled=false;}; l.append(r,' ',option); return l; }));
        $('lock-prediction').disabled = true;
      }
      $('predict-note').textContent = done ? 'You submitted before predicting. Predict anyway, then compare with what ERPNext did.' : 'Predict before you Submit. After the check you will see what ERPNext actually did.';
      const explaining = !!done && !done.explained && !asking;
      $('explain').hidden = !explaining;
      if (explaining && $('question').textContent !== (lesson.explain || 'Explain what this record did and why.')) {
        $('question').textContent = lesson.explain || 'Explain what this record did and why.'; $('explanation').value = '';
      }
      $('send-explanation').disabled = $('explanation').value.trim().length < 30;
      const last = index===course.lessons.length-1, next = finished(lesson.id) && !form()?.is_dirty() && done.record===(activeRecord()??done.record);
      $('check').hidden = explaining || (asking && !!done);
      $('check').textContent = next ? (last?'Course complete':'Next task') : 'Check saved work';
      $('check').disabled = checking || blocked.length>0 || (next && last);
      $('progress').textContent=done?`Last checked: ${done.record} · ${done.assisted?'with example help':'without example help'}. Recheck after edits.`:'Complete the task, save it in ERPNext, then check your work.';
      showResult();
      highlight(); reserve(true);
    }
    /** After the check: the learner's prediction beside what ERPNext actually recorded. */
    function showResult() {
      const lesson=current(), p=predicted(), box=$('result');
      box.hidden = !p || !state.done[lesson.id] || !lesson.predict;
      if (box.hidden) return;
      box.className = p.choice === lesson.predict.answer ? 'right' : 'wrong'; box.replaceChildren();
      const head=document.createElement('strong');
      head.textContent = p.choice === lesson.predict.answer ? 'Your prediction was right. ' : 'Not what you predicted. ';
      box.append(head, `You predicted “${lesson.predict.options[p.choice]}”${p.early?'':' (after submitting)'}. `,
        p.choice === lesson.predict.answer ? '' : `The answer is “${lesson.predict.options[lesson.predict.answer]}”. `, p.actual ? 'ERPNext shows: ' + p.actual : '');
    }
    /** ERPNext's own record of what happened: stock in the warehouse, or the ledger entries of the saved record. */
    async function evidence(lesson, record) {
      const e=lesson.predict?.evidence; if(!e)return '';
      try {
        if(e.type==='stock') {
          const url='/api/resource/Bin?fields='+encodeURIComponent('["actual_qty"]')+'&filters='+encodeURIComponent(JSON.stringify([['item_code','=',e.item],['warehouse','=',e.warehouse]]));
          const rows=(await (await fetch(url,{credentials:'same-origin',cache:'no-store'})).json()).data||[];
          return `${Number(rows[0]?.actual_qty ?? 0)} in ${e.warehouse}.`;
        }
        const url='/api/resource/GL%20Entry?fields='+encodeURIComponent('["account","debit","credit"]')+'&filters='+encodeURIComponent(JSON.stringify([['voucher_no','=',record],['is_cancelled','=',0]]));
        const rows=(await (await fetch(url,{credentials:'same-origin',cache:'no-store'})).json()).data||[];
        return rows.length ? rows.map(r=>`${r.account} ${Number(r.debit)?'debit '+Number(r.debit):'credit '+Number(r.credit)}`).join(' · ') + '.' : 'no ledger entries.';
      } catch { return ''; }
    }
    $('lock-prediction').onclick=async()=>{
      const choice=Number(shadow.querySelector('input[name="prediction"]:checked')?.value);
      if(!Number.isInteger(choice))return;
      const lesson=current(), done=state.done[lesson.id];
      state.predictions[raw().id]={choice,early:!done};save();
      if(done) state.predictions[raw().id].actual=await evidence(lesson, done.record);
      save();setStatus(done?'':'Prediction locked in. Now Submit in ERPNext and check your work.');render();
    };
    const nextTask = () => { if(index>=course.lessons.length-1)return; index++;focusStep=undefined;revision++;save();setStatus('');render();activity('next'); };
    $('lesson').onchange=()=>{index=Number($('lesson').value);focusStep=undefined;revision++;setStatus('');save();render();activity('view');};
    $('toggle').onclick=()=>{const hidden=!$('body').hidden;$('body').hidden=hidden;$('toggle').textContent=hidden?'Show':'Hide';$('toggle').setAttribute('aria-expanded',String(!hidden));render();};
    $('explanation').oninput=()=>{$('send-explanation').disabled=$('explanation').value.trim().length<30;};
    $('send-explanation').onclick=()=>{
      const lesson=current(), done=state.done[lesson.id], text=$('explanation').value.trim();
      if(!done || text.length<30)return;
      done.explained=true;save();
      const p=predicted(), prediction=p&&lesson.predict?`${lesson.predict.question} I predicted “${lesson.predict.options[p.choice]}”${p.early?'':' after submitting'}; `
        +(p.choice===lesson.predict.answer?'that was right':`the answer was “${lesson.predict.options[lesson.predict.answer]}”`)+(p.actual?`. ERPNext shows: ${p.actual}`:''):'';
      window.dispatchEvent(new CustomEvent('dhimantai-erp-explained',{detail:{task:lesson.id,title:lesson.title,question:lesson.explain||'',text,prediction}}));
      window.dispatchEvent(new CustomEvent('dhimantai-erp-verified',{detail:{task:lesson.id,...done}}));
      setStatus(connected?'Explanation sent. Read the Instructor’s feedback, then choose Next task.':'Explanation saved. Open the course from dhimantAI to get the Instructor’s feedback.');
      render();
    };
    $('open').onclick=async()=>{
      const lesson=current();
      if(missing().length)return render();
      if(window.cur_frm?.is_dirty()) {setStatus('Save or discard your current form in ERPNext before opening another task.');return;}
      setStatus('');focusStep=undefined;
      // Reopen the learner's own master record if they created it before, instead of making a duplicate.
      const identity=['customer_name','supplier_name','item_code'].find(name=>typeof lesson.expected[name]==='string');
      let record=state.done[lesson.id]?.record || lesson.record;
      if(!record && identity) try {
        const found=await fetch('/api/resource/'+encodeURIComponent(lesson.doctype)+'?filters='+encodeURIComponent(JSON.stringify([[identity,'=',lesson.expected[identity]]])),
          {credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
        if(found.ok)record=(await found.json()).data?.[0]?.name;
        if(record)setStatus('You created this record before. It is open, so you can check or correct it.');
      } catch {}
      if(record) await frappe.set_route('Form',lesson.doctype,record);
      else if(lesson.source) await frappe.set_route('Form',lessonOf(lesson.source.task).doctype,state.done[lesson.source.task].record);
      else {
        // ERPNext's new_doc opens Quick Entry for master data. The course needs the complete form and stable field wrappers.
        await frappe.model.with_doctype(lesson.doctype);
        frappe.route_options={};
        const doc=frappe.model.get_new_doc(lesson.doctype);
        await frappe.set_route('Form',lesson.doctype,doc.name);
      }
      setTimeout(()=>{render();highlight(true);},400);
    };
    $('fill').onclick=async()=>{
      if(filling)return;
      const frm=form(), lesson=current(), at=step(), s=lesson.steps[at];
      if(!frm || lesson.readOnly) {setStatus('Open the task first.');return;}
      if(!frm.is_new()) {setStatus('Example help fills new, unsaved forms. Edit saved records yourself in ERPNext.');return;}
      const k=rowKey(s.value), existing=k?(frm.doc[s.field]||[]).filter(row=>row[k]):[];
      if(existing.length && (existing.length!==s.value.length || existing.some((row,i)=>row[k]!==s.value[i][k]))) {
        setStatus('Your table rows differ from this example. Edit them in ERPNext; example help will not replace unrelated rows.');return;
      }
      const version=revision;
      filling=true;render();setStatus('Entering the example…');
      try {
        state.assisted[lesson.id]=true;state.revealed[raw().id+':'+at]=true;save();
        if(k) {
          if(!existing.length)frm.clear_table(s.field);
          for(const [i,values] of s.value.entries()) {
            const row=existing[i]||frm.add_child(s.field);
            for(const [name,value] of Object.entries(values)) {
              if(version!==revision || form()!==frm)return;
              if(row[name]!==value)await frappe.model.set_value(row.doctype,row.name,name,value);
            }
          }
          frm.refresh_field(s.field);frm.dirty();
        } else await frm.set_value(s.field,s.value);
        if(version===revision) {focusStep=undefined;setStatus('Example entered. Read it before you save; you save and submit the record yourself.');highlight(true);}
      } catch {if(version===revision)setStatus('ERPNext could not fill this example. Check the earlier tasks are done and enter the field yourself.');}
      finally{filling=false;render();}
    };
    const read = async (doctype, name) => {
      const result=await fetch('/api/resource/'+encodeURIComponent(doctype)+'/'+encodeURIComponent(name),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!result.ok)throw new Error('read failed');
      return (await result.json()).data;
    };
    async function checkSaved() {
      if(checking)return false;
      const lesson=current(), record=activeRecord(), version=revision;
      if(!record) {setStatus(form()?'Save your changes in ERPNext first, then check.':'Open this task and save it in ERPNext first.');activity('check','not_saved');return false;}
      checking=true;render();setStatus('Checking the saved ERPNext record…');
      try {
        const doc=await read(lesson.doctype, record);
        if(version!==revision || record!==activeRecord())return false;
        if(!equal(doc,lesson.expected)) {
          delete state.done[lesson.id];save();
          const wrong=lesson.steps.filter(s=>!stepDone(doc,s)).map(s=>label(s.field));
          if(level()==='none' && wrong.length) {
            setStatus(`Your record does not meet the brief yet (${wrong.length} ${wrong.length===1?'difference':'differences'}). Re-read the situation and compare it with your record.`);
            const more=document.createElement('button');more.className='link';more.textContent='Show what differs';
            more.onclick=()=>{state.assisted[raw().id]=true;save();setStatus('The saved record differs in: '+wrong.join(', ')+'.');};
            statusEl.append(' ',more);activity('check','mismatch');return false;
          }
          setStatus(wrong.length?'The saved record differs in: '+wrong.join(', ')+'.'
            :lesson.expected.docstatus===1&&doc.docstatus!==1?'The values match. Submit the record in ERPNext, then check again.'
            :lesson.expected.docstatus===0&&doc.docstatus!==0?'This task expects a draft. Create a new one and save it without submitting.'
            :'The saved record does not match yet. Check the company and table rows.');
          activity('check','mismatch');return false;
        }
        // A transaction also changes the records it settles or fulfils; confirm that consequence too.
        for(const extra of lesson.also||[]) {
          const linked=await read(extra.doctype, extra.record);
          if(version!==revision)return false;
          if(!equal(linked,extra.expected)) {setStatus('Your record matches, but this is not true yet: '+extra.text+' Check the amounts and links, then check again.');activity('check','mismatch');return false;}
        }
        state.done[lesson.id]={record,checkedAt:new Date().toISOString(),assisted:!!state.assisted[lesson.id],explained:false};save();
        if(predicted() && !predicted().actual){predicted().actual=await evidence(lesson, record);save();}
        const consequences=(lesson.also||[]).map(extra=>' '+extra.text).join('');
        setStatus('Saved work verified.'+consequences+(lesson.predict && !predicted()?' Before explaining, make your prediction below.':' Now explain your decision below.'));
        activity('check','matched');render();$('explanation').focus?.();return true;
      } catch {if(version===revision)setStatus('Could not verify the saved record. Check your ERPNext login and retry. Nothing was marked complete.');return false;}
      finally{checking=false;render();}
    }
    $('check').onclick=()=>{ if($('check').textContent==='Next task')nextTask(); else void checkSaved(); };
    window.dhimantaiErpGuide={user,tag,current,step,complete,root:shadow,status:()=>status.textContent,live:$('live')};
    window.addEventListener('scroll',()=>highlight(),true);window.addEventListener('resize',()=>{highlight();reserve(true);});
    // Re-read the form after typing, SPA navigation and asynchronous rendering; never retain a stale element.
    setInterval(()=>{
      if(document.hidden)return;
      const doc=form()?.doc, signature=JSON.stringify([index,!!form(),onSource(),!!predicted(),form()?.is_dirty?.(),doc?.name,doc?.docstatus,current().steps.map(s=>stepDone(doc,s))]);
      if(signature!==lastSignature){lastSignature=signature;render();} else {highlight();reserve();}
    },700);
    render();
  }
  boot().catch(()=>{});
})();
