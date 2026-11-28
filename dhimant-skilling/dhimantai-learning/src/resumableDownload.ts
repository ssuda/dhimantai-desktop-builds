import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

export class DownloadError extends Error {}
type RequestBody = (headers: Record<string, string>) => Promise<Response>;
interface Download {
  directory: string;
  sha256: string;
  maxBytes: number;
  expectedBytes?: number;
  signal: AbortSignal;
  request: RequestBody;
  progress(percent: number): void;
  activity?(): void;
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function ownerExited(pid: number) {
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Each window writes its own file. Rename claims a paused file (pid 0), or one
// left by a terminated extension host, without racing another writer.
async function claimPartial(directory: string, sha: string, destination: string) {
  await mkdir(directory, { recursive: true });
  const candidates: { path: string; size: number }[] = [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const part = /^\.update-([a-f0-9]{64})-[a-f0-9-]{36}\.(\d+)\.part$/.exec(entry.name);
    if (!part || !ownerExited(Number(part[2]))) continue;
    const path = join(directory, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    if (part[1] === sha) candidates.push({ path, size: info.size });
    else if (info.mtimeMs < weekAgo) await rm(path, { force: true });
  }
  for (const candidate of candidates.sort((a, b) => b.size - a.size)) {
    try {
      await rename(candidate.path, destination);
      return candidate.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return 0;
}

function byteRange(response: Response, offset: number, options: Download) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (!match || Number(match[1]) !== offset) return;
  const end = Number(match[2]) + 1, total = Number(match[3]);
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  if (end <= offset || end > total || total > options.maxBytes ||
      (options.expectedBytes !== undefined && total !== options.expectedBytes) ||
      (encoding && encoding !== 'identity') || (length !== null && Number(length) !== end - offset)) return;
  return { end, total };
}

/** Provide a private file to the installer only after verifying the entire release. */
export async function withVerifiedDownload<T>(options: Download, use: (path: string) => Promise<T>): Promise<T> {
  const { directory, sha256, expectedBytes, maxBytes, signal } = options;
  const base = join(directory, `.update-${sha256}-${randomUUID()}`);
  const path = `${base}.${process.pid}.part`;
  let size = await claimPartial(directory, sha256, path);
  let keep = true;
  let lastProgress = -1;
  let restarted = false;
  const progress = (total: number | undefined) => {
    if (!total) return;
    const value = Math.floor(100 * size / total);
    if (value !== lastProgress) {
      lastProgress = value;
      options.progress(value);
    }
  };
  try {
    signal.throwIfAborted();
    if (size > 0 && (!expectedBytes || size >= expectedBytes)) {
      if (size <= maxBytes && (!expectedBytes || size === expectedBytes) && await digest(path) === sha256) {
        signal.throwIfAborted();
        const result = await use(path);
        keep = false;
        return result;
      }
      if (size >= (expectedBytes ?? maxBytes)) {
        await truncate(path, 0);
        size = 0;
      }
    }
    for (;;) {
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
      if (size) headers.Range = `bytes=${size}-`;
      const response = await options.request(headers);
      options.activity?.();
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      const range = response.status === 206 ? byteRange(response, size, options) : undefined;
      let total = expectedBytes;
      if (range) {
        total = range.total;
      } else if (response.status === 206 || response.status === 416) {
        await response.body?.cancel();
        if (!size || restarted) throw new DownloadError('The server returned an invalid download range.');
        await truncate(path, 0);
        size = 0;
        restarted = true;
        continue;
      } else if (response.status === 200) {
        // A server can ignore Range and send the whole file.
        size = 0;
        if (!encoding || encoding === 'identity') {
          if (length !== null && Number(length) > maxBytes) {
            await response.body?.cancel();
            throw new DownloadError('The update file is too large.');
          }
          total ??= length !== null ? Number(length) : undefined;
        }
      } else {
        await response.body?.cancel();
        throw new DownloadError('The download was interrupted. Retry the update.');
      }
      if (!response.body) throw new DownloadError('The server returned an empty update.');
      const file = await open(path, size ? 'a' : 'w', 0o600);
      const reader = response.body.getReader();
      try {
        if (size) progress(total);
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          options.activity?.();
          if (size + value.length > (range?.end ?? total ?? maxBytes) || size + value.length > maxBytes) {
            keep = false;
            throw new DownloadError('The update file is too large.');
          }
          await file.writeFile(value);
          size += value.length;
          progress(total);
        }
      } finally {
        await file.close();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      signal.throwIfAborted();
      if (range && size === range.end && size < range.total) continue;
      if ((total !== undefined && size !== total) || !size) throw new DownloadError('The download was interrupted. Retry to continue.');
      if (await digest(path) !== sha256) {
        keep = false;
        throw new DownloadError('The download did not match the verified release. Retry the update.');
      }
      signal.throwIfAborted();
      const result = await use(path);
      keep = false;
      return result;
    }
  } finally {
    if (keep && size) await rename(path, `${base}.0.part`);
    else await rm(path, { force: true });
  }
}
