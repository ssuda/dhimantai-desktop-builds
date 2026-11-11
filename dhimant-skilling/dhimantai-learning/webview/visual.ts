/** Keep the complete figure beside its explanation, including portrait diagrams. */
export const visualStyle = 'display:block;width:auto;height:auto;max-width:min(100%,720px);max-height:min(440px,55vh);object-fit:contain;box-sizing:border-box;margin:12px 0';

export function imageSource(value: unknown): string | undefined {
  // Leave room for an escaped caption inside the notebook's 100,000-character cell limit.
  if (typeof value !== 'string' || value.length > 96000) return;
  const source = value.trim();
  // Only passive image sources. Never resolve local files or application commands.
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(source)) return source.replace(/\s/g, '');
  if (!/^https:\/\//i.test(source) || source.length > 16000) return;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* malformed image source */ }
}

export function imageMarkup(source: unknown, label = 'Textbook figure'): string {
  const url = imageSource(source);
  if (!url) {
    const fallback = document.createElement('span'); fallback.textContent = label;
    return fallback.outerHTML;
  }
  const image = document.createElement('img');
  image.className = 'board-image'; image.src = url; image.alt = label || 'Textbook figure';
  image.setAttribute('referrerpolicy', 'no-referrer'); image.style.cssText = visualStyle;
  return image.outerHTML;
}

/** Markdown keeps original figures usable when the notebook is exported to Jupyter. */
export function imageMarkdown(source: string, label: string): string {
  const alt = label.replace(/[\r\n]+/g, ' ').replace(/[\\[\]]/g, '\\$&');
  return `![${alt}](<${source}>)`;
}

/** Enlarge the existing visual itself; no second toolbar or duplicate figure. */
export function bindVisuals(root: HTMLElement, failed: () => void): () => void {
  let dialog: HTMLDialogElement | undefined;
  const selector = 'img.board-diagram, img.board-image';
  const open = (image: HTMLImageElement) => {
    dialog?.close();
    const viewer = document.createElement('dialog'), close = document.createElement('button');
    viewer.className = 'visual-viewer'; viewer.setAttribute('aria-label', image.alt || 'Figure');
    close.type = 'button'; close.textContent = 'Close'; close.onclick = () => viewer.close();
    const full = image.cloneNode() as HTMLImageElement;
    full.removeAttribute('tabindex'); full.removeAttribute('role'); full.removeAttribute('title'); full.removeAttribute('aria-label');
    full.style.cssText = 'display:block;width:auto;height:auto;max-width:calc(100vw - 64px);max-height:calc(100vh - 130px);object-fit:contain;margin:12px auto;background:white';
    viewer.append(close, full); document.body.append(viewer); dialog = viewer;
    viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
    viewer.addEventListener('close', () => { viewer.remove(); if (dialog === viewer) dialog = undefined; if (image.isConnected) image.focus(); }, {once:true});
    viewer.showModal();
  };
  root.addEventListener('click', event => {
    if (event.target instanceof HTMLImageElement && event.target.matches(selector)) open(event.target);
  });
  root.addEventListener('keydown', event => {
    if (event.target instanceof HTMLImageElement && event.target.matches(selector) && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); open(event.target);
    }
  });
  root.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches(selector)) return;
    const fallback = document.createElement('span'); fallback.className = 'diagram-unavailable';
    fallback.textContent = `Image unavailable${image.alt ? ': ' + image.alt : ''}. Continue with the written explanation.`;
    image.replaceWith(fallback); failed();
  }, true);
  return () => dialog?.close();
}

export function prepareVisuals(root: HTMLElement) {
  for (const image of root.querySelectorAll<HTMLImageElement>('img.board-diagram, img.board-image')) {
    image.tabIndex = 0; image.setAttribute('role', 'button');
    image.title = 'Enlarge figure'; image.setAttribute('aria-label', 'Enlarge figure: ' + image.alt);
  }
}
