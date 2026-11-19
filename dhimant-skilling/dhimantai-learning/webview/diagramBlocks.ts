/** Diagram source stays in the saved Markdown; only the displayed copy becomes an image. */
export type DiagramLanguage = 'mermaid' | 'graphviz';
type Engine = {render(language: DiagramLanguage, source: string): Promise<string>};
declare global { interface Window { DhimantDiagrams?: Engine } }

export function diagramLanguage(info: string, source: string): DiagramLanguage | undefined {
  const language = info.trim().toLowerCase().split(/\s+/)[0];
  if (language === 'mermaid') return 'mermaid';
  if (['dot', 'graphviz'].includes(language)) return 'graphviz';
  if (!['', 'text', 'plain', 'plaintext'].includes(language)) return;
  const text = source.trim().replace(/^(?:%%[^\n]*\n\s*)+/, '');
  if (/^(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR)\b/.test(text)
    || /^(?:sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline)\s*(?:\n|$)/.test(text)) return 'mermaid';
  if (/^(?:strict\s+)?(?:di)?graph\s*(?:"[^"\n]*"|[\w]+)?\s*\{/.test(text)) return 'graphviz';
}

export function diagramBlock(language: DiagramLanguage, source: string): string {
  const figure = document.createElement('figure');
  figure.className = 'text-diagram'; figure.dataset.diagramLanguage = language;
  figure.style.cssText = 'margin:12px 0;min-width:0;max-width:100%;overflow-wrap:anywhere';
  const status = document.createElement('p'); status.className = 'diagram-status';
  status.textContent = 'Loading diagram…'; status.setAttribute('role', 'status');
  const details = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
  summary.textContent = 'Diagram text'; code.className = 'diagram-source'; code.textContent = source;
  code.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box';
  details.append(summary, code); figure.append(status, details);
  return figure.outerHTML;
}

function showFailure(figure: HTMLElement, source: string) {
  figure.dataset.diagramState = 'failed';
  const status = figure.querySelector('.diagram-status')!;
  status.textContent = 'Diagram could not be drawn. Continue with the written explanation or read the diagram text below.';
  // Preserve authored labels without pretending to parse an invalid graph's relationships.
  const labels = [...source.matchAll(/\[\s*"([^"\n]+)"\s*\]|\blabel\s*=\s*"([^"\n]+)"/g)]
    .map(match => (match[1] || match[2]).replace(/<br\s*\/?\s*>|\\n/gi, ' — ').replace(/<[^>]*>/g, ''));
  if (labels.length) {
    const list = document.createElement('ul');
    for (const text of [...new Set(labels)]) { const item = document.createElement('li'); item.textContent = text; list.append(item); }
    status.after(list);
  }
}

/** Covers new replies, streamed replacements, expanded cards and restored notebooks. */
export function bindDiagramBlocks(root: HTMLElement, prepare: (root: HTMLElement) => void): () => void {
  let engine: Promise<Engine> | undefined, active = true;
  const load = () => engine ??= new Promise<Engine>((resolve, reject) => {
    if (window.DhimantDiagrams) { resolve(window.DhimantDiagrams); return; }
    const source = root.dataset.diagramRenderer;
    if (!source) { reject(new Error('Diagram renderer unavailable')); return; }
    const script = document.createElement('script'); script.src = source;
    script.onload = () => window.DhimantDiagrams ? resolve(window.DhimantDiagrams) : reject(new Error('Diagram renderer unavailable'));
    script.onerror = () => reject(new Error('Diagram renderer unavailable'));
    document.head.append(script);
  });
  // Mermaid measures text in a temporary DOM and must not render two charts at once.
  let queue = Promise.resolve();
  const scan = () => {
    for (const figure of root.querySelectorAll<HTMLElement>('.text-diagram:not([data-diagram-state])')) {
      figure.dataset.diagramState = 'pending';
      const source = figure.querySelector('.diagram-source')?.textContent ?? '';
      const language = figure.dataset.diagramLanguage as DiagramLanguage;
      queue = queue.then(async () => {
        if (!active || !root.contains(figure)) return;
        try {
          if (source.length > 30000) throw new Error('Diagram is too large');
          const markup = await (await load()).render(language, source);
          if (!active || !root.contains(figure)) return;
          const result = document.createElement('div'); result.innerHTML = markup;
          if (!result.querySelector('img.board-diagram')) throw new Error('Diagram could not be drawn');
          figure.replaceChildren(...Array.from(result.childNodes));
          figure.dataset.diagramState = 'rendered'; prepare(figure);
        } catch {
          if (active && root.contains(figure)) showFailure(figure, source);
        }
      });
    }
  };
  const observer = new MutationObserver(scan); observer.observe(root, {childList:true, subtree:true}); scan();
  return () => { active = false; observer.disconnect(); };
}
