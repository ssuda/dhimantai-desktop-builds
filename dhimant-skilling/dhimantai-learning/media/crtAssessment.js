/* The extension host owns the authenticated exam RPCs. This webview never receives a token or an answer key before submission. */
(() => {
  'use strict';
  const host = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const status = message => { el('save-status').textContent = message; };
  const names = ['Numerical ability and data', 'Reasoning', 'Verbal ability'];
  const period = 20 * 60 * 1000;
  let state, answers = {}, revision = 0, clockOffset = 0, section = -1;
  let saved = '', inFlight = null, sequence=0, sending = false, failed = false, loading = false;
  let pendingScores = false, lastPoll = 0;

  function load() {
    if (loading || inFlight || sending) return;
    loading = true;
    el('retry').hidden = true;
    status('Loading your saved attempt…');
    host.postMessage({type:'load'});
  }
  function save() {
    if (!state || state.submitted_at || failed || loading || sending) return;
    const snapshot = JSON.stringify(answers);
    if (snapshot === (inFlight?.snapshot ?? saved)) return;
    inFlight = {snapshot,sequence:++sequence};
    status('Saving answers…');
    host.postMessage({type:'save',revision,sequence,answers:JSON.parse(snapshot)});
    tick();
  }
  function record(position, value) {
    if (value === '') delete answers[position];
    else answers[position] = value;
    save();
  }
  function ask(question) {
    const field = document.createElement('fieldset'), legend = document.createElement('legend');
    const position = String(question.position);
    field.dataset.position = position;
    legend.textContent = (question.position % 12 + 1) + '. ' + question.question_text;
    field.append(legend);
    if (question.question_type === 'mcq') {
      question.options.forEach((label,index) => {
        const choice = document.createElement('label'), radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'q' + position; radio.value = String(index);
        radio.checked = answers[position] === index;
        radio.addEventListener('change', () => record(position,index));
        choice.append(radio,document.createTextNode(' ' + label)); field.append(choice);
      });
      const clear = document.createElement('button');
      clear.type='button'; clear.textContent='Clear answer';
      clear.onclick = () => { field.querySelectorAll('input').forEach(r => { r.checked=false; }); record(position,''); };
      field.append(clear);
    } else {
      const numerical = ['integer_answer','numerical_value'].includes(question.question_type);
      const input = document.createElement(numerical?'input':'textarea');
      input.setAttribute('aria-label',legend.textContent);
      input.value = answers[position] ?? '';
      if (numerical) { input.type='number'; input.step='any'; }
      else input.maxLength=20000;
      input.addEventListener('input', () => {
        if (numerical && input.validity.badInput) { status('Finish entering the number to save this answer.'); return; }
        record(position,input.value);
      });
      field.append(input);
    }
    return field;
  }
  const seconds = value => {
    const t=Math.max(0,Math.ceil(value/1000));
    return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');
  };
  function tick() {
    if (!state) return;
    if (state.submitted_at) {
      if (pendingScores && !document.hidden && Date.now()-lastPoll>15000) refresh();
      return;
    }
    const now=Date.now()+clockOffset, end=Date.parse(state.deadline), start=Date.parse(state.started_at);
    const index=Math.min(2,Math.max(0,Math.floor((now-start)/period)));
    const expired=now>=end;
    el('clock').textContent=expired?'Time is up.':'Section time remaining '+seconds(Math.min(start+(index+1)*period,end)-now)+' · Assessment time remaining '+seconds(end-now);
    if (expired) {
      el('questions').hidden=true; el('close').hidden=true; el('submit').hidden=true; el('confirmation').hidden=true;
      if (!failed) load();
      return;
    }
    if (section!==index) {
      if (section!==-1) {
        el('confirmation').hidden=true;
        // Re-read acknowledged answers at a section boundary, after outstanding saves settle.
        if (inFlight || sending) return;
        if (!failed) load();
        return;
      }
      section=index;
      el('section').textContent=names[index]+' · Section '+(index+1)+' of 3';
      el('questions').replaceChildren(...state.questions.filter(q=>Math.floor(q.position/12)===index).map(ask));
    }
    el('questions').querySelectorAll('fieldset').forEach(f=>{f.disabled=failed || sending || loading;});
    el('close').disabled=el('submit').disabled=failed || !!inFlight || loading || sending || JSON.stringify(answers)!==saved;
  }
  function showState(value) {
    state=value; revision=value.revision; answers={...value.answers}; saved=JSON.stringify(answers);
    inFlight=null; sending=false; failed=false; loading=false; section=-1;
    clockOffset=Date.parse(value.server_time)-Date.now();
    el('retry').hidden=true; el('confirmation').hidden=true;
    el('close').hidden=!!value.submitted_at; el('submit').hidden=!!value.submitted_at; el('instructions').hidden=!!value.submitted_at;
    el('questions').hidden=!!value.submitted_at;
    if (value.submitted_at) {
      el('questions').replaceChildren(); el('clock').textContent=''; el('section').textContent='Assessment submitted';
      status(value.grading_pending?'Written responses are being graded.':'Your saved attempt has been submitted.');
    } else status('All answers saved.');
    el('review').hidden=!value.released || !Array.isArray(value.results);
    if (!el('review').hidden) {
      const answers=value.results.map(result=>{
        const q=value.questions.find(q=>q.position===result.position);
        const item=document.createElement('li');
        const display=v=>q?.question_type==='mcq' && Number.isInteger(v)?q.options[v]:String(v??'');
        item.textContent=(q?.question_text||'')+' · Your answer: '+(result.skipped?'Blank':display(result.answer))+
          ' · '+result.score+' / '+result.max_marks+' · Reference: '+display(result.correct_answer);
        return item;
      });
      el('review').querySelector('ol').replaceChildren(...answers);
    }
    tick();
  }
  function refresh() {
    lastPoll=Date.now();
    host.postMessage({type:'scores'});
  }
  function compare(values) {
    const ids=[document.body.dataset.entry,document.body.dataset.exit];
    const labels={available:'Not started',locked:'Locked',in_progress:'In progress',grading:'Grading',needs_review:'Awaiting grading review'};
    const rows=[...names,'Total'].map(name=>{
      const tr=document.createElement('tr'),head=document.createElement('th');
      head.scope='row';head.textContent=name;tr.append(head);
      for (const id of ids) {
        const cell=document.createElement('td'), result=values[id];
        cell.textContent=result?.status==='scored' ? (name==='Total'?result.score+' / 36':result.sections[name]+' / 12') : labels[result?.status] || 'Unavailable';
        tr.append(cell);
      }
      return tr;
    });
    el('results').querySelector('tbody').replaceChildren(...rows);el('results').hidden=false;
    pendingScores=ids.some(id=>values[id]?.status==='grading');lastPoll=Date.now();
    const own=values[state?.exam_id];
    if (state?.submitted_at && own?.status==='scored') {
      status('Your scores are ready.');
      if (state.grading_pending && !loading) load();
    }
    if (own?.status==='needs_review') status('Your written responses require a grading review.');
  }
  el('submit').onclick=()=>{
    if (el('submit').disabled) return;
    const count=Object.keys(answers).length;
    el('confirm-note').textContent='Submit '+count+' of 36 answers? Unanswered questions earn zero. Submission is final.';
    el('confirmation').hidden=false;el('cancel').focus();
  };
  el('cancel').onclick=()=>{el('confirmation').hidden=true;el('submit').focus();};
  el('confirm').onclick=()=>{
    if (el('submit').disabled || sending || failed || !state || state.submitted_at) return;
    sending=true;el('confirmation').hidden=true;status('Submitting…');tick();
    host.postMessage({type:'submit',revision,answers:{...answers}});
  };
  el('close').onclick=()=>{if (!el('close').disabled && !inFlight) host.postMessage({type:'close'});};
  el('retry').onclick=load;el('refresh').onclick=refresh;
  window.addEventListener('message',({data})=>{
    if (data?.type==='state') showState(data.state);
    if (data?.type==='scores') compare(data.scores);
    if (data?.type==='saved' && inFlight && data.sequence===inFlight.sequence) {
      revision=data.revision;saved=inFlight.snapshot;inFlight=null;
      status('All answers saved.');save();tick();
    }
    if (data?.type==='error') {
      if (data.operation==='scores') { status('Score comparison unavailable. '+data.message); return; }
      inFlight=null;sending=false;loading=false;failed=true;el('confirmation').hidden=true;
      status(data.message+' Reload to use the answers saved on the server.');
      el('retry').hidden=false;tick();
    }
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) tick();});
  const timer=setInterval(tick,500);
  window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  load();
})();
