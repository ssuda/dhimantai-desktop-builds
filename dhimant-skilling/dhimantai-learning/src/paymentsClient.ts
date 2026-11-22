declare const acquireVsCodeApi: () => {
  postMessage(message: unknown): void;
  getState(): any;
  setState(value: unknown): void;
};

/** Inlined into the payments webview using the page's CSP nonce. */
export function paymentsClient() {
  const vscode = acquireVsCodeApi();
  const scope = document.querySelector<HTMLElement>('main')!.dataset.scope;
  const saved = vscode.getState();
  const state = saved?.scope === scope ? saved : {scope};
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const rows = [...document.querySelectorAll<HTMLTableRowElement>('tr[data-group]')];
  const checkoutButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-action=resume],[data-action=refresh]')];
  const message = document.getElementById('status-message')!;
  const select = (tab: HTMLButtonElement) => {
    const filter = tab.dataset.filter!;
    for (const other of tabs) {
      other.setAttribute('aria-selected', String(other === tab));
      other.tabIndex = other === tab ? 0 : -1;
    }
    const panel = document.getElementById('history')!;
    panel.setAttribute('aria-labelledby', tab.id);
    rows.forEach(row => { row.hidden = filter !== 'all' && row.dataset.group !== filter; });
    const empty = rows.every(row => row.hidden);
    panel.querySelector('table')!.hidden = empty;
    document.getElementById('payment-empty')!.hidden = !empty;
    if (empty) document.getElementById('payment-empty')!.textContent = filter === 'all' ? 'No purchases yet.'
      : 'No ' + tab.textContent!.toLowerCase() + ' purchases.';
    state.paymentFilter = filter;
    vscode.setState(state);
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const next: Record<string, number> = {ArrowLeft:(index + tabs.length - 1) % tabs.length,
        ArrowRight:(index + 1) % tabs.length, Home:0, End:tabs.length - 1};
      if (!(event.key in next)) return;
      event.preventDefault();
      const target = tabs[next[event.key]];
      target.focus();
      select(target);
    });
  }
  if (tabs.length) select(tabs.find(tab => tab.dataset.filter === state.paymentFilter) ?? tabs[0]);
  document.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-details')) {
      (document.getElementById(button.getAttribute('aria-controls')!) as HTMLDialogElement).showModal();
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === 'resume' || action === 'refresh') {
      checkoutButtons.forEach(b => { b.disabled = true; });
      message.textContent = action === 'resume' ? 'Opening secure checkout…' : 'Refreshing payments and course access…';
      if (action === 'refresh') {
        state.focusPaymentRefresh = true;
        vscode.setState(state);
      }
    }
    vscode.postMessage({type:action, id:button.dataset.id});
  });
  if (state.focusPaymentRefresh) {
    document.querySelector<HTMLButtonElement>('[data-action=refresh]')?.focus();
    delete state.focusPaymentRefresh;
    vscode.setState(state);
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'receiptDownload' && event.data.scope === scope) {
      const url = URL.createObjectURL(new Blob([event.data.bytes], {type: 'application/pdf'}));
      const link = document.createElement('a');
      link.download = 'dhimantAI-receipt-' + event.data.id + '.pdf';
      link.href = url;
      link.click();
      message.textContent = 'Receipt download started.';
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return;
    }
    if (event.data?.type !== 'catalogStatus') return;
    message.textContent = event.data.message;
    checkoutButtons.forEach(button => { button.disabled = !!event.data.busy; });
  });
}
