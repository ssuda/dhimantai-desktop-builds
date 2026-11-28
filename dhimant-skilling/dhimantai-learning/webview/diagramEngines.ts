import mermaid from 'mermaid';
import { instance } from '@viz-js/viz';
import { diagram } from './diagram';
import type { DiagramLanguage } from './diagramBlocks';

// Bundled with the extension and loaded on the first diagram, including offline.
// Keep labels as SVG text so they pass through our existing passive-image sanitizer.
mermaid.initialize({startOnLoad:false, securityLevel:'strict', htmlLabels:false,
  suppressErrorRendering:true, maxTextSize:30000, maxEdges:500, theme:'default',
  flowchart:{htmlLabels:false, useMaxWidth:false, wrappingWidth:240, nodeSpacing:48, rankSpacing:56, padding:14, curve:'linear'},
  secure:['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels',
    'flowchart', 'theme', 'themeCSS', 'fontFamily', 'suppressErrorRendering']});
let graphviz: ReturnType<typeof instance> | undefined, sequence = 0;

export async function render(language: DiagramLanguage, source: string): Promise<string> {
  if (language === 'graphviz') {
    graphviz ??= instance();
    return diagram((await graphviz).renderString(source, {format:'svg', engine:'dot'}), 'automatic');
  }
  // Instructor content supplies diagram data, never renderer settings or external assets.
  source = source.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '');
  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:-100000px;top:0;width:1200px;visibility:hidden;pointer-events:none';
  stage.setAttribute('aria-hidden', 'true'); document.body.append(stage);
  try {
    const {svg} = await mermaid.render('notebook-diagram-' + ++sequence, source, stage);
    // Mermaid uses a scoped stylesheet for labels, arrows and node colors. Resolve
    // it in an isolated shadow tree, then copy only static paint/text properties.
    const shadow = stage.attachShadow({mode:'closed'}); shadow.innerHTML = svg;
    const root = shadow.querySelector('svg')!;
    const properties = ['fill','stroke','stroke-width','stroke-dasharray','opacity','fill-opacity','stroke-opacity',
      'font-size','font-family','font-weight','font-style','text-anchor','dominant-baseline'];
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(element);
      for (const name of properties) {
        const value = style.getPropertyValue(name);
        if (value) element.setAttribute(name, value);
      }
    }
    return diagram(new XMLSerializer().serializeToString(root), 'automatic');
  } finally { stage.remove(); }
}
