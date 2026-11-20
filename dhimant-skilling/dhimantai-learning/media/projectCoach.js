(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  let revision = 0, currentStep = -1, currentScope = '', conversationId = '', lastSaved = '', rendered = [], resetting = false;
  let stepOptions = '', reviewOptions = '', nextGuideStep, sharedState, previewTimer, readingSubmission = false;
  const drafts = new Map();
  const draft = () => ({note: $('note').value, externalHelp: $('externalHelp').value});
  const clearNoteError = () => {
    $('note').removeAttribute('aria-invalid');
    $('noteError').textContent = '';
  };
  $('note').oninput = () => { if ($('note').value.trim()) clearNoteError(); };
  const restoreDraft = value => {
    $('note').value = value?.note || ''; $('externalHelp').value = value?.externalHelp || 'unknown';
    clearNoteError();
  };
  const send = (type, data = {}) => api.postMessage({type, revision, conversationId, scope: currentScope, step: currentStep, ...data});
  const playback = window.installCoachAudio?.(api);
  const dictation = window.installDictation?.(api, $('message'), () => playback?.listenForReply());
  const stopVoice = () => { dictation?.cancel(); playback?.turnOff(); };
  // Disable immediately; the host's next state re-enables, so a double click cannot start twice.
  const lock = (...ids) => { for (const id of ids) $(id).disabled = true; };
  const actions = ['check', 'hint', 'ask', 'finish', 'refreshHandoff', 'runLive', 'submitProject'];
  const act = (type, data) => { composer.setAvailable(false); dictation?.setScope(''); lock(...actions); send(type, data); };
  const renderShared = s => {
    const count = s.sharedFiles.length;
    $('sharedSummary').textContent = s.contextProblem ? 'Coach cannot read your project files right now.'
      : count ? `${count} project ${count === 1 ? 'file' : 'files'} included when you send` : 'No project files will be shared.';
    $('shared').textContent = (s.contextProblem ? s.contextProblem + '\n\n' : '') + 'Shared excerpts:\n' + s.sharedFiles.join('\n')
      + (s.omitted.length ? '\n\nContent not included (' + (s.omittedCount ?? s.omitted.length) + ' files):\n' + s.omitted.join('\n')
        + (s.omittedCount > s.omitted.length ? '\n…more files omitted' : '') : '')
      + (s.structure ? '\n\nProject map (' + s.structure.total_files + ' public files' + (s.structure.truncated ? ', partial list' : '') + '):\n' + s.structure.files.join('\n') : '');
    if (s.git) $('shared').textContent += s.git.state === 'available'
      ? '\n\nGit · ' + s.git.branch + ' · ' + s.git.head.slice(0, 7) + '\nPublic file changes:\n'
        + (s.git.changed_files.map(f => f.status + ' ' + f.path).join('\n') || 'None')
        + '\nRecent commits:\n' + s.git.recent_commits.join('\n') + (s.git.truncated ? '\n(Git context truncated)' : '')
      : '\n\nGit context unavailable.';
  };
  // Show the files the typed question will share, not the previous question's.
  const previewShared = () => {
    clearTimeout(previewTimer);
    if (!$('message').value.trim()) { if (sharedState) renderShared(sharedState); return; }
    previewTimer = setTimeout(() => send('contextPreview', {text: $('message').value}), 300);
  };
  $('message').oninput = previewShared;
  const navigate = index => {
    if (index < 0 || index >= $('step').options.length || index === currentStep) return;
    composer.setAvailable(false); preparing = undefined;
    // Keep a learner's speaker choice through guided navigation, and cancel the old room immediately.
    nextGuideStep = $('guidePanel').hidden ? undefined : index;
    if (nextGuideStep !== undefined) { playback?.reply(null); dictation?.cancel(); }
    else stopVoice();
    dictation?.setScope('');
    for (const id of ['previous', 'next', 'step', 'check', 'ask', 'hint', 'finish', 'refreshHandoff', 'runLive', 'checkpoint', 'saveDraft', 'newChat', 'submitProject', 'projectActions']) $(id).disabled = true;
    send('step', {index});
  };
  $('step').onchange = () => navigate(Number($('step').value));
  $('previous').onclick = () => navigate(currentStep - 1);
  $('next').onclick = () => navigate(currentStep + 1);
  $('runtime').onchange = () => send('runtime', {value: $('runtime').value});
  $('check').onclick = () => act('check');
  $('hint').onclick = () => act('hint');
  $('finish').onclick = () => act('finish', {help: $('externalHelp').value, note: $('note').value});
  $('refreshHandoff').onclick = () => act('refreshHandoff');
  $('runLive').onclick = () => act('runLive');
  $('submitProject').onclick = () => {
    if (readingSubmission && !requireEvidence('Add your reading evidence before submitting the project.')) return;
    act('submitProject', {help: $('externalHelp').value, note: $('note').value});
  };
  $('projectActions').onchange = () => { send('projectAction', {action: $('projectActions').value}); $('projectActions').value = ''; };
  $('newChat').onclick = () => {
    if (resetting) return;
    composer.setAvailable(false); preparing = undefined;
    stopVoice(); dictation?.setScope('');
    resetting = true; $('newChat').disabled = true; $('ask').disabled = true;
    $('message').value = ''; $('conversation').replaceChildren(); rendered = [];
    $('newChat').hidden = true; send('newChat');
  };
  const requireEvidence = message => {
    if ($('note').value.trim()) return true;
    $('note').setAttribute('aria-invalid', 'true');
    $('noteError').textContent = message;
    $('note').focus();
    return false;
  };
  const saveCheckpoint = completed => {
    if (completed && !requireEvidence('Add your evidence here to complete this milestone.')) return;
    clearNoteError();
    lock('checkpoint', 'saveDraft');
    send('checkpoint', {note: $('note').value, help: $('externalHelp').value, completed});
  };
  $('checkpoint').onclick = () => saveCheckpoint(true);
  $('saveDraft').onclick = () => saveCheckpoint(false);
  let preparing;
  const composer = window.LearningComposer.bindComposer($('composer'), async message => {
    if ($('ask').disabled || preparing) return;
    const text = message.text.trim() || 'Help me understand the attached material.';
    const turn = preparing = {chat:conversationId, scope:currentScope, step:currentStep, revision};
    const current = () => preparing === turn && turn.chat === conversationId && turn.scope === currentScope && turn.step === currentStep && turn.revision === revision;
    lock('ask'); composer.setAvailable(false);
    try {
      const files = await attachments.encoded(false, message.attachments);
      if (!current()) return;
      clearTimeout(previewTimer); act('ask', {text, attachments:files});
    } catch (error) {
      if (!current()) return;
      $('attachment-status').textContent = error.message;
      composer.setAvailable(true);
    } finally {
      if (preparing === turn) preparing = undefined;
    }
  });
  const {attachments} = composer;
  composer.setAvailable(false);
  window.addEventListener('message', ({data: s}) => {
    if (s.type === 'audioOff') { nextGuideStep = undefined; composer.cancelCapture(); dictation?.cancel(); return; }
    if (s.type === 'questionAccepted') {
      if (s.scope === currentScope && s.step === currentStep && s.conversationId === conversationId &&
          $('message').value.trim() === s.text.trim()) $('message').value = '';
      return;
    }
    if (s.type === 'checkpointError') {
      if (s.scope === currentScope && s.step === currentStep && s.conversationId === conversationId) {
        $('noteError').textContent = s.text;
        $('checkpoint').disabled = false; $('saveDraft').disabled = false;
      }
      return;
    }
    if (s.type === 'error') { $('status').textContent = s.text; return; }
    if (s.type === 'contextPreview') { if (s.scope === currentScope && s.text === $('message').value) renderShared(s); return; }
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
    const scopeChanged = currentScope !== s.scope;
    if (scopeChanged) {
      currentScope = s.scope; currentStep = -1; lastSaved = ''; drafts.clear();
      $('message').value = ''; restoreDraft();
    }
    $('title').textContent = s.title;
    $('check').textContent = s.reading ? 'Run this step' : 'Check this step';
    const stepChanged = currentStep !== s.step;
    const milestones = s.milestones || s.steps.map(() => ({status: 'not_started'}));
    const labels = {complete: 'Complete (self-reported)', review: 'Complete · review changes'};
    const status = milestones[s.step].status;
    const markedComplete = status === 'complete' || status === 'review';
    if (stepChanged) {
      if (currentStep >= 0) drafts.set(currentStep, draft());
      currentStep = s.step; $('message').value = '';
      const savedDraft = drafts.get(s.step) || s.checkpoint;
      restoreDraft(savedDraft);
      lastSaved = s.checkpoint?.at;
      $('milestoneBackground').open = false;
      $('milestoneReflection').open = false;
    }
    const options = s.steps.map((title, index) => [title, labels[milestones[index].status]].filter(Boolean).join(' · '));
    if (stepOptions !== JSON.stringify(options)) {
      stepOptions = JSON.stringify(options);
      $('step').replaceChildren(...options.map((title, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = title; return option; }));
    }
    $('step').disabled = false;
    $('previous').disabled = s.step === 0; $('next').disabled = s.step === s.steps.length - 1;
    const review = milestones.flatMap((m, index) => m.status === 'review' ? [index] : []);
    const completed = milestones.filter(m => m.status === 'complete').length + review.length;
    $('progressText').textContent = `${completed}/${s.steps.length} marked complete`;
    $('progress').max = s.steps.length; $('progress').value = completed;
    $('reviewList').hidden = !review.length;
    const reviewKey = JSON.stringify(review.map(i => [i, s.steps[i]]));
    if (reviewKey !== reviewOptions) {
      reviewOptions = reviewKey;
      $('reviewTitle').textContent = review.length === 1 ? 'Review changes · ' + s.steps[review[0]] : `Review changes in ${review.length} milestones`;
      $('reviewSteps').replaceChildren(...review.map(i => {
        const button = document.createElement('button');
        button.className = 'link'; button.textContent = s.steps[i];
        button.onclick = () => { if (i === currentStep) $('note').focus(); else navigate(i); };
        return button;
      }));
    }
    $('milestoneStatus').textContent = status === 'review'
      ? 'Files changed after this checkpoint. Review your evidence and select Save changes to confirm it.' : '';
    $('checkpoint').textContent = markedComplete ? 'Save changes' : 'Complete milestone';
    $('saveDraft').textContent = markedComplete ? 'Mark in progress' : 'Save draft';
    $('evidencePrompt').textContent = s.current.evidencePrompt || 'What did you do, and what evidence supports it?';
    $('step').value = String(s.step); $('runtime').value = s.runtime;
    if (s.runtimeLabel) $('runtime').options[0].textContent = s.runtimeLabel;
    $('runtime').querySelector('[value="course"]').disabled = !s.courseAvailable;
    for (const id of ['goal','opening','reflection']) $(id).textContent = s.current[id];
    const fileButton = (path, section) => {
      const button = document.createElement('button');
      const anchor = section ? '## ' + section : s.current.anchors?.[path];
      button.className = 'link'; button.textContent = path;
      button.title = anchor ? 'Open at ' + anchor : 'Open ' + path;
      button.setAttribute('aria-label', path + (anchor ? ', find ' + anchor : ''));
      button.onclick = () => send('file', {path, section});
      return button;
    };
    const inlineTask = (node, line) => {
      for (const [index, part] of line.split(/`([^`]+)`/).entries()) {
        if (index % 2 === 0) node.append(part);
        else if (s.current.files.includes(part)) {
          const section = part === 'READING_NOTES.md' ? s.current.guide?.sections.find(name => line.includes(name)) : undefined;
          node.append(fileButton(part, section));
        }
        else { const code = document.createElement('code'); code.textContent = part; node.append(code); }
      }
    };
    $('guidePanel').hidden = !s.guide;
    if (stepChanged || $('guide').dataset.prompt !== (s.guide || '')) {
      $('guide').replaceChildren();
      if (s.guide) inlineTask($('guide'), s.guide);
      $('guide').dataset.prompt = s.guide || '';
    }
    if (stepChanged) {
      // The guided project's first goal contains the learner's own requirements.
      const goalParent = s.guided && s.step === 0 ? $('projectContent') : $('milestoneBackground');
      goalParent.insertBefore($('goal'), goalParent === content ? content.firstChild : $('opening'));
      $('files').replaceChildren(...s.current.files.map(path => {
        const reference = document.createElement('div'), anchor = s.current.anchors?.[path];
        reference.append(fileButton(path));
        if (anchor) { const location = document.createElement('small'); location.className = 'muted'; location.textContent = anchor; reference.append(location); }
        return reference;
      }));
      const fullTask = $('fullTask');
      fullTask.hidden = !s.guide; fullTask.open = false;
      if (s.guide) fullTask.append($('task'));
      else fullTask.before($('task'));
      const lines = (s.current.task || '').split('\n');
      if (lines.length > 1) {
        const list = document.createElement('ol');
        for (const line of lines) {
          const item = document.createElement('li');
          inlineTask(item, line);
          list.append(item);
        }
        $('task').replaceChildren(list);
      } else $('task').textContent = lines[0];
    }
    $('expectedTitle').textContent = s.current.deliverable ? 'What to finish' : 'Expected outcome';
    $('expected').textContent = s.current.deliverable || s.current.expected;
    $('runtimeTip').hidden = s.step !== 0;
    $('checkState').textContent = s.check.state === 'not_run' ? 'Not checked for this step.' :
      (s.check.state === 'changed' ? 'Earlier files · ' : 'Current files · ') + s.check.status + (s.check.truncated ? ' · output truncated' : '');
    const diagnostic = s.check.state !== 'not_run' && s.check.status === 'failed' ? s.checkDiagnostic : undefined;
    $('checkDiagnostic').hidden = s.check.state === 'not_run' || s.check.status !== 'failed';
    $('checkCause').textContent = diagnostic?.cause || 'The check failed. Expand the output to see what happened.';
    $('checkLocation').textContent = diagnostic?.file ? diagnostic.file + (diagnostic.line ? ':' + diagnostic.line : '') : '';
    $('checkLocation').hidden = !diagnostic?.file;
    const firstResult = stepChanged || $('checkDetails').hidden;
    $('checkDetails').hidden = s.check.state === 'not_run';
    if (firstResult) $('checkDetails').open = !!s.current.deliverable && s.check.state === 'current' && s.check.status === 'passed';
    $('checkResult').hidden = !!s.current.deliverable && s.check.state === 'not_run';
    $('checkSummary').textContent = 'Command output' + (s.check.truncated ? ' (excerpt)' : '');
    $('checkRecovery').textContent = s.check.state === 'changed' ? 'Save your files and run this step again before relying on the earlier output.'
      : s.check.status === 'runtime_error' ? 'Open Project tools → Runtime → Set up and verify environment, then retry. Open the project terminal to investigate the error.'
      : s.check.status === 'timed_out' ? 'Look for a loop that does not stop. Use “I’m stuck” to narrow the next investigation, then retry.'
      : s.check.status === 'failed' ? (diagnostic ? 'Compare the first captured failure with the expected outcome. Expand the output for traceback details.'
        : 'Compare the output with the expected outcome.') + ' Use “I’m stuck” for a smaller step.'
      : s.check.status === 'passed' && !s.guide ? (s.current.deliverable ? s.current.expected : 'Compare the output with the expected outcome and record your explanation.')
      : '';
    $('output').textContent = s.check.output || '';
    sharedState = s;
    $('status').textContent = s.status;
    $('handoff').hidden = !s.finalStep; $('liveRun').hidden = !s.liveStep;
    $('handoffStatus').textContent = s.handoffStatus || '';
    $('submission').hidden = !s.submissionStep;
    readingSubmission = s.reading && s.submissionStep;
    $('completion').textContent = s.completion || 'In progress';
    $('submitProject').disabled = s.busy;
    $('projectActions').disabled = s.busy;
    if (s.guided) $('check').textContent = 'Inspect project files';
    $('submitProject').textContent = s.guided ? 'Open readiness assessment' : 'Submit project';
    $('finish').textContent = s.handoffMode === 'teacher' ? 'Submit project for teacher review' : 'Prepare final handoff';
    $('liveOutput').textContent = s.liveOutput || '';
    for (const id of ['finish', 'refreshHandoff', 'runLive']) $(id).disabled = s.busy;
    $('runLive').disabled ||= !s.ai;
    $('check').disabled = s.busy; $('hint').disabled = s.busy;
    $('hint').textContent = s.hintLevel >= 2 ? (s.ai && s.signedIn ? 'Ask Coach for help' : 'Review next step') : s.hintLevel === 1 ? 'Try a smaller step' : 'I’m stuck';
    $('checkpoint').disabled = false; $('saveDraft').disabled = false;
    const chatChanged = stepChanged || conversationChanged;
    const continuingGuide = stepChanged && !scopeChanged && s.guide && nextGuideStep === s.step;
    if ((chatChanged && !continuingGuide) || !s.ai || !s.voiceAvailable) stopVoice();
    if (chatChanged) nextGuideStep = undefined;
    dictation?.setScope(s.voiceAvailable && !s.busy ? conversationId : '');
    playback?.reply(s.voiceAvailable ? s.audioId : null);
    const speaker = $('audio-toggle');
    if (speaker) speaker.disabled = !s.ai || !s.voiceAvailable;
    if (chatChanged || !s.ai) composer.cancelCapture();
    if (chatChanged || !s.ai || (preparing && preparing.revision !== revision)) preparing = undefined;

    if (chatChanged) { attachments.clear(); $('conversation').replaceChildren(); rendered = []; $('message').value = ''; }
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
    $('courseAccess').textContent = s.coachCourse && !s.guided ? `Course access: ${s.coachCourse}` : '';
    $('newChat').hidden = keys.length === 0;
    if (chatChanged) content.scrollTop = 0;
    else if (added && (following || s.messages.at(-1)?.role === 'learner'))
      content.scrollTop += $('conversation').getBoundingClientRect().bottom - content.getBoundingClientRect().bottom;
    else content.scrollTop = oldScroll;
    if (added && s.busy && s.messages.at(-1)?.role === 'learner') {
      const sent = s.messages.at(-1).text;
      if (sent === $('message').value.trim() || sent.startsWith($('message').value.trim() + '\nAttached:')) $('message').value = '';
      attachments.clear();
    }
    composer.setAvailable(s.ai && !s.busy && !preparing);
    if (!$('message').value.trim()) renderShared(s); else previewShared();
    if (s.checkpoint?.at !== lastSaved) {
      lastSaved = s.checkpoint?.at;
      restoreDraft(s.checkpoint);
      drafts.delete(s.step);
    }
    const savedText = s.checkpoint ? (markedComplete ? 'Milestone marked complete' : 'Checkpoint saved') + ' on this computer · '
      + new Date(s.checkpoint.at).toLocaleString() + ' · ' + s.checkpoint.assistance + ' Coach help turns recorded.' : '';
    if ($('saved').textContent !== savedText) $('saved').textContent = savedText;
  });
  send('ready');
})();
