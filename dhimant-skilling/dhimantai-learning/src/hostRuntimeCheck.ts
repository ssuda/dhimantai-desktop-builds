import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** A tunnel or SSH alias may lead back to this machine. Check from the selected runtime. */
export async function withHostMarker<T>(check: (paths: string[], bootHash?: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dhimantai-host-'));
  try {
    const paths = [directory];
    const drive = /^([a-z]):[\\/](.*)$/i.exec(directory);
    if (drive) paths.push('/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replaceAll('\\', '/'));
    // Linux services may have a private /tmp even on the same host.
    const bootHash = process.platform === 'linux'
      ? createHash('sha256').update(await readFile('/proc/sys/kernel/random/boot_id')).digest('hex') : undefined;
    return await check(paths, bootHash);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
