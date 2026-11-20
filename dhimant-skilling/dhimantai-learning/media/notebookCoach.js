(() => {
  const api = acquireVsCodeApi();
  window.installNotebookRuntime?.(api);
  const playback = window.installCoachAudio?.(api);
  const dictation = window.installDictation?.(api, document.getElementById('message'), () => playback?.listenForReply());
  const field = id => document.getElementById(id);
  const text = value => typeof value === 'string' && !/^(null|undefined)$/i.test(value.trim()) ? value : '';
  let revision, conversationId, busy = true;
  const composer = window.LearningComposer.bindComposer(field('composer'), async message => {
    if (busy) return;
    const activeRevision = revision, chat = conversationId;
    busy = true; composer.setAvailable(false);
    try {
      const files = message.attachments.length ? await attachments.encoded(false, message.attachments) : [];
      if (activeRevision !== revision || chat !== conversationId) return;
      api.postMessage({type:'ask', revision, message:message.text, ...(files.length ? {attachments:files} : {})});
    } catch (error) {
      if (activeRevision !== revision || chat !== conversationId) return;
      field('attachment-status').textContent = error.message;
      busy = false; composer.setAvailable(true);
    }
  });
  const {attachments} = composer;
  const rendered = new Map();
  const renderConversation = messages => {
    const log = field('conversation');
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    const ids = new Set(messages.map(message => message.id));
    for (const [id, row] of rendered) if (!ids.has(id)) { row.remove(); rendered.delete(id); }
    let added = false;
    for (const message of messages) {
      if (rendered.has(message.id)) continue;
      const row = document.createElement('article');
      const role = ['learner', 'tutor'].includes(message.role) ? message.role : 'status';
      row.className = 'msg ' + (role === 'tutor' ? 'coach' : role);
      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = role === 'learner' ? 'You' : role === 'tutor' ? 'Instructor' : 'Notice';
      row.append(label);
      if (text(message.context)) {
        const context = document.createElement('div');
        context.className = 'message-context plain-text';
        context.textContent = text(message.context);
        row.append(context);
      }
      const body = document.createElement('div');
      body.className = 'bubble ' + (role === 'tutor' ? 'markdown' : 'plain-text');
      if (role === 'tutor') body.innerHTML = window.CoachMarkdown.render(text(message.text));
      else body.textContent = text(message.text);
      row.append(body);
      if (role === 'tutor') {
        const note = document.createElement('small');
        note.className = 'muted';
        note.textContent = 'AI explanation · not a correctness check';
        row.append(note);
      }
      log.append(row); rendered.set(message.id, row); added = true;
    }
    field('empty-chat').hidden = messages.length > 0;
    field('new-chat').disabled = !messages.length;
    if (added && nearBottom) log.lastElementChild?.scrollIntoView?.({block: 'nearest'});
  };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'accepted') {
      if (data.revision === revision) {
        if (field('message').value === data.message) field('message').value = '';
        attachments.clear();
      }
      return;
    }
    if (data.type === 'audioOff') composer.cancelCapture();
    if (data.type) return;
    if (conversationId !== data.conversationId || revision !== data.revision) composer.cancelCapture();
    if (conversationId !== data.conversationId) {
      attachments.clear(); field('message').value = ''; field('prediction').value = '';
    } else if (revision !== data.revision) field('prediction').value = '';
    conversationId = data.conversationId;
    revision = data.revision;
    busy = data.busy;
    dictation?.setScope(data.canDictate && !busy ? conversationId : '');
    field('question').innerHTML = window.CoachMarkdown.render(text(data.question));
    field('turn-status').textContent = text(data.turnStatus);
    field('cell').textContent = text(data.cell) || 'Select a code cell.';
    field('run-status').textContent = text(data.runStatus);
    field('run-hint').textContent = text(data.runHint);
    field('kernel-help').hidden = !data.python;
    field('save-prediction').disabled = busy;
    renderConversation(Array.isArray(data.messages) ? data.messages : []);
    composer.setAvailable(!busy);
  });
  field('wrap-settings').addEventListener('click', () => api.postMessage({type: 'wrapSettings'}));
  field('new-chat').addEventListener('click', () => api.postMessage({type: 'newChat', revision, conversationId}));
  field('save-prediction').addEventListener('click', () =>
    api.postMessage({type: 'predict', revision, text: field('prediction').value}));
  api.postMessage({type: 'ready'});
})();
