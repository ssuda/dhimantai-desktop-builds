import type { StudyDocument } from './studyContent';

/** Fetch only the authorized book asset, without forwarding learner credentials. */
export async function downloadStudyDocument(document: StudyDocument, signal: AbortSignal, serviceUrl: string): Promise<Buffer> {
  const url = new URL(document.url), service = new URL(serviceUrl);
  const localFixture = url.origin === service.origin && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!['pdf', 'epub'].includes(document.format)) || (url.protocol !== 'https:' && !localFixture) || url.username || url.password) {
    throw new Error('This chapter has no supported PDF or EPUB. Refresh Study to choose another chapter.');
  }
  const response = await fetch(url, {signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), credentials:'omit'});
  const limit = 64 * 1024 * 1024;
  if (!response.ok || !response.body) throw new Error('The PDF or EPUB could not be loaded. Select the chapter to retry.');
  const reader = response.body.getReader(), parts: Buffer[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('This book exceeds the 64 MB Study limit.');
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('This book exceeds the 64 MB Study limit.');
      parts.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(parts);
  if (document.format === 'pdf' ? !bytes.subarray(0,1024).includes(Buffer.from('%PDF-')) : bytes.subarray(0,4).toString('hex') !== '504b0304') {
    throw new Error('The chapter file is not a readable ' + document.format.toUpperCase() + '. Choose another chapter.');
  }
  return bytes;
}
