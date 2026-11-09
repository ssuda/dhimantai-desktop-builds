(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  let revision = 0, currentStep = -1, currentScope = '', conversationId = '', lastSaved = '', rendered = [], resetting = false;
  let milestoneState = '', stepOptions = '';
  const drafts = new Map();
  const draft = () => ({note: $('note').value, externalHelp: $('externalHelp').value, completed: $('completed').checked});
  const restoreDraft = value => {
    $('note').value = value?.note || ''; $('externalHelp').value = value?.externalHelp || 'unknown';
    $('completed').checked = value?.completed === true;
  };
  const send = (type, data = {}) => api.postMessage({type, revision, conversationId, scope: currentScope, step: currentStep, ...data});
  const navigate = index => {
    if (index < 0 || index >= $('step').options.length || index === currentStep) return;
    for (const id of ['previous', 'next', 'step', 'check', 'ask', 'hint', 'finish', 'refreshHandoff', 'runLive', 'checkpoint', 'newChat', 'submitProject', 'projectActions']) $(id).disabled = true;
    send('step', {index});
  };
  $('step').onchange = () => navigate(Number($('step').value));
  $('previous').onclick = () => navigate(currentStep - 1);
  $('next').onclick = () => navigate(currentStep + 1);
  $('runtime').onchange = () => send('runtime', {value: $('runtime').value});
  $('check').onclick = () => send('check');
  $('hint').onclick = () => send('hint');
  $('finish').onclick = () => send('finish', {help: $('externalHelp').value});
  $('refreshHandoff').onclick = () => send('refreshHandoff');
  $('runLive').onclick = () => send('runLive');
  $('submitProject').onclick = () => send('submitProject', {help: $('externalHelp').value});
  $('projectActions').onchange = () => { send('projectAction', {action: $('projectActions').value}); $('projectActions').value = ''; };
  $('newChat').onclick = () => {
    if (resetting) return;
    resetting = true; $('newChat').disabled = true; $('ask').disabled = true;
    $('message').value = ''; $('conversation').replaceChildren(); rendered = [];
    $('emptyChat').hidden = false; send('newChat');
  };
  $('checkpoint').onclick = () => send('checkpoint', {note: $('note').value, help: $('externalHelp').value, completed: $('completed').checked});
  $('composer').onsubmit = event => { event.preventDefault(); if ($('message').value.trim()) send('ask', {text: $('message').value}); };
  window.addEventListener('message', ({data: s}) => {
    if (s.type === 'error') { $('status').textContent = s.text; return; }
    if (s.type !== 'state') return;
    if (s.scope === currentScope && s.revision < revision) return;
    if (resetting && s.scope === currentScope && s.conversationId === conversationId) return;
    resetting = false; $('newChat').disabled = false;
    const conversationChanged = conversationId !== s.conversationId;
    conversationId = s.conversationId;
    revision = s.revision;
    const content = $('projectContent'), oldScroll = content.scrollTop;
    const following = content.scrollHeight - content.clientHeight - oldScroll < 80 ||
      Math.abs($('conversation').getBoundingClientRect().bottom - content.getBoundingClientRect().bottom) < 80;
    if (currentScope !== s.scope) {
      currentScope = s.scope; currentStep = -1; lastSaved = ''; milestoneState = ''; drafts.clear();
      $('message').value = ''; restoreDraft();
    }
    $('title').textContent = s.title;
    $('check').textContent = s.reading ? 'Run this step' : 'Check this step';
    const stepChanged = currentStep !== s.step;
    const milestones = s.milestones || s.steps.map(() => ({status: 'not_started'}));
    const labels = {complete: 'Complete (self-reported)', review: 'Review changes', in_progress: 'In progress', not_started: 'Not started'};
    const status = milestones[s.step].status;
    if (stepChanged) {
      if (currentStep >= 0) drafts.set(currentStep, draft());
      currentStep = s.step; $('message').value = '';
      const savedDraft = drafts.get(s.step) || s.checkpoint;
      restoreDraft({...savedDraft, completed: savedDraft?.completed && status !== 'review'});
      lastSaved = s.checkpoint?.at;
      $('checkpointDetails').open = false;
    }
    const options = s.steps.map((title, index) => title + ' · ' + labels[milestones[index].status]);
    if (stepOptions !== JSON.stringify(options)) {
      stepOptions = JSON.stringify(options);
      $('step').replaceChildren(...options.map((title, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = title; return option; }));
    }
    $('step').disabled = false;
    $('previous').disabled = s.step === 0; $('next').disabled = s.step === s.steps.length - 1;
    const completed = milestones.filter(m => m.status === 'complete').length;
    const review = milestones.filter(m => m.status === 'review').length;
    $('progressText').textContent = `Milestone ${s.step + 1} of ${s.steps.length} · ${completed}/${s.steps.length} marked complete` + (review ? ` · ${review} to review` : '');
    $('progress').max = s.steps.length; $('progress').value = completed;
    $('milestoneStatus').textContent = status === 'review'
      ? 'Project files changed since you marked this milestone complete. Review your evidence and save your progress again.'
      : labels[status] + (status === 'complete' ? ' · Local progress, not an assessment.' : ' · Record your evidence in Save milestone progress below.');
    if (status === 'review' && milestoneState !== 'review') $('completed').checked = false;
    milestoneState = status;
    $('step').value = String(s.step); $('runtime').value = s.runtime;
    $('runtime').querySelector('[value="course"]').disabled = !s.courseAvailable;
    for (const id of ['goal','opening','task','reflection']) $(id).textContent = s.current[id];
    $('expected').textContent = s.current.expected;
    $('files').replaceChildren(...s.current.files.map(path => {
      const reference = document.createElement('div'), button = document.createElement('button'), anchor = s.current.anchors?.[path]?.trim();
      button.className = 'link'; button.textContent = path; button.title = anchor ? 'Open at ' + anchor : 'Open ' + path;
      button.setAttribute('aria-label', path + (anchor ? ', find ' + anchor : ''));
      button.onclick = () => send('file', {path}); reference.append(button);
      if (anchor) { const location = document.createElement('small'); location.className = 'muted'; location.textContent = anchor; reference.append(location); }
      return reference;
    }));
    $('checkState').textContent = s.check.state === 'not_run' ? 'Not checked for this step.' :
      (s.check.state === 'changed' ? 'Earlier files · ' : 'Current files · ') + s.check.status + (s.check.truncated ? ' · output truncated' : '');
    $('checkSummary').textContent = 'Check · ' + $('checkState').textContent;
    $('checkRecovery').textContent = s.check.state === 'changed' ? 'Save your files and run this step again before relying on the earlier output.'
      : s.check.status === 'runtime_error' ? 'Use Runtime → Set up course, then retry. Open the course terminal if the error needs investigation.'
      : s.check.status === 'timed_out' ? 'Look for a loop that does not stop. Use “I’m stuck” to narrow the next investigation, then retry.'
      : s.check.status === 'failed' ? 'Find the first failure in the output, compare it with the expected outcome, then use “I’m stuck” for a smaller step.'
      : s.check.status === 'passed' ? 'Compare the output with the expected outcome and record your explanation. A successful run does not mark this milestone complete.'
      : 'Predict the result, then run this step in the course container.';
    $('output').textContent = s.check.output || '';
    $('shared').textContent = 'Shared excerpts:\n' + s.sharedFiles.join('\n')
      + (s.omitted.length ? '\n\nContent not included (' + (s.omittedCount ?? s.omitted.length) + ' files):\n' + s.omitted.join('\n')
        + (s.omittedCount > s.omitted.length ? '\n…more files omitted' : '') : '')
      + (s.structure ? '\n\nProject map (' + s.structure.total_files + ' public files' + (s.structure.truncated ? ', partial list' : '') + '):\n' + s.structure.files.join('\n') : '');
    if (s.git) $('shared').textContent += s.git.state === 'available'
      ? '\n\nGit · ' + s.git.branch + ' · ' + s.git.head.slice(0, 7) + '\nPublic file changes:\n'
        + (s.git.changed_files.map(f => f.status + ' ' + f.path).join('\n') || 'None')
        + '\nRecent commits:\n' + s.git.recent_commits.join('\n') + (s.git.truncated ? '\n(Git context truncated)' : '')
      : '\n\nGit context unavailable.';
    $('status').textContent = s.status;
    $('handoff').hidden = !s.finalStep; $('liveRun').hidden = !s.liveStep;
    $('handoffStatus').textContent = s.handoffStatus || '';
    $('submission').hidden = !s.submissionStep;
    $('completion').textContent = s.completion || 'In progress';
    $('submitProject').disabled = s.busy;
    $('projectActions').disabled = s.busy;
    $('finish').textContent = s.handoffMode === 'teacher' ? 'Submit project for teacher review' : 'Prepare final handoff';
    $('liveOutput').textContent = s.liveOutput || '';
    for (const id of ['finish', 'refreshHandoff', 'runLive']) $(id).disabled = s.busy;
    $('runLive').disabled ||= !s.ai;
    $('check').disabled = s.busy; $('ask').disabled = s.busy || !s.ai; $('hint').disabled = s.busy;
    $('hint').textContent = s.hintLevel >= 2 ? (s.ai && s.signedIn ? 'Ask Coach for help' : 'Review next step') : s.hintLevel === 1 ? 'Try a smaller step' : 'I’m stuck';
    $('checkpoint').disabled = false;
    const chatChanged = stepChanged || conversationChanged;
    if (chatChanged) { $('conversation').replaceChildren(); rendered = []; $('message').value = ''; }
    const keys = s.messages.map(message => JSON.stringify([message.role, message.text, message.digest]));
    let common = 0;
    while (common < rendered.length && common < keys.length && rendered[common] === keys[common]) common++;
    while ($('conversation').children.length > common) $('conversation').lastChild.remove();
    s.messages.slice(common).forEach(message => {
      const row = document.createElement('article'); row.className = 'msg ' + (message.role === 'tutor' ? 'coach' : 'learner');
      const label = document.createElement('strong'); label.textContent = message.role === 'tutor' ? 'Coach' : 'You';
      const body = document.createElement('div'); body.className = 'bubble markdown';
      if (message.role === 'tutor') body.innerHTML = window.CoachMarkdown.render(message.text);
      else body.textContent = message.text;
      row.append(label, body); $('conversation').append(row);
    });
    const added = common < keys.length;
    rendered = keys;
    $('emptyChat').hidden = keys.length > 0;
    if (chatChanged) content.scrollTop = 0;
    else if (added && (following || s.messages.at(-1)?.role === 'learner'))
      content.scrollTop += $('conversation').getBoundingClientRect().bottom - content.getBoundingClientRect().bottom;
    else content.scrollTop = oldScroll;
    if (s.busy && s.messages.at(-1)?.role === 'learner' && $('message').value === s.messages.at(-1).text) $('message').value = '';
    if (s.checkpoint?.at !== lastSaved) {
      lastSaved = s.checkpoint?.at;
      restoreDraft({...s.checkpoint, completed: s.checkpoint?.completed && status === 'complete'});
      drafts.delete(s.step);
    }
    $('saved').textContent = s.checkpoint ? 'Saved for this milestone ' + new Date(s.checkpoint.at).toLocaleString() + ' · ' + s.checkpoint.assistance + ' Coach help turns recorded.' : 'No checkpoint saved for this milestone yet.';
  });
  send('ready');
})();
