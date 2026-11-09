(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  let revision = 0, currentStep = -1, currentScope = '', lastSaved = '', messageCount = 0;
  const send = (type, data = {}) => api.postMessage({type, revision, scope: currentScope, step: currentStep, ...data});
  $('step').onchange = () => { $('check').disabled = true; $('ask').disabled = true; send('step', {index: Number($('step').value)}); };
  $('runtime').onchange = () => send('runtime', {value: $('runtime').value});
  $('check').onclick = () => send('check');
  $('hint').onclick = () => send('hint');
  $('newChat').onclick = () => { $('message').value = ''; send('newChat'); };
  $('checkpoint').onclick = () => send('checkpoint', {note: $('note').value, help: $('externalHelp').value});
  $('composer').onsubmit = event => { event.preventDefault(); if ($('message').value.trim()) send('ask', {text: $('message').value}); };
  window.addEventListener('message', ({data: s}) => {
    if (s.type === 'error') { $('status').textContent = s.text; return; }
    if (s.type !== 'state') return;
    revision = s.revision;
    if (currentScope !== s.scope) {
      currentScope = s.scope; currentStep = -1; lastSaved = '';
      $('message').value = ''; $('note').value = ''; $('externalHelp').value = 'unknown';
    }
    $('title').textContent = s.title;
    $('check').textContent = s.reading ? 'Run this step' : 'Check this step';
    const stepChanged = currentStep !== s.step;
    if (stepChanged) {
      currentStep = s.step; $('message').value = '';
      messageCount = 0;
      $('step').replaceChildren(...s.steps.map((title, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = title; return option; }));
    }
    $('step').value = String(s.step); $('runtime').value = s.runtime;
    $('runtime').querySelector('[value="course"]').disabled = !s.courseAvailable;
    for (const id of ['goal','opening','task','reflection']) $(id).textContent = s.current[id];
    $('expected').textContent = 'Expected: ' + s.current.expected;
    $('files').replaceChildren(...s.current.files.map(path => { const button = document.createElement('button'); button.className = 'link'; button.textContent = path; button.onclick = () => send('file', {path}); return button; }));
    $('checkState').textContent = s.check.state === 'not_run' ? 'Not checked for this step.' :
      (s.check.state === 'changed' ? 'Earlier files · ' : 'Current files · ') + s.check.status + (s.check.truncated ? ' · output truncated' : '');
    $('checkSummary').textContent = 'Check · ' + $('checkState').textContent;
    $('output').textContent = s.check.output || '';
    $('shared').textContent = s.sharedFiles.join('\n') + (s.omitted.length ? '\n\nNot included:\n' + s.omitted.join('\n') : '');
    $('status').textContent = s.status;
    $('check').disabled = s.busy; $('ask').disabled = s.busy || !s.ai; $('hint').disabled = s.busy;
    $('conversation').replaceChildren(...s.messages.map(message => {
      const row = document.createElement('article'); row.className = 'msg ' + (message.role === 'tutor' ? 'coach' : 'learner');
      const label = document.createElement('strong'); label.textContent = message.role === 'tutor' ? 'Coach' : 'You';
      const body = document.createElement('div'); body.className = 'bubble markdown';
      if (message.role === 'tutor') body.innerHTML = window.CoachMarkdown.render(message.text);
      else body.textContent = message.text;
      row.append(label, body); return row;
    }));
    if (s.messages.length > messageCount) $('conversation').scrollIntoView({block: 'end'});
    messageCount = s.messages.length;
    if (stepChanged) $('projectContent').scrollTop = 0;
    if (s.busy && s.messages.at(-1)?.role === 'learner') $('message').value = '';
    if (s.checkpoint?.at !== lastSaved) {
      lastSaved = s.checkpoint?.at;
      $('note').value = s.checkpoint?.note || ''; $('externalHelp').value = s.checkpoint?.externalHelp || 'unknown';
    }
    $('saved').textContent = s.checkpoint ? 'Saved ' + new Date(s.checkpoint.at).toLocaleString() + ' · ' + s.checkpoint.assistance + ' Coach help turns recorded.' : 'No checkpoint saved yet.';
  });
  send('ready');
})();
