import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function resourceLimitError(detail: string, platform: string = process.platform): Error | undefined {
  if (!/memory\.max|controller [`'"]?(?:memory|cpu|pids)[`'"]? is not available/i.test(detail)) return;
  return new Error(platform === 'win32'
    ? 'Podman cannot apply the course memory, CPU and process limits in its current WSL machine.\n\n'
      + '1. Open Windows PowerShell outside the course cell and course terminal. Run podman --version, wsl --list --verbose, and podman info. If podman info fails, resolve the machine or connection error first.\n'
      + '2. Update Podman to 6.2.0 or newer, update the existing Podman machine, then restart it. Do not reset or delete the machine. If restart reports Access is denied, save that error; the restart has not succeeded.\n'
      + '3. In the affected course, choose Runtime → Set up / rebuild course. Run print("Runtime ready"), then rerun the failed cell and check its actual output. A running machine alone does not verify course limits.\n\n'
      + 'Details: ' + detail
    : 'Podman cannot apply the course resource limits. Enable memory, CPU and process controllers for your rootless container runtime, then retry course setup. Details: ' + detail);
}

/** WSL may answer `podman info` while rootless resource controllers are absent. */
export async function checkWindowsResourceLimits(bin: string, io = {run}) {
  const info = JSON.parse(await io.run(bin, ['info', '--format', 'json']));
  const host = info.host ?? info.Host;
  const controllers = host?.cgroupControllers ?? host?.CgroupControllers;
  const rootless = host?.security?.rootless ?? host?.Security?.Rootless;
  if (rootless === true && Array.isArray(controllers) &&
      ['memory', 'cpu', 'pids'].some(controller => !controllers.includes(controller))) {
    throw resourceLimitError('memory.max / CPU / process controllers are unavailable in the rootless WSL runtime.', 'win32');
  }
}
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
    p.on('close', (code) => {
      const detail = `${file} exited with ${code}. ${tail.trim()}`;
      code === 0 ? resolve() : reject(resourceLimitError(detail) ?? new Error(detail));
    });
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

export const ERP_MEMORY_MIB = 6144;
export const ERP_MIN_MEMORY_BYTES = 6_000_000_000;
type RestartRuntime = () => Promise<boolean>;

/** Resize the selected local macOS VM in place; never recreate a machine or its volumes. */
export async function ensureMacRuntimeMemory(bin: string, memoryMiB: number,
    report: (message: string) => void, log: (message: string) => void, confirmRestart?: RestartRuntime,
    io = {run, stream, totalmem}, address?: string) {
  const available = Number(await io.run(bin, ['info', '--format', '{{.Host.MemTotal}}']));
  const minimum = memoryMiB === ERP_MEMORY_MIB ? ERP_MIN_MEMORY_BYTES : memoryMiB * 1024 * 1024 * 0.93;
  if (Number.isFinite(available) && available >= minimum) return;
  if (io.totalmem() < (memoryMiB + 2048) * 1024 * 1024)
    throw new Error('ERPNext needs 6 GB for its runtime and at least 2 GB for macOS. Use a Mac with at least 8 GB of RAM.');
  const listed = JSON.parse(await io.run(bin, ['machine', 'list', '--format', 'json'])) as Machine[] | null;
  if (!listed?.length) throw new Error('No local Podman machine is available. Retry ERPNext setup.');
  const machines = JSON.parse(await io.run(bin, ['machine', 'inspect', ...listed.map(m => m.Name)])) as Array<{
    Name: string; State: string; Resources: {Memory: number}; SSHConfig: {Port: number};
    ConnectionInfo: {PodmanSocket?: {Path: string}};
  }>;
  const connection = address ? new URL(address) : undefined;
  const machine = machines.find(m => connection?.protocol === 'ssh:'
    ? Number(connection.port) === m.SSHConfig.Port
    : connection?.protocol === 'unix:' && decodeURIComponent(connection.pathname) === m.ConnectionInfo.PodmanSocket?.Path);
  if (!machine) throw new Error('Could not identify the selected local Podman machine. Select its connection in Podman and retry ERPNext setup.');
  if (machine.Resources.Memory >= memoryMiB)
    throw new Error('Podman has enough memory configured but has not made it available. Restart the course runtime, then reopen ERPNext.');
  // Both rootful and rootless containers share the VM. Preserve both sets across its restart.
  const scopes = [['podman'], ['sudo', 'podman']];
  const running: string[][] = [];
  for (const command of scopes) {
    const ids = (await io.run(bin, ['machine', 'ssh', machine.Name, ...command, 'ps', '--quiet'])).split(/\s+/).filter(Boolean);
    if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Could not check active runtime containers. Retry ERPNext setup.');
    running.push(ids);
  }
  if (running.some(ids => ids.length) && (!confirmRestart || !await confirmRestart()))
    throw new Error('ERPNext setup paused. Reopen the course when you are ready to restart the runtime and allocate 6 GB.');
  report('Allocating 6 GB to the ERPNext runtime');
  await io.stream(bin, ['machine', 'stop', machine.Name], log);
  let resizeError: unknown;
  try { await io.stream(bin, ['machine', 'set', '--memory', String(memoryMiB), machine.Name], log); }
  catch (error) { resizeError = error; }
  // Restore the runtime even when this Podman provider refuses a memory change.
  try { await io.stream(bin, ['machine', 'start', machine.Name], log); }
  catch (error) {
    // If macOS cannot start the larger VM, restore the allocation that worked before.
    resizeError = error;
    await io.stream(bin, ['machine', 'set', '--memory', String(machine.Resources.Memory), machine.Name], log);
    await io.stream(bin, ['machine', 'start', machine.Name], log);
  }
  for (const [index, ids] of running.entries())
    if (ids.length) await io.run(bin, ['machine', 'ssh', machine.Name, ...scopes[index], 'start', ...ids], 120000);
  if (resizeError) throw new Error('Podman could not allocate 6 GB. The runtime was restarted with its previous settings. ' + String(resizeError));
  const actual = Number(await io.run(bin, ['info', '--format', '{{.Host.MemTotal}}']));
  if (!Number.isFinite(actual) || actual < minimum) throw new Error('Podman still reports too little memory for ERPNext. Check the machine memory in Podman and retry.');
}
export function machineSetup(machines: Machine[], memoryMiB = 2048): string[][] {
  if (machines.some((machine) => machine.Running || machine.Starting)) return [];
  const machine = machines.find((candidate) => candidate.Default) ?? machines[0];
  if (machine) return [['machine', 'start', machine.Name]];
  // Ordinary coding courses use 2 GB. Application courses can request more for a new machine.
  return [
    ['machine', 'init', '--cpus', '2', '--memory', String(memoryMiB), '--disk-size', '30', 'podman-machine-default'],
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

export async function ensurePodman(report: (s: string) => void, log: (s: string) => void, elevate: Elevate, memoryMiB = 2048, confirmRestart?: RestartRuntime) {
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
  let address = process.env.CONTAINER_HOST;
  if (address) requireLocalConnection(address);
  else if (process.platform !== 'linux' || process.env.CONTAINER_CONNECTION) {
    const connections = JSON.parse(await run(bin, ['system', 'connection', 'list', '--format', 'json'])) as
      | Connection[]
      | null;
    const selected = (connections ?? []).find((c) =>
      process.env.CONTAINER_CONNECTION ? c.Name === process.env.CONTAINER_CONNECTION : c.Default
    );
    if (selected) { address = selected.URI; requireLocalConnection(address); }
  }
  const checkMemory = async () => {
    if (process.platform === 'win32') await checkWindowsResourceLimits(bin!);
    if (process.platform === 'darwin' && memoryMiB > 2048)
      await ensureMacRuntimeMemory(bin!, memoryMiB, report, log, confirmRestart, undefined, address);
  };
  let ready = false;
  try {
    await run(bin, ['info', '--format', '{{.Host.Arch}}']);
    ready = true;
  } catch (error) {
    if (process.platform === 'linux') throw error;
  }
  if (ready) { await checkMemory(); return bin; }
  report('Setting up your Python workspace. The first run takes a moment. Meanwhile, write your prediction.');
  const machines = JSON.parse(await run(bin, ['machine', 'list', '--format', 'json'])) as Machine[] | null;
  for (const args of machineSetup(machines ?? [], memoryMiB)) {
    // A fresh VM must pass the same host-RAM check as an existing VM before allocating memory.
    if (args[1] === 'init' && process.platform === 'darwin' && memoryMiB > 2048 && totalmem() < (memoryMiB + 2048) * 1024 * 1024)
      throw new Error(`This course needs ${memoryMiB / 1024} GB for its runtime and at least 2 GB for macOS. Use a Mac with at least ${memoryMiB / 1024 + 2} GB of RAM.`);
    await stream(bin, args, log);
    if (args[1] === 'start') startedMachine = args[2];
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await run(bin, ['info', '--format', '{{.Host.Arch}}']);
      break;
    } catch (error) {
      if (attempt === 14) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await checkMemory();
  return bin;
}
