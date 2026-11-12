/* App-neutral task player. Every application call goes through window.dhimantaiApp (see media/browser/apps). */
(() => {
  'use strict';
  const equal = (actual, expected) => {
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v,i) => equal(actual[i],v));
    if (expected && typeof expected === 'object') return !!actual && Object.entries(expected).every(([k,v]) => equal(actual[k],v));
    return typeof expected === 'number' ? Number(actual) === expected && actual !== '' && actual != null : actual === expected;
  };
  /** A table row is identified by its first authored key (item_code, reference_doctype…). */
  const rowKey = expected => Array.isArray(expected) && expected[0] && typeof expected[0] === 'object' ? Object.keys(expected[0])[0] : undefined;
  /** Rows an application adds empty (no item yet) are not the learner's work. */
  const rows = (value, expected) => { const k=rowKey(expected); return k && Array.isArray(value) ? value.filter(row => row && row[k]) : value; };
  const stepDone = (doc, s) => !!doc && equal(rows(doc[s.field], s.value), s.value);
  /** Earlier tasks a task depends on: records it links to, and the record it is created from. */
  const dependencies = lesson => [...new Set([...JSON.stringify(lesson).matchAll(/\{\{ref:([a-z0-9-]+)\}\}/g)].map(m => m[1]).concat(lesson.source ? [lesson.source.task] : []))];
  // A pure export keeps the desktop verifier and tests on the same predicates the page uses.
  if (typeof module !== 'undefined') { module.exports = {equal, stepDone, dependencies}; return; }
  // Injected by the desktop and bundled in an image at the same time: run once.
  if (window.__dhimantaiPlayer) return;
  window.__dhimantaiPlayer = true;
  async function boot() {
    const app = window.dhimantaiApp;
    if (!app?.ready()) return setTimeout(boot,500);
    const user = app.user(), match = /^learner-([a-f0-9]{20})@training\.invalid$/.exec(user);
    const requested=new URLSearchParams(location.search).get('dhimantai-user') || sessionStorage.getItem('dhimantai-erpnext-learner');
    if(requested && /^[a-f0-9]{20}$/.test(requested)) {
      if(user!==`learner-${requested}@training.invalid`) {
        // The launch page (or the desktop) signs the requested learner in again.
        if(await app.logout())location.replace(app.launchPath || '/');
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
      : app.courseAsset ? await fetch(app.courseAsset) : {ok:false};
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
    const today = app.today?.() || new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
    const product = app.title || 'the application';
    const resolve = value => JSON.parse(JSON.stringify(value).replaceAll('{{today}}',today)
      .replace(/\{\{ref:([a-z0-9-]+)\}\}/g,(_,id)=>JSON.stringify(state.done[id]?.record ?? '').slice(1,-1)));
    const firstOpen = Math.max(0, course.lessons.findIndex(l => !finished(l.id)));
    let index = Number.isInteger(state.lesson) ? Math.max(0,Math.min(course.lessons.length - 1,state.lesson)) : firstOpen;
    let revision = 0, checking = false, filling = false, advancing = false, focusStep, lastSignature = '';
    const status = {textContent:''};
    const save = () => { state.lesson = index; try { localStorage.setItem(key,JSON.stringify(state)); } catch { setStatus(`Browser storage is unavailable. Your ${product} records are still saved.`); } };
    const host = document.createElement('aside'); host.id = 'dhimantai-guide';
    const shadow = host.attachShadow({mode:'open'});
    // Colours come from the application's theme variables when it has them (Frappe names), with neutral fallbacks.
    shadow.innerHTML = `<style>
      :host{position:fixed;left:0;right:0;bottom:0;z-index:10020;font:13px/1.45 var(--font-stack,system-ui);color:var(--text-color,#171717)}
      :host([data-closed="true"]){left:auto;right:16px;bottom:12px}
      *{box-sizing:border-box}
      section{background:var(--fg-color,#fff);border-top:1px solid var(--border-color,#ededed);box-shadow:0 -4px 16px rgba(0,0,0,.08);padding:8px 16px;max-height:45vh;overflow:auto}
      .row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
      .brand{font-weight:600;white-space:nowrap}#count{color:var(--text-muted,#525252);font-size:12px}
      #show-task{border-radius:999px;padding:7px 14px;background:var(--fg-color,#fff);box-shadow:0 2px 12px #0002}
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
      a{color:inherit}#live:empty{display:none}#live{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
      #trail{margin:6px 0 0;color:var(--text-muted,#525252)}#trail button.link{color:var(--text-color,#171717)}#trail .here{font-weight:600;color:var(--text-color,#171717)}
      .ledger{margin:8px 0 0;padding:8px 10px;border:1px solid var(--border-color,#ededed);border-radius:var(--border-radius,6px)}
      .ledger h3{font-size:inherit;font-weight:600;margin:0 0 4px}.ledger p{margin:4px 0}.ledger small{color:var(--text-muted,#525252)}
      table{border-collapse:collapse;margin:2px 0;min-width:min(100%,420px)}th,td{padding:2px 12px 2px 0;text-align:left;font-variant-numeric:tabular-nums}
      th{font-weight:600;color:var(--text-muted,#525252)}td.n,th.n{text-align:right}tfoot td{border-top:1px solid var(--border-color,#ededed);font-weight:600}
      .cols{display:flex;flex-wrap:wrap;gap:4px 32px}.ok{color:var(--green-600,#2b8a3e)}
      #finale{border-color:var(--green-500,#2f9e44)}#finale textarea{width:100%;min-height:56px;padding:6px 8px;border:1px solid var(--border-color,#ededed);background:var(--control-bg,#f3f3f3);resize:vertical}
      #books>div{margin-top:4px}
      [hidden]{display:none!important}
    </style><button id="show-task" hidden aria-controls="task-panel">Show task</button><section id="task-panel" aria-label="dhimantAI task"><div class="row"><span class="brand">Current task</span>
      <select id="lesson" aria-label="Course task"></select>
      <span id="count"></span>
      <span class="actions"><button id="toggle" title="Close this panel; your saved progress stays here" aria-controls="task-panel">Close panel ×</button></span></div>
      <div id="body"><p id="now"></p><p id="trail" hidden></p><details id="field-details"><summary>Fields to check</summary><ol id="steps" aria-label="Fields in this task"></ol></details>
      <p id="status" role="status" aria-live="polite"></p>
      <div class="row" style="margin-top:8px"><button id="open" class="primary">Open task</button><button id="check" class="primary">Check saved work</button><button id="fill">Fill this field</button><div id="live"></div></div>
      <fieldset id="predict" hidden><legend id="predict-question"></legend><div id="predict-options"></div>
        <div class="row"><button id="lock-prediction" class="primary" disabled>Lock in my prediction</button><small id="predict-note"></small></div></fieldset>
      <p id="result" hidden></p>
      <div id="posted" class="ledger" hidden></div>
      <div id="finale" class="ledger" hidden><h3 id="finale-title"></h3><div id="finale-books"></div>
        <div class="row" id="reports"></div>
        <div hidden><label for="reflection" id="reflection-question"></label><textarea id="reflection" maxlength="800"></textarea>
        <div class="row"><button id="send-reflection" class="primary" disabled>Send to the Instructor</button><small id="reflection-note"></small></div></div></div>
      <div id="explain" hidden><label for="explanation" id="question"></label><textarea id="explanation" maxlength="500" placeholder="Answer in your own words, using your own records."></textarea>
        <div class="row"><button id="send-explanation" class="primary" disabled>Send my explanation</button><small>The Instructor checks your reasoning. The task counts as done once you have explained it.</small></div></div>
      <details id="books"><summary>Your company’s books</summary><div id="books-body"></div></details>
      <details><summary>About this task</summary><p id="scenario"></p><p id="why"></p><p id="progress"></p><p>Checks confirm your saved records in the application; they are practice evidence, not a grade. <a id="reference" target="_blank" rel="noopener" hidden>Reference</a></p><div id="connection-options"></div></details>
    </div></section>`;
    document.body.append(host);
    const $ = id => shadow.getElementById(id), statusEl = $('status');
    const setStatus = text => { status.textContent = text; statusEl.textContent = text; };
    // Keep every field above the bar. Apps scroll inside their own containers (Frappe div.main-section, Odoo .o_content),
    // not the body, so reserve the bar's height in whichever scrolling containers reach under it.
    const reserved = new Map();
    let scrollers = [];
    const reserve = (scan = false) => {
      const height = Math.ceil(host.getBoundingClientRect().height), top = innerHeight - height;
      if (scan || !scrollers.length) {
        scrollers = [document.scrollingElement || document.documentElement, ...document.querySelectorAll('.main-section, .layout-main, .page-container, .modal-body, .o_content, .o_action_manager')];
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
    const formOf = lesson => lesson?.form || lesson?.doctype;
    const company = 'Training ' + tag;
    const el = (name, props={}, ...children) => { const e=document.createElement(name); Object.assign(e,props); e.append(...children); return e; };
    const money = n => (Math.round(n*100)/100).toLocaleString('en-IN',{maximumFractionDigits:2});
    /** Account names end with the company abbreviation (" - 1e5e7ec0de"); learners read the account itself. */
    const short = account => String(account).replace(/ - [^-]+$/,'');
    const note = account => app.accountNotes?.[short(account)];
    /** The open form when it is this task's form: {form, id, isNew, dirty, final, values}. */
    const form = () => { const open = app.current(); return open && open.form === formOf(current()) ? open : undefined; };
    /** On the earlier record this task is created from, before using its Create menu. */
    const onSource = () => { const src=current().source, open=app.current(); return !!src && !form() && open?.form===formOf(lessonOf(src.task)) && open?.id===state.done[src.task]?.record; };
    /** The step follows the learner's form: the first field that does not yet hold the task's value. */
    const step = () => {
      const lesson = current(), doc = form()?.values;
      if (Number.isInteger(focusStep) && focusStep < lesson.steps.length && !stepDone(doc, lesson.steps[focusStep])) return focusStep;
      const open = lesson.steps.findIndex(s => !stepDone(doc, s));
      return open < 0 ? lesson.steps.length - 1 : open;
    };
    const complete = () => { const doc=form()?.values; return !!doc && current().steps.every(s => stepDone(doc, s)); };
    const activeRecord = () => form() && !form().isNew && !form().dirty ? form().id : undefined;
    const label = name => (form() && app.label(name)) || name.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
    const labels={item_code:'Item',qty:'Qty',rate:'Rate (INR)',basic_rate:'Basic rate (INR)',schedule_date:'Required by',delivery_date:'Delivery date',
      t_warehouse:'Target warehouse',warehouse:'Warehouse',purchase_order:'Purchase order',purchase_receipt:'Purchase receipt',against_sales_order:'Sales order',
      delivery_note:'Delivery note',reference_doctype:'Type',reference_name:'Name',allocated_amount:'Allocated (INR)'};
    const show = value => Array.isArray(value) ? value.map(row=>Object.entries(row).map(([k,v])=>(labels[k]||k)+' '+v).join(' · ')).join('; ') : String(value);
    const revealed = at => !raw().steps[at]?.decide || !!state.revealed[raw().id+':'+at];
    /** Whether the task ends with a final action (Frappe Submit, Odoo Confirm/Post), and its name. */
    const needsFinal = () => current().final ?? current().expected.docstatus === 1;
    const finalAction = () => current().finalAction || 'Submit';
    /** full: field-by-field help; goals: the situation only; none: an independent challenge. */
    const level = () => raw().guidance || 'full';
    const predicted = () => state.predictions[raw().id];
    /** Prediction is still open: the task has one, it is unanswered, and either the record is not submitted yet or the check passed without one. */
    const predicting = () => !!current().predict && !predicted() && (!!state.done[raw().id] || !!form() && !form().final);
    function highlight(scroll=false) {
      if (level() !== 'full') { outline.style.display='none'; return; }
      const s=current().steps[step()];
      if(scroll && form())app.scrollTo(s?.field);
      const element = form() && s ? app.element(s.field) : undefined, rect = element?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height || $('body').hidden) { outline.style.display='none'; return; }
      if (scroll) element.scrollIntoView({behavior:'smooth',block:'center'});
      Object.assign(outline.style,{display:'block',left:rect.left-3+'px',top:rect.top-3+'px',width:rect.width+6+'px',height:rect.height+6+'px'});
    }
    function render() {
      const lesson = current(), at = step(), s = lesson.steps[at], doc = form()?.values, done = state.done[lesson.id], blocked = missing();
      $('lesson').replaceChildren(...course.lessons.map((l,i) => {const o=document.createElement('option');o.value=String(i);
        o.textContent=(finished(l.id)?'✓ ':state.done[l.id]?'… ':'')+l.title;return o;}));
      $('lesson').value=String(index); $('scenario').textContent=lesson.scenario||''; $('why').textContent=lesson.why;
      const filled = lesson.steps.filter(x => stepDone(doc, x)).length;
      $('count').textContent = `Task ${index+1} of ${course.lessons.length}`;
      $('field-details').querySelector('summary').textContent=`Fields to check · ${filled} of ${lesson.steps.length} match`;
      $('steps').replaceChildren(...lesson.steps.map((x,i) => {
        const li=document.createElement('li'), b=document.createElement('button'), ok=stepDone(doc,x);
        b.textContent=(ok?'✓ ':'')+label(x.field); b.dataset.step=String(i);
        if(i===at && form())b.setAttribute('aria-current','step');
        b.onclick=()=>{focusStep=i;render();highlight(true);};
        li.append(b); return li;
      }));
      $('steps').hidden = !form() || level() !== 'full';
      $('field-details').hidden = $('steps').hidden;
      const now=$('now'); now.replaceChildren();
      const say = (...parts) => now.append(...parts);
      if (blocked.length) say('Finish “' + blocked.map(id => lessonOf(id)?.title ?? id).join('”, “') + '” first: this task starts from that record.');
      else if (onSource() && level() === 'full') say(lesson.source.hint || `On this ${app.current().form}, choose Create → ${lesson.source.action}.`);
      else if (onSource() && level() === 'goals') say(`Start from this ${app.current().form}. ${lesson.scenario || ''}`);
      else if (level() !== 'full' && !done) say(lesson.scenario || '', ' ', form() ? 'Save' + (needsFinal()?' and '+finalAction():'') + ' when you think it is right, then check your work.' : '');
      else if (!form()) say(lesson.scenario || (lesson.readOnly ? 'Open the task to look at the record.' : 'Open the task to start a new ' + formOf(lesson) + '.'));
      else if (complete() && (form().isNew || form().dirty)) say(`Every field matches. Save in ${product}` + (needsFinal()?', then '+finalAction()+',':'') + ' and check your work.');
      else if (complete() && needsFinal() && !form().final) say(`Every field matches. ${finalAction()} it in ${product}, then check your work.`);
      else if (complete()) say(done ? 'Saved work verified.' : 'Check your saved work.');
      else {
        const strong=document.createElement('strong'); strong.textContent=label(s.field)+': '; say(strong, s.text+' ');
        if (revealed(at)) { const ex=document.createElement('span'); ex.id='example'; ex.textContent=show(s.value); say(ex); }
        else { const reveal=document.createElement('button'); reveal.className='link'; reveal.id='reveal'; reveal.textContent='Show the value';
          reveal.onclick=()=>{state.revealed[raw().id+':'+at]=true;state.assisted[raw().id]=true;save();render();}; say(reveal); }
      }
      $('open').textContent = lesson.source && level() !== 'none' ? 'Open ' + (formOf(lessonOf(lesson.source.task)) ?? 'record') : 'Open task';
      $('open').disabled = blocked.length > 0;
      $('fill').hidden=level() !== 'full' || !!lesson.readOnly || !form() || !form().isNew || complete(); $('fill').disabled=filling;
      const asking = predicting();
      // Questions are presented by the Instructor notebook. These detached-from-view
      // controls retain the course's existing answer and progress rules.
      $('predict').hidden = true;
      if (asking && $('predict-question').textContent !== lesson.predict.question) {
        $('predict-question').textContent = lesson.predict.question;
        $('predict-options').replaceChildren(...lesson.predict.options.map((option,i) => {
          const l=document.createElement('label'), r=document.createElement('input'); r.type='radio'; r.name='prediction'; r.value=String(i);
          r.onchange=()=>{$('lock-prediction').disabled=false;}; l.append(r,' ',option); return l; }));
        $('lock-prediction').disabled = true;
      }
      $('predict-note').textContent = done ? `You finished before predicting. Predict anyway, then compare with what ${product} did.` : `Predict before you ${finalAction()}. After the check you will see what ${product} actually did.`;
      const explaining = !!done && !done.explained && !asking;
      $('explain').hidden = true;
      if (explaining && $('question').textContent !== (lesson.explain || 'Explain what this record did and why.')) {
        $('question').textContent = lesson.explain || 'Explain what this record did and why.'; $('explanation').value = '';
      }
      $('send-explanation').disabled = $('explanation').value.trim().length < 30;
      const last = index===course.lessons.length-1, next = finished(lesson.id) && !form()?.dirty && done.record===(activeRecord()??done.record);
      $('progress').textContent=done?`Last checked: ${done.record} · ${done.assisted?'with example help':'without example help'}. Recheck after edits.`:`Complete the task, save it in ${product}, then check your work.`;
      if (course.reference) { $('reference').href = course.reference; $('reference').hidden = false; }
      showResult(); showFinale(); if(app.postings)showPosted(); if(!$('finale').hidden)$('posted').hidden=true; showTrail();
      const pendingQuestion=question();
      if(pendingQuestion && pendingQuestion.kind!=='prediction') {
        now.replaceChildren(pendingQuestion.kind==='reflection'?'One last step: reflect on your results in Instructor.':'Next: explain your decision in Instructor.');
      } else if(pendingQuestion) say(' Before checking, make your prediction in Instructor.');
      else if(next) now.replaceChildren(last?'All course tasks are complete. You can review your work any time.':'Task complete. Open the next task when you are ready.');
      now.hidden=false;
      $('open').hidden=!!form() || onSource() || !!pendingQuestion || next;
      $('check').hidden=!pendingQuestion && !next && !form();
      $('check').textContent=advancing?'Opening next task…':checking?'Checking…':pendingQuestion?'Answer in Instructor':next?(last?'Course complete':'Next task'):'Check saved work';
      $('check').disabled=checking || advancing || blocked.length>0 || (!pendingQuestion && next && last);
      highlight(); reserve(true);
    }
    /** After the check: the learner's prediction beside what the application actually recorded. */
    function showResult() {
      const lesson=current(), p=predicted(), box=$('result');
      box.hidden = !p || !state.done[lesson.id] || !lesson.predict;
      if (box.hidden) return;
      box.className = p.choice === lesson.predict.answer ? 'right' : 'wrong'; box.replaceChildren();
      const head=document.createElement('strong');
      head.textContent = p.choice === lesson.predict.answer ? 'Your prediction was right. ' : 'Not what you predicted. ';
      box.append(head, `You predicted “${lesson.predict.options[p.choice]}”${p.early?'':' (after submitting)'}. `,
        p.choice === lesson.predict.answer ? '' : `The answer is “${lesson.predict.options[lesson.predict.answer]}”. `, p.actual ? product + ' shows: ' + p.actual : '');
    }
    // What the application itself recorded: read once per record, shown after the learner has predicted.
    const posted = {};
    const postingsOf = (lesson, record) => {
      const key = formOf(lesson)+':'+record;
      if (!(key in posted)) { posted[key]=null; app.postings(formOf(lesson), record).then(v=>{posted[key]=v;}, ()=>{posted[key]=false;}).finally(()=>render()); }
      return posted[key];
    };
    /** One line per posting, for the Instructor to check the learner's reasoning against. */
    const postedText = p => !p ? '' : [...p.ledger.map(r=>`${short(r.account)} ${r.debit?'debit '+money(r.debit):'credit '+money(r.credit)}`),
      ...p.stock.map(r=>`stock ${r.item} in ${short(r.warehouse)} ${r.change>0?'+':''}${r.change} (now ${r.balance})`)].join('; ') || 'nothing posted';
    function ledgerTable(rows) {
      const debit=rows.reduce((t,r)=>t+r.debit,0), credit=rows.reduce((t,r)=>t+r.credit,0);
      const tr=(...cells)=>el('tr',{},...cells);
      return el('table',{},el('thead',{},tr(el('th',{},'Account'),el('th',{className:'n'},'Debit'),el('th',{className:'n'},'Credit'))),
        el('tbody',{},...rows.map(r=>tr(el('td',{},short(r.account)),el('td',{className:'n'},r.debit?money(r.debit):''),el('td',{className:'n'},r.credit?money(r.credit):'')))),
        el('tfoot',{},tr(el('td',{},Math.abs(debit-credit)<.005?'Total · balanced':'Total'),el('td',{className:'n'},money(debit)),el('td',{className:'n'},money(credit)))));
    }
    /** After a submitted task: the general ledger and stock ledger entries this very document created. */
    function showPosted() {
      const lesson=current(), done=state.done[lesson.id], box=$('posted');
      const wanted=!!done && !!app.postings && needsFinal() && !lesson.readOnly && !predicting();
      if(!wanted){box.hidden=true;return;}
      const p=postingsOf(lesson, done.record), key=done.record+':'+JSON.stringify(p);
      box.hidden=p===false;
      if(box.dataset.key===key)return;
      box.dataset.key=key;
      if(!p){box.replaceChildren(`Reading what ${product} recorded for ${done.record}…`);return;}
      const parts=[el('h3',{},`What ${product} recorded for ${done.record}`)];
      if(p.ledger.length) parts.push(ledgerTable(p.ledger));
      for(const r of p.stock) parts.push(el('p',{},`Stock: ${r.item} in ${short(r.warehouse)} ${r.change>0?'+':''}${r.change}, now ${r.balance}`
        +(r.value?` (stock value ${r.value>0?'+':''}${money(r.value)})`:'')+'.'));
      if(!p.ledger.length && !p.stock.length) parts.push(el('p',{},`Nothing was posted: no stock moved and no account changed. A submitted ${formOf(lesson)} is a commitment; the documents created from it record the effects.`));
      const seen=new Set();
      for(const r of p.ledger){const n=note(r.account);if(n&&!seen.has(n)){seen.add(n);parts.push(el('p',{},el('small',{},short(r.account)+': '+n)));}}
      box.replaceChildren(...parts);
    }
    /** The chain of the learner's own documents this task continues (order → delivery → invoice → payment). */
    function showTrail() {
      const lesson=raw(), chain=[], box=$('trail');
      for(let l=lesson; l?.source;){const from=lessonOf(l.source.task); if(!from||chain.includes(from))break; chain.unshift(from); l=from;}
      box.hidden=!chain.length || (level()==='none' && !state.done[lesson.id]);
      if(box.hidden)return;
      const done=state.done[lesson.id], parts=['Document flow: '];
      for(const l of chain){
        const record=state.done[l.id]?.record;
        parts.push(record?el('button',{className:'link',title:'Open '+record,onclick:()=>{if(app.current()?.dirty){setStatus(`Save or discard your current form in ${product} first.`);return;}void app.openRecord(formOf(l),record);}},`${formOf(l)} ${record}`):`${formOf(l)} (not done)`,' → ');
      }
      parts.push(el('span',{className:'here'},formOf(lesson)+(done?' '+done.record:' (this task)')));
      const key=JSON.stringify(parts.map(x=>x.textContent??x));
      if(box.dataset.key!==key){box.dataset.key=key;box.replaceChildren(...parts);}
    }
    /** A small statement from the general ledger: profit and loss, position, the balance check, and cash versus profit. */
    function booksView(lines) {
      const sum=kind=>lines.filter(l=>l.kind===kind).reduce((t,l)=>t+l.balance,0);
      const income=sum('income'), expense=sum('expense'), profit=income-expense;
      const assets=sum('asset'), liabilities=sum('liability'), equity=sum('equity');
      const list=(kind,title)=>{const rows=lines.filter(l=>l.kind===kind);return el('table',{},el('thead',{},el('tr',{},el('th',{},title),el('th',{className:'n'},'INR'))),
        el('tbody',{},...(rows.length?rows:[{account:'None',balance:0}]).map(l=>el('tr',{},el('td',{},short(l.account)),el('td',{className:'n'},money(l.balance))))));};
      const balanced=Math.abs(assets-(liabilities+equity+profit))<.01;
      const cash=lines.filter(l=>l.kind==='asset'&&/cash|bank/i.test(short(l.account))).reduce((t,l)=>t+l.balance,0);
      const gap=lines.filter(l=>(l.kind==='asset'&&!/cash|bank/i.test(short(l.account)))||l.kind==='liability').filter(l=>Math.abs(l.balance)>.004);
      return [el('div',{className:'cols'},list('income','Income'),list('expense','Expenses'),list('asset','Assets'),list('liability','Liabilities')),
        el('p',{},el('strong',{},`Profit: INR ${money(profit)}`),` = income ${money(income)} − expenses ${money(expense)}. `),
        el('p',{className:balanced?'ok':''},balanced?`The books balance: assets ${money(assets)} = liabilities ${money(liabilities)} + equity ${money(equity)} + profit ${money(profit)}.`
          :`Assets ${money(assets)} and liabilities ${money(liabilities)} + equity ${money(equity)} + profit ${money(profit)} differ: earlier balances exist in this company.`),
        el('p',{},gap.length?`Cash is INR ${money(cash)} while profit is INR ${money(profit)}. The difference sits in `+gap.map(l=>`${short(l.account)} (${money(l.balance)})`).join(', ')+'.'
          :`Cash is INR ${money(cash)} and profit is INR ${money(profit)}: every bill is paid, every invoice collected and no stock is left, so the profit is all in cash.`)];
    }
    let books, booksAt=0;
    async function loadBooks(force=false) {
      if(!app.books || (!force && books && Date.now()-booksAt<5000))return books;
      try{books=await app.books(company);booksAt=Date.now();}catch{books=false;}
      return books;
    }
    async function showBooks(target) {
      target.replaceChildren(`Reading ${company}’s general ledger…`);
      const lines=await loadBooks(true);
      target.replaceChildren(...(lines?booksView(lines):[`${product} did not return the ledger. Try again after your next check.`]));
    }
    $('books').hidden=!app.books;
    $('books').ontoggle=()=>{if($('books').open)void showBooks($('books-body'));};
    /** Course complete: read the company's own books, then explain them to the owner. */
    function showFinale() {
      const all=course.lessons.every(l=>finished(l.id)), box=$('finale');
      box.hidden=!all || !app.books || index!==course.lessons.length-1;
      if(box.hidden||box.dataset.shown)return;
      box.dataset.shown='1';
      $('finale-title').textContent=typeof course.finale==='string'&&course.finale?course.finale:`You ran ${company} end to end: bought, received, paid, sold, delivered, billed and collected. Here are the books you wrote.`;
      void showBooks($('finale-books'));
      $('reports').replaceChildren(...(app.reports||[]).map(r=>el('button',{onclick:()=>{void r.open(company);}},'Open '+r.label+` in ${product}`)));
      $('reflection-question').textContent=`Explain to the owner of ${company} where the profit came from, and why the cash is what it is.`;
      $('reflection-note').textContent=state.closing?'Sent. You can send a better version any time.':'The Instructor checks your story against these numbers.';
    }
    $('reflection').oninput=()=>{$('send-reflection').disabled=$('reflection').value.trim().length<40;};
    $('send-reflection').onclick=async()=>{
      const text=$('reflection').value.trim(); if(text.length<40)return;
      const lines=await loadBooks();
      const recorded=lines?lines.map(l=>`${short(l.account)} (${l.kind}) ${money(l.balance)}`).join('; '):'';
      state.closing=true;save();
      window.dispatchEvent(new CustomEvent('dhimantai-erp-explained',{detail:{task:'close-the-books',title:'Close the books',question:$('reflection-question').textContent,text,prediction:'',recorded,fromInstructor:applyingInstructorAnswer}}));
      $('reflection-note').textContent='Sent. Read the Instructor’s feedback in the left pane.';
    };
    /** The application's own record of what happened (stock, ledger…), read by its adapter. */
    async function evidence(lesson, record) {
      const e=lesson.predict?.evidence; if(!e || !app.evidence)return '';
      try { return await app.evidence(e, record); } catch { return ''; }
    }
    const lockPrediction=async()=>{
      const choice=Number(shadow.querySelector('input[name="prediction"]:checked')?.value);
      if(!Number.isInteger(choice))return;
      const lesson=current(), done=state.done[lesson.id];
      state.predictions[raw().id]={choice,early:!done};save();
      if(done) state.predictions[raw().id].actual=await evidence(lesson, done.record);
      save();setStatus(done?'':`Prediction locked in. Now ${finalAction()} in ${product} and check your work.`);render();
    };
    $('lock-prediction').onclick=lockPrediction;
    const nextTask = () => { if(index>=course.lessons.length-1)return; index++;focusStep=undefined;revision++;save();setStatus('');render();activity('next'); };
    $('lesson').onchange=()=>{index=Number($('lesson').value);focusStep=undefined;revision++;setStatus('');save();render();activity('view');};
    function setPanelClosed(closed) {
      state.panelClosed=closed;host.dataset.closed=String(closed);
      $('task-panel').hidden=closed;$('body').hidden=closed;$('show-task').hidden=!closed;
      save();render();
    }
    $('toggle').onclick=()=>setPanelClosed(true);
    $('show-task').onclick=()=>setPanelClosed(false);
    $('explanation').oninput=()=>{$('send-explanation').disabled=$('explanation').value.trim().length<30;};
    $('send-explanation').onclick=()=>{
      const lesson=current(), done=state.done[lesson.id], text=$('explanation').value.trim();
      if(!done || text.length<30)return;
      done.explained=true;save();
      const p=predicted(), prediction=p&&lesson.predict?`${lesson.predict.question} I predicted “${lesson.predict.options[p.choice]}”${p.early?'':' after submitting'}; `
        +(p.choice===lesson.predict.answer?'that was right':`the answer was “${lesson.predict.options[lesson.predict.answer]}”`)+(p.actual?`. ${product} shows: ${p.actual}`:''):'';
      const recorded=app.postings&&needsFinal()?postedText(posted[formOf(lesson)+':'+done.record]):'';
      window.dispatchEvent(new CustomEvent('dhimantai-erp-explained',{detail:{task:lesson.id,title:lesson.title,question:lesson.explain||'',text,prediction,recorded,fromInstructor:applyingInstructorAnswer}}));
      window.dispatchEvent(new CustomEvent('dhimantai-erp-verified',{detail:{task:lesson.id,...done}}));
      setStatus(connected?'Explanation sent. Your feedback is in Instructor.':'Explanation saved. Open the course from dhimantAI to get the Instructor’s feedback.');
      render();
    };
    $('open').onclick=async()=>{
      const lesson=current();
      if(missing().length)return render();
      if(app.current()?.dirty) {setStatus(`Save or discard your current form in ${product} before opening another task.`);return;}
      setStatus('');focusStep=undefined;
      // Reopen the learner's own master record if they created it before, instead of making a duplicate.
      const identity=lesson.identity || ['customer_name','supplier_name','item_code'].find(name=>typeof lesson.expected[name]==='string');
      let record=state.done[lesson.id]?.record || lesson.record;
      if(!record && identity && typeof lesson.expected[identity]==='string') try {
        record=await app.find(formOf(lesson),identity,lesson.expected[identity]);
        if(record)setStatus('You created this record before. It is open, so you can check or correct it.');
      } catch {}
      if(record) await app.openRecord(formOf(lesson),record);
      else if(lesson.source) await app.openRecord(formOf(lessonOf(lesson.source.task)),state.done[lesson.source.task].record);
      else await app.openNew(formOf(lesson));
      setTimeout(()=>{render();highlight(true);},400);
    };
    $('fill').onclick=async()=>{
      if(filling)return;
      const frm=form(), lesson=current(), at=step(), s=lesson.steps[at];
      if(!frm || lesson.readOnly) {setStatus('Open the task first.');return;}
      if(!frm.isNew) {setStatus(`Example help fills new, unsaved forms. Edit saved records yourself in ${product}.`);return;}
      const k=rowKey(s.value), existing=k?(frm.values[s.field]||[]).filter(row=>row[k]):[];
      if(existing.length && (existing.length!==s.value.length || existing.some((row,i)=>row[k]!==s.value[i][k]))) {
        setStatus(`Your table rows differ from this example. Edit them in ${product}; example help will not replace unrelated rows.`);return;
      }
      const version=revision;
      filling=true;render();setStatus('Entering the example…');
      try {
        state.assisted[lesson.id]=true;state.revealed[raw().id+':'+at]=true;save();
        await app.setValue(s.field,s.value);
        if(version!==revision)return;
        if(version===revision) {focusStep=undefined;setStatus('Example entered. Read it before you save; you save and submit the record yourself.');highlight(true);}
      } catch {if(version===revision)setStatus(`${product} could not fill this example. Check the earlier tasks are done and enter the field yourself.`);}
      finally{filling=false;render();}
    };
    /** The fields an expected record compares; checks read only those. */
    const fieldsFor = expected => Object.fromEntries(Object.entries(expected).map(([k,v]) => [k, Array.isArray(v) ? [...new Set(v.flatMap(r => r && typeof r === 'object' ? Object.keys(r) : []))] : true]));
    const read = async (form, id, expected) => { const doc = await app.read(form, id, fieldsFor(expected)); if(!doc)throw new Error('read failed'); return doc; };
    async function checkSaved() {
      if(checking)return false;
      const lesson=current(), record=activeRecord(), version=revision;
      if(!record) {setStatus(form()?`Save your changes in ${product} first, then check.`:`Open this task and save it in ${product} first.`);activity('check','not_saved');return false;}
      checking=true;render();setStatus(`Checking the saved ${product} record…`);
      try {
        const doc=await read(formOf(lesson), record, lesson.expected);
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
            :needsFinal()&&!app.isFinal(doc)?`The values match. ${finalAction()} the record in ${product}, then check again.`
            :!needsFinal()&&app.isFinal(doc)?'This task expects a draft. Create a new one and save it without finalizing it.'
            :'The saved record does not match yet. Check the company and table rows.');
          activity('check','mismatch');return false;
        }
        // A transaction also changes the records it settles or fulfils; confirm that consequence too.
        for(const extra of lesson.also||[]) {
          const linked=await read(extra.form||extra.doctype, extra.record, extra.expected);
          if(version!==revision)return false;
          if(!equal(linked,extra.expected)) {setStatus('Your record matches, but this is not true yet: '+extra.text+' Check the amounts and links, then check again.');activity('check','mismatch');return false;}
        }
        state.done[lesson.id]={record,checkedAt:new Date().toISOString(),assisted:!!state.assisted[lesson.id],explained:false};save();
        if(predicted() && !predicted().actual){predicted().actual=await evidence(lesson, record);save();}
        const consequences=(lesson.also||[]).map(extra=>' '+extra.text).join('');
        setStatus('Saved work verified.'+consequences);
        activity('check','matched');render();return true;
      } catch {if(version===revision)setStatus(`Could not verify the saved record. Check your ${product} login and retry. Nothing was marked complete.`);return false;}
      finally{checking=false;render();}
    }
    $('check').onclick=()=>{
      const q=question();
      if(q) {
        if(connected)window.dispatchEvent(new CustomEvent('dhimantai-erp-focus',{detail:{id:q.id}}));
        else setStatus('Open this course from dhimantAI to answer in Instructor. Your progress is saved.');
      } else {
        const wasFinished=finished(raw().id);
        void continueTask(raw().id).then(message=>{if(wasFinished)setStatus(message);});
      }
    };
    let applyingInstructorAnswer=false;
    function question() {
      const lesson=current(),done=state.done[lesson.id];
      const base={task:lesson.id,title:lesson.title,options:[],context:'',minLength:30,maxLength:500};
      if(predicting())return {...base,id:lesson.id+':prediction:'+(done?.checkedAt||'before'),kind:'prediction',
        question:lesson.predict.question,options:lesson.predict.options,minLength:1,
        context:'Make a prediction before checking the result. Do not reveal the answer yet.'};
      if(done && !done.explained && !form()?.dirty) {
        const p=predicted(),recorded=app.postings&&needsFinal()?postedText(posted[formOf(lesson)+':'+done.record]):'';
        return {...base,id:lesson.id+':explanation:'+done.checkedAt,kind:'explanation',
          question:lesson.explain||'Explain what this record did and why.',
          context:([`Saved record: ${done.record}.`,recorded?product+' recorded: '+recorded:'',
            p&&lesson.predict?`Prediction: ${lesson.predict.options[p.choice]}. ${p.actual||''}`:''].filter(Boolean).join('\n')).slice(0,2000)};
      }
      if(course.lessons.every(l=>finished(l.id)) && app.books && index===course.lessons.length-1 && !state.closing)
        return {...base,id:lesson.id+':reflection:'+done.checkedAt,kind:'reflection',title:'Close the books',
          question:$('reflection-question').textContent,minLength:40,maxLength:800,
          context:(books?books.map(l=>`${short(l.account)} (${l.kind}) ${money(l.balance)}`).join('; '):'').slice(0,2000)};
      return null;
    }
    async function answerQuestion(id,text) {
      const q=question();
      if(!q || q.id!==id || typeof text!=='string' || text.trim().length<q.minLength || text.length>q.maxLength)return false;
      if(q.options.length && !q.options.includes(text))return false;
      applyingInstructorAnswer=true;
      try {
        if(q.kind==='prediction') {
          const radio=shadow.querySelectorAll('input[name="prediction"]')[q.options.indexOf(text)];
          radio.checked=true;await lockPrediction();
        } else if(q.kind==='explanation') { $('explanation').value=text;$('send-explanation').onclick(); }
        else { $('reflection').value=text;await $('send-reflection').onclick(); }
        return true;
      } finally {applyingInstructorAnswer=false;}
    }
    async function continueTask(task) {
      if(task!==raw().id)return 'The task changed. Continue from the current task in Instructor.';
      if(advancing)return 'Opening next task…';
      if(question())return 'Answer the current question in Instructor, then continue.';
      if(finished(task)) {
        if(app.current()?.dirty)return `Save your changes in ${product}, then check the task again.`;
        if(form() && activeRecord()!==state.done[task].record)return 'Reopen the checked record or check this record before continuing.';
        if(index===course.lessons.length-1)return 'You have completed the course tasks.';
        advancing=true;nextTask();setPanelClosed(false);
        try {await $('open').onclick();}
        catch {return 'Continue with '+current().title+'. Use Open task in the browser to open the form.';}
        finally {advancing=false;render();}
        return 'Continue with '+current().title+'.';
      }
      await checkSaved();
      return status.textContent;
    }
    async function openTask(task) {
      const target=course.lessons.findIndex(lesson=>lesson.id===task);
      if(target<0)return 'This chapter has no browser task.';
      if(advancing)return 'Opening the selected task…';
      if(app.current()?.dirty)return `Save or discard your current form in ${product}, then skip the chapter again.`;
      advancing=true;index=target;focusStep=undefined;revision++;setStatus('');save();setPanelClosed(false);activity('view');
      try {
        if(missing().length)return 'Chapter opened. Its practical task needs an earlier record; see the browser instructions.';
        await $('open').onclick();
        return 'Chapter opened. Your unfinished tasks remain available in the task list.';
      } catch {return 'Chapter opened. Choose Open task in the browser to retry opening its form.';}
      finally {advancing=false;render();}
    }
    window.dhimantaiErpGuide={user,tag,course:course.id,current,step,complete,root:shadow,status:()=>status.textContent,reportStatus:setStatus,live:$('live'),question,answerQuestion,continueTask,openTask};
    window.addEventListener('scroll',()=>highlight(),true);window.addEventListener('resize',()=>{highlight();reserve(true);});
    // Re-read the form after typing, SPA navigation and asynchronous rendering; never retain a stale element.
    setInterval(()=>{
      if(document.hidden)return;
      const open=form(), doc=open?.values, signature=JSON.stringify([index,!!open,onSource(),!!predicted(),open?.dirty,open?.id,open?.final,current().steps.map(s=>stepDone(doc,s))]);
      if(signature!==lastSignature){lastSignature=signature;render();} else {highlight();reserve();}
    },700);
    setPanelClosed(!!state.panelClosed);
  }
  boot().catch(()=>{});
})();
