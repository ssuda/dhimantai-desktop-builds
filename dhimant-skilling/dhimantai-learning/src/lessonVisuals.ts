/** Keep figures in their original history card instead of copying them into every reply. */
// Match ordinary code fences too, so image/SVG literals inside runnable code
// never become figures or get removed from the learner's program.
const figures = /(`{3,}|~{3,})([^\n]*)\n[\s\S]*?\n\1[ \t]*(?=\n|$)|(`+)[^\n]*?\3|(?:<\?xml\b[^?]*\?>\s*)?<svg\b[\s\S]*?<\/svg>|!\[(?:\\.|[^\]\\])*\]\((?:\\.|[^()\\\n]|\((?:\\.|[^()\\\n])*\))*\)/gi;
const visual = (block:string) => {
  const fence=block.match(/^(`{3,}|~{3,})([^\n]*)\n/);
  return fence ? /^(?:svg|mermaid|dot|graphviz)\s*$/i.test(fence[2])
    || (/^(?:xml)?\s*$/i.test(fence[2]) && /<svg\b/i.test(block)) : !block.startsWith('`');
};
const key = (figure:string) => {
  // Captions, optional titles and angle brackets do not change the loaded image.
  // Retain the full URL query/hash: it may select a different version or crop.
  const image=figure.match(/^!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>\n]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^()\\])*\))+))/);
  if(image) {
    const source=(image[1] ?? image[2]).replace(/\\([\\()[\]<>])/g,'$1');
    try {return 'image:'+new URL(source).href;} catch {return 'image:'+source;}
  }
  const fence=figure.match(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1[ \t]*$/);
  const body=(fence ? fence[3] : figure).trim();
  const svg=body.match(/^(?:<\?xml\b[^?]*\?>\s*)?(<svg\b[\s\S]*<\/svg>)$/i);
  if(svg)return 'svg:'+svg[1].replace(/>\s+</g,'><');
  return (fence ? fence[2].trim().toLowerCase().replace(/^dot$/,'graphviz')+':' : '')+body;
};
export function freshTeachingVisuals(content:string, history:string[], repeat=false):string {
  const seen=new Set((repeat ? [] : history).flatMap(text=>text.match(figures) ?? []).filter(visual).map(key));
  return content.replace(figures, figure => {
    if (!visual(figure)) return figure;
    const id=key(figure);
    if (seen.has(id)) return '';
    seen.add(id); return figure;
  });
}
export const requestedVisual = (text:string) => /\b(?:diagram|figure|image|visual|flowchart|picture)\b|चित्र|आकृति|आकृती|బొమ్మ|చిత్ర|வரைபட|படம்|ಚಿತ್ರ|ചിത്ര|চিত্র|ચિત્ર|تصویر/i.test(text);
