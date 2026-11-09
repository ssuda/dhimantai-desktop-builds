window.installNotebookRuntime = api => {
  const select = document.getElementById('runtime');
  const create = document.getElementById('new-notebook');
  if (!select || !create) return;
  let uri;
  window.addEventListener('message', ({data}) => {
    if (data.type !== 'runtimeState') return;
    uri = data.uri;
    select.disabled = data.busy || (!uri && !data.podman);
    create.disabled = data.busy;
    for (const value of ['terminal', 'setup']) {
      const option = select.querySelector(`[value="${value}"]`);
      if (option) option.disabled = !data.podman;
    }
    select.querySelector('[value="colab"]').disabled = !data.colab;
    select.querySelector('[value="podman"]').disabled = !data.podman;
    select.querySelector('[value="podman"]').textContent = data.podman ? 'Course container' : 'Course container · setup needed';
    select.querySelector('[value="colab"]').textContent = data.colab ? 'Google Colab · remote Python' : 'Google Colab · Python notebooks only';
    document.getElementById('runtime-target').textContent = data.name
      ? `${data.name} · The selected kernel is shown in the notebook toolbar.` : 'Choose a course to prepare its workstation or open its terminal. Source files use Run code.';
    document.getElementById('runtime-status').textContent = data.status || (uri
      ? 'Kernel readiness is not verified here. Select a kernel in the notebook toolbar, then run a cell.' : 'No notebook selected.');
  });
  select.addEventListener('change', () => {
    if (!select.value || select.disabled) return;
    api.postMessage({type: 'runtime', uri, runtime: select.value});
    // This is an action picker: choosing a provider has not connected a kernel yet.
    select.value = '';
  });
  create.addEventListener('click', () => api.postMessage({type: 'newNotebook'}));
};
