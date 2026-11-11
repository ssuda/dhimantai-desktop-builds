// Pure mapping between notebook cells and the mirror file that official language extensions analyse.

export const MIRRORED = ['rust', 'go', 'java', 'c', 'javascript', 'typescript', 'sql', 'shellscript'] as const;
export type MirroredLanguage = typeof MIRRORED[number];

export interface Segment { cell: string; start: number; lines: number }
export interface Layout { text: string; segments: Segment[] }

/** Cells joined by one blank line, remembering where each cell starts. */
export function layout(cells: {uri: string; text: string}[]): Layout {
  const segments: Segment[] = [], parts: string[] = [];
  let line = 0;
  for (const cell of cells) {
    const lines = cell.text.split('\n').length;
    segments.push({cell: cell.uri, start: line, lines});
    parts.push(cell.text);
    line += lines + 1;
  }
  return {text: parts.join('\n\n') + '\n', segments};
}

/** A mirror line, as (cell, line) — or the nearest cell when it is a separator line. */
export function toCell(segments: Segment[], line: number): {cell: string; line: number} | undefined {
  if (!segments.length) return;
  const inside = segments.find(s => line >= s.start && line < s.start + s.lines);
  if (inside) return {cell: inside.cell, line: line - inside.start};
  const before = [...segments].reverse().find(s => s.start <= line) ?? segments[0];
  return {cell: before.cell, line: Math.max(0, Math.min(before.lines - 1, line - before.start))};
}

export function toMirror(segments: Segment[], cell: string, line: number): number | undefined {
  const segment = segments.find(s => s.cell === cell);
  return segment && segment.start + line;
}

/** The files a language server needs to treat the mirror as a normal project, relative to its folder. */
export function scaffold(language: MirroredLanguage, text: string): {main: string; files: Record<string, string>} {
  switch (language) {
    case 'rust': return {main: 'src/main.rs', files: {'Cargo.toml': '[package]\nname = "practice"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n'}};
    case 'go': return {main: 'main.go', files: {'go.mod': 'module practice\n\ngo 1.21\n'}};
    // Java requires a public class to live in a file of the same name.
    case 'java': return {main: (/\bpublic\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)/.exec(text)?.[1] ?? 'Main') + '.java', files: {}};
    case 'c': return {main: 'main.c', files: {}};
    case 'shellscript': return {main:'main.sh',files:{}};
    case 'sql': return {main: 'main.sql', files: {}};
    case 'javascript': return {main: 'main.js', files: {}};
    case 'typescript': return {main: 'main.ts', files: {'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"es2022","module":"commonjs"}}\n'}};
  }
}
