import { readFile, stat } from 'fs/promises';
import { basename, extname } from 'path';

/** A photo or PDF sent with a Practice question. The server reads it into text for Instructor; nothing is stored. */
export interface PracticeAttachment { name: string; type: string; data: string }

// Match agent/course_projects/attachment_reader.py: the API takes 4 MB bodies and base64 adds a third.
export const MAX_FILES = 4;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL = 2816 * 1024;
export const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'pdf'];
const TYPES: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf'};

/** Checks and encodes the chosen files; throws a message the learner can act on. */
export async function loadAttachments(paths: string[], read = readFile, size = async (path: string) => (await stat(path)).size) {
  if (paths.length > MAX_FILES) throw new Error(`Attach up to ${MAX_FILES} photos or PDFs.`);
  let total = 0;
  const files: PracticeAttachment[] = [];
  for (const path of paths) {
    const name = basename(path).slice(0, 120), type = TYPES[extname(path).toLowerCase()];
    if (!type) throw new Error(`${name}: attach PNG, JPEG or WebP photos, or PDF files.`);
    const bytes = await size(path);
    if (!bytes || bytes > MAX_BYTES) throw new Error(`${name} must be under 2 MB. Attach a screenshot or a smaller photo.`);
    total += bytes;
    if (total > MAX_TOTAL) throw new Error('Attachments must be under 2.75 MB in total. Attach fewer or smaller files.');
    files.push({name, type, data: Buffer.from(await read(path)).toString('base64')});
  }
  return files;
}

export const attachmentNote = (files: PracticeAttachment[]) =>
  files.length ? 'Attached: ' + files.map(f => f.name).join(', ') : '';

/** Attachments a webview sent, kept only when each one has the shape and limits the server accepts. */
export function practiceAttachments(value: unknown): PracticeAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) return [];
  const files = value.filter((f: any) => f && typeof f.name === 'string' && f.name && f.name.length <= 120
    && Object.values(TYPES).includes(f.type) && typeof f.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(f.data))
    .map((f: any) => ({name: f.name, type: f.type, data: f.data}));
  const bytes = files.reduce((sum, f) => sum + Math.floor(f.data.length * 3 / 4), 0);
  return files.length === value.length && bytes <= MAX_TOTAL && files.every(f => f.data.length * 3 / 4 <= MAX_BYTES) ? files : [];
}
