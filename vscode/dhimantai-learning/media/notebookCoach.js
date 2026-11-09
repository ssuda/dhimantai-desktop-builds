(() => {
  const api = acquireVsCodeApi();
  window.installNotebookRuntime?.(api);
  window.installCoachAudio?.(api);
  const field = id => document.getElementById(id);
  const text = value => typeof value === 'string' && !/^(null|undefined)$/i.test(value.trim()) ? value : '';
  let revision, conversationId, busy = true;
  const resizeMessage = () => {
    const box = field('message');
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 100) + 'px';
    field('ask').disabled = busy || !box.value.trim();
  };
  field('message').addEventListener('input', resizeMessage);
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
      if (data.revision === revision && field('message').value === data.message) { field('message').value = ''; resizeMessage(); }
      return;
    }
    if (data.type) return;
    if (conversationId !== data.conversationId) {
      field('message').value = ''; field('prediction').value = '';
    } else if (revision !== data.revision) field('prediction').value = '';
    conversationId = data.conversationId;
    revision = data.revision;
    busy = data.busy;
    field('question').innerHTML = window.CoachMarkdown.render(text(data.question));
    field('turn-status').textContent = text(data.turnStatus);
    field('cell').textContent = text(data.cell) || 'Select a code cell.';
    field('run-status').textContent = text(data.runStatus);
    field('run-hint').textContent = text(data.runHint);
    field('kernel-help').hidden = !data.python;
    field('save-prediction').disabled = busy;
    renderConversation(Array.isArray(data.messages) ? data.messages : []);
    resizeMessage();
  });
  field('wrap-settings').addEventListener('click', () => api.postMessage({type: 'wrapSettings'}));
  field('new-chat').addEventListener('click', () => api.postMessage({type: 'newChat', revision, conversationId}));
  field('save-prediction').addEventListener('click', () =>
    api.postMessage({type: 'predict', revision, text: field('prediction').value}));
  const send = () => {
    if (busy || !field('message').value.trim()) return;
    busy = true; resizeMessage();
    api.postMessage({type: 'ask', revision, message: field('message').value});
  };
  field('ask').addEventListener('click', send);
  field('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  api.postMessage({type: 'ready'});
})();
