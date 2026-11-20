(() => {
  const host = acquireVsCodeApi();
  const form = document.getElementById('composer'), field = form.querySelector('textarea');
  const dictation = window.installDictation(host, field);
  let busy = false, visible = true, generation = 0;
  function controls() {
    composer.setAvailable(visible && !busy);
    dictation.setScope(visible && !busy ? 'notebook' : '');
  }
  const composer = window.LearningComposer.bindComposer(form, async message => {
    if (busy || !visible) return;
    const turn = generation;
    busy = true; controls();
    try {
      const attachments = await composer.attachments.encoded(false, message.attachments);
      if (turn === generation) host.postMessage({type:'ask', text:message.text, attachments});
    } catch (error) {
      if (turn !== generation) return;
      document.getElementById('attachment-status').textContent = error.message;
      busy = false; controls();
    }
  });
  window.addEventListener('message', ({data}) => {
    if (data.type === 'visibility') {
      visible = data.visible;
      if (!visible) { generation++; busy = false; }
    }
    else if (data.type === 'attachmentError') {
      busy = false; document.getElementById('attachment-status').textContent = data.text;
    } else return;
    controls();
  });
  controls(); field.focus();
})();
