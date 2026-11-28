import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';

const run = promisify(execFile);
export interface DesktopWindow {pid: number; title: string}
export interface ScreenPoint {x: number; y: number}
interface WindowBounds extends ScreenPoint {width: number; height: number}
interface DriverWindow extends DesktopWindow {
  window_id: number;
  bounds: WindowBounds;
  is_on_screen?: boolean;
}

export function matchingWindow(target: DesktopWindow, windows: DriverWindow[]) {
  const title = (value: string) => value.replace(/\[\*\]/g, '').replace(/^\s*\*\s*/, '').trim();
  const matches = windows.filter(window => window.pid === target.pid && typeof window.title === 'string'
    && title(window.title) === title(target.title) && Number.isSafeInteger(window.window_id) && window.window_id > 0);
  return matches.length === 1 ? matches[0] : undefined;
}

export function capturePoint(point: ScreenPoint, bounds: WindowBounds, width: number, height: number) {
  const x = point.x - bounds.x, y = point.y - bounds.y;
  const scaleX = width / bounds.width, scaleY = height / bounds.height;
  if (![x, y, scaleX, scaleY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0
    || Math.abs(scaleX - scaleY) > 0.02 || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
    throw new Error('The desktop control is outside its verified window.');
  }
  return {x: Math.round(x * scaleX), y: Math.round(y * scaleY)};
}

/** The app adapter supplies the PID and current title. The driver never receives an unscoped input. */
export async function openDesktopControl(signal: AbortSignal) {
  const binary = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  let executable = binary;
  for (const candidate of [join(homedir(), '.local', 'bin', binary),
    ...(process.platform === 'darwin' ? ['/Applications/CuaDriver.app/Contents/MacOS/cua-driver'] : [])]) {
    if (await access(candidate).then(() => true, () => false)) {
      executable = candidate;
      break;
    }
  }
  const options = {timeout: 3500, windowsHide: true, maxBuffer: 2 * 1024 * 1024};
  if (process.platform === 'darwin') {
    const {stdout} = await run(executable, ['permissions', 'status', '--json'], {...options, signal});
    const permissions = JSON.parse(stdout);
    if (permissions.accessibility !== true || permissions.screen_recording !== true) {
      throw new Error('Cua Driver needs Accessibility and Screen Recording permission.');
    }
  } else {
    await run(executable, ['status'], {...options, signal});
  }
  const session = 'instructor-' + randomUUID();
  const child = spawn(executable, ['mcp'], {stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true});
  let requestId = 0;
  let pending: {id: number; finish: (error: Error | undefined, result?: any) => void} | undefined;
  const read = createInterface({input: child.stdout});
  read.on('line', line => {
    try {
      const response = JSON.parse(line);
      if (pending && pending.id === response.id) {
        pending.finish(response.error ? new Error('Cua Driver rejected the request.') : undefined, response.result);
      }
    } catch { /* Ignore output outside the driver protocol. */ }
  });
  function disconnected() {
    pending?.finish(new Error('Cua Driver disconnected.'));
  }
  child.on('exit', disconnected);
  child.on('error', disconnected);
  child.stdin.on('error', disconnected);
  function stop() {
    signal.removeEventListener('abort', stop);
    disconnected();
    read.close();
    child.stdin.end();
    child.kill();
  }
  signal.addEventListener('abort', stop, {once: true});
  function request(method: string, params: object, timeout = 4500): Promise<any> {
    signal.throwIfAborted();
    if (pending) throw new Error('A desktop control is still in progress.');
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => pending?.finish(new Error('Cua Driver did not respond.')), timeout);
      pending = {id, finish(error, result) {
        clearTimeout(timer);
        pending = undefined;
        if (error) reject(error);
        else resolve(result);
      }};
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
  }
  try {
    await request('initialize', {protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: {name: 'dhimantAI Instructor', version: '1'}}, 8000);
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
  } catch (error) {
    stop();
    throw error;
  }
  async function call(method: string, input: object) {
    const envelope = await request('tools/call', {name: method, arguments: input});
    const data = envelope?.structuredContent ?? {};
    if (envelope?.isError || data.effect === 'denied' || data.effect === 'unavailable') {
      throw new Error('Cua Driver could not operate the lesson window.');
    }
    return data;
  }
  async function windowFor(target: DesktopWindow) {
    const {windows} = await call('list_windows', {pid: target.pid});
    const window = Array.isArray(windows) && matchingWindow(target, windows);
    if (!window) throw new Error('The desktop lesson window is unavailable.');
    return window;
  }
  return {
    async focus(target: DesktopWindow) {
      const window = await windowFor(target);
      await call('bring_to_front', {pid: target.pid, window_id: window.window_id});
    },
    async pointer(target: DesktopWindow, point: ScreenPoint, clicks?: 1 | 2) {
      const window = await windowFor(target);
      if (window.is_on_screen === false) throw new Error('Open the lesson window before asking for a demonstration.');
      const directory = await mkdtemp(join(tmpdir(), 'instructor-window-'));
      try {
        const screenshot = join(directory, 'window.png');
        const address = {pid: target.pid, window_id: window.window_id, session};
        await call('get_window_state', {...address, screenshot_out_file: screenshot, include_screenshot: false, max_elements: 1});
        const png = await readFile(screenshot);
        if (png.length < 24 || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Cua Driver returned an invalid window image.');
        const pixel = capturePoint(point, window.bounds, png.readUInt32BE(16), png.readUInt32BE(20));
        await call('move_cursor', {...pixel, session, target: {kind: 'window', pid: target.pid, window_id: window.window_id}});
        if (clicks) await call(clicks === 2 ? 'double_click' : 'click', {...address, ...pixel, delivery_mode: 'foreground'});
      } finally {
        await rm(directory, {recursive: true, force: true});
      }
    },
    async key(target: DesktopWindow, key: string, modifiers: string[] = []) {
      const window = await windowFor(target);
      const address = {pid: target.pid, window_id: window.window_id, session};
      if (modifiers.length) await call('hotkey', {...address, keys: [...modifiers, key]});
      else await call('press_key', {...address, key, delivery_mode: 'foreground'});
    },
    async menu(target: DesktopWindow, path: string[]) {
      const window = await windowFor(target);
      await call('invoke_menu', {pid: target.pid, window_id: window.window_id, session, path});
    },
    async close() {
      try { await call('end_session', {session}); }
      catch { /* The transport also owns the cursor lifecycle. */ }
      finally { stop(); }
    },
  };
}
