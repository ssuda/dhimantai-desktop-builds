import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function run(file: string, args: string[], timeout = 20000) {
  return (await execute(file, args, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout.trim();
}

export async function stream(file: string, args: string[], log: (s: string) => void, cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const output = (data: Buffer) => {
      const s = data.toString();
      tail = (tail + s).slice(-1200);
      log(s);
    };
    p.stdout.on('data', output);
    p.stderr.on('data', output);
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} exited with ${code}. ${tail.trim()}`))
    );
  });
}

export async function findPodman() {
  const candidates = ['podman'];
  if (process.platform === 'darwin')
    candidates.push('/opt/podman/bin/podman', '/opt/homebrew/bin/podman', '/usr/local/bin/podman');
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env.LOCALAPPDATA]) {
      if (root)
        candidates.push(
          join(root, 'Podman', 'podman.exe'),
          join(root, 'RedHat', 'Podman', 'podman.exe'),
          join(root, 'Programs', 'Podman', 'podman.exe')
        );
    }
  }
  for (const bin of candidates) {
    try {
      if (/podman version (\d+)/i.test(await run(bin, ['--version']))) return bin;
    } catch {
      /* next location */
    }
  }
}

export function desktopAsset(platform: string, arch: string) {
  const suffix = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
  if (!suffix || !['darwin', 'win32'].includes(platform))
    throw new Error('No Podman desktop installer for this platform.');
  return platform === 'darwin' ? `podman-installer-macos-${suffix}.pkg` : `podman-installer-windows-${suffix}.msi`;
}

const releaseRepo = 'podman-container-tools/podman';

export function officialInstallerUrl(url: string, filename: string) {
  const tag = url.split('/').at(-2);
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) return false;
  return [releaseRepo, 'containers/podman'].some(repo =>
    url === `https://github.com/${repo}/releases/download/${tag}/${filename}`);
}

async function desktopInstaller(report: (s: string) => void, log: (s: string) => void) {
  report('Finding the official Podman installer');
  const filename = desktopAsset(process.platform, process.arch);
  // Pin the supplier and require GitHub's release-asset digest before invoking an OS installer.
  const api = `https://api.github.com/repos/${releaseRepo}/releases`;
  const response = await fetch(api + '/latest', {
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'dhimantAI-Learning' }
  });
  if (!response.ok) throw new Error('Could not retrieve the official Podman release. Retry course setup.');
  let release = (await response.json()) as {
    assets: { name: string; digest?: string; browser_download_url: string; size: number }[];
  };
  let asset = release.assets.find((a) => a.name === filename);
  if (!asset && process.platform === 'darwin' && process.arch === 'x64') {
    const lastIntel = await fetch(api + '/tags/v5.8.1', { signal: AbortSignal.timeout(30000) });
    if (lastIntel.ok) {
      release = (await lastIntel.json()) as typeof release;
      asset = release.assets.find((a) => a.name === filename);
    }
  }
  if (
    !asset ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') ||
    !officialInstallerUrl(asset.browser_download_url, filename) ||
    !asset.size ||
    asset.size > 350_000_000
  )
    throw new Error('A verified Podman installer is unavailable for this computer.');
  report(`Downloading Podman (${Math.ceil(asset.size / 1_000_000)} MB)`);
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600000) });
  if (!download.ok) throw new Error('Could not download Podman. Retry course setup.');
  const bytes = Buffer.from(await download.arrayBuffer());
  report('Verifying the Podman download');
  if (bytes.length !== asset.size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.digest)
    throw new Error('Podman installer verification failed. Retry the download.');
  const dir = await mkdtemp(join(tmpdir(), 'dhimantai-podman-'));
  try {
    const path = join(dir, filename);
    await writeFile(path, bytes);
    report('Installing Podman. Follow the operating-system installation prompts.');
    if (process.platform === 'darwin') {
      await run('/usr/sbin/pkgutil', ['--check-signature', path]);
      log('Complete the macOS Podman installer.\n');
      await stream('/usr/bin/open', ['-W', '-n', '-a', 'Installer', path], log);
    } else {
      try {
        await stream('msiexec.exe', ['/i', path, '/passive', '/norestart'], log);
      } catch (error) {
        if (/exited with 3010\b/.test(String(error)))
          throw new Error('Restart Windows to finish installing Podman, then select the course again.');
        throw error;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Elevate = (file: string, args: string[]) => Promise<void>;
async function linuxInstaller(log: (s: string) => void, elevate: Elevate) {
  const options = [
    ['/usr/bin/apt-get', ['update'], ['install', '-y', 'podman', 'uidmap', 'slirp4netns']],
    ['/usr/bin/dnf', ['install', '-y', 'podman']],
    ['/usr/bin/zypper', ['--non-interactive', 'install', 'podman']],
    ['/usr/bin/pacman', ['-S', '--needed', '--noconfirm', 'podman']]
  ] as [string, ...string[][]][];
  for (const [manager, ...steps] of options) {
    try {
      await access(manager);
    } catch {
      continue;
    }
    for (const args of steps) {
      if (process.getuid?.() === 0) await stream(manager, args, log);
      else if (
        await access('/usr/bin/pkexec').then(
          () => true,
          () => false
        )
      )
        await stream('/usr/bin/pkexec', [manager, ...args], log);
      else await elevate(manager, args);
    }
    return;
  }
  throw new Error('This Linux distribution needs a Podman package manager supported by dhimantAI.');
}

interface Connection {
  Name: string;
  URI: string;
  Default: boolean;
}
export function requireLocalConnection(address: string) {
  const uri = new URL(address);
  if (['unix:', 'npipe:'].includes(uri.protocol) && (!uri.hostname || uri.hostname === '.')) return;
  if (
    ['ssh:', 'tcp:', 'http:', 'https:'].includes(uri.protocol) &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname)
  )
    return;
  throw new Error('Select a local Podman connection before opening a course.');
}

interface Machine {
  Name: string;
  Running: boolean;
  Starting?: boolean;
  Default?: boolean;
}
export function machineSetup(machines: Machine[]): string[][] {
  if (machines.some((machine) => machine.Running || machine.Starting)) return [];
  const machine = machines.find((candidate) => candidate.Default) ?? machines[0];
  if (machine) return [['machine', 'start', machine.Name]];
  // A learning machine stays small: two CPUs, 2 GB of memory and a 30 GB disk image (sparse on disk).
  return [
    ['machine', 'init', '--cpus', '2', '--memory', '2048', '--disk-size', '30', 'podman-machine-default'],
    ['machine', 'start', 'podman-machine-default']
  ];
}

/** The Podman machine this extension started in this session, if any; only that one is stopped on exit. */
let startedMachine: string | undefined;

/** Stop course containers, and the machine only when dhimantAI started it, so nothing keeps running after VS Code closes. */
export async function stopCourseRuntime(bin: string, containers: string[]) {
  if (containers.length) await run(bin, ['stop', '--time', '2', ...containers]).catch(() => undefined);
  if (startedMachine) {
    const others = await run(bin, ['ps', '--quiet']).catch(() => 'unknown');
    // Leave the machine alone while anything else is still running in it.
    if (!others.trim()) await run(bin, ['machine', 'stop', startedMachine]).catch(() => undefined);
  }
}

export async function ensurePodman(report: (s: string) => void, log: (s: string) => void, elevate: Elevate) {
  let bin = await findPodman();
  if (!bin) {
    report('Installing Podman. Follow any operating-system approval prompt.');
    if (process.platform === 'linux') await linuxInstaller(log, elevate);
    else await desktopInstaller(report, log);
    bin = await findPodman();
    if (!bin) throw new Error('Podman installation did not finish. Select the course again to retry.');
  }
  const version = (await run(bin, ['--version'])).match(/version (\d+)/i);
  if (!version || Number(version[1]) < 4)
    throw new Error('Course runtimes require Podman 4 or newer. Update Podman and retry.');
  if (process.env.CONTAINER_HOST) requireLocalConnection(process.env.CONTAINER_HOST);
  else if (process.platform !== 'linux' || process.env.CONTAINER_CONNECTION) {
    const connections = JSON.parse(await run(bin, ['system', 'connection', 'list', '--format', 'json'])) as
      | Connection[]
      | null;
    const selected = (connections ?? []).find((c) =>
      process.env.CONTAINER_CONNECTION ? c.Name === process.env.CONTAINER_CONNECTION : c.Default
    );
    if (selected) requireLocalConnection(selected.URI);
  }
  try {
    await run(bin, ['info', '--format', '{{.Host.Arch}}']);
    return bin;
  } catch (error) {
    if (process.platform === 'linux') throw error;
  }
  report('Starting the Podman virtual machine');
  const machines = JSON.parse(await run(bin, ['machine', 'list', '--format', 'json'])) as Machine[] | null;
  for (const args of machineSetup(machines ?? [])) {
    await stream(bin, args, log);
    if (args[1] === 'start') startedMachine = args[2];
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await run(bin, ['info', '--format', '{{.Host.Arch}}']);
      return bin;
    } catch (error) {
      if (attempt === 14) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
