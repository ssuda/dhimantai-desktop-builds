import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** A detached helper that waits for the app to quit, installs the verified update and starts dhimantAI again. */
export interface DesktopApplyPlan { command: string; args: string[] }
export interface DesktopApplyInput {
  platform: NodeJS.Platform; appRoot: string; installer: string; pid: number; applicationName: string;
}

const WAIT_SECONDS = 600;
// Positional arguments only: $1 pid, $2 dmg, $3 installed app bundle. Nothing is interpolated into the script.
const MAC_SCRIPT = `pid="$1"; dmg="$2"; app="$3"; i=0
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; i=$((i+1)); [ "$i" -gt ${WAIT_SECONDS * 2} ] && exit 1; done
stage=""
mnt="$(mktemp -d)" || { open "$app"; exit 1; }
if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null; then
  src="$(find "$mnt" -maxdepth 1 -name '*.app' -type d | head -n 1)"
  identifier() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null; }
  want="$(identifier "$app")"
  if [ -n "$src" ] && [ -n "$want" ] && [ "$want" = "$(identifier "$src")" ]; then
    stage="$(mktemp -d "$(dirname "$app")/.dhimantai-update.XXXXXXXX")" || stage=""
    if [ -n "$stage" ]; then
      if ditto "$src" "$stage/new.app" && mv "$app" "$stage/previous.app"; then
        mv "$stage/new.app" "$app" || mv "$stage/previous.app" "$app"
      fi
    fi
  fi
  hdiutil detach "$mnt" -quiet || hdiutil detach "$mnt" -force -quiet
fi
rmdir "$mnt" 2>/dev/null
if open "$app"; then
  [ -z "$stage" ] || rm -rf "$stage"
elif [ -n "$stage" ] && [ -d "$stage/previous.app" ]; then
  if [ ! -e "$app" ] || mv "$app" "$stage/failed.app"; then
    mv "$stage/previous.app" "$app" && open "$app" && rm -rf "$stage"
  fi
fi`;
const LINUX_SCRIPT = `pid="$1"; app="$2"; i=0
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; i=$((i+1)); [ "$i" -gt ${WAIT_SECONDS * 2} ] && exit 1; done
exec "$app"`;

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Returns undefined when this installation cannot be updated in place; the caller then opens the installer. */
export function desktopApplyPlan(input: DesktopApplyInput): DesktopApplyPlan | undefined {
  const { platform, appRoot, installer, pid, applicationName } = input;
  if (!Number.isSafeInteger(pid) || pid <= 1 || !/^[a-z0-9-]+$/.test(applicationName)) return undefined;
  if (platform === 'darwin') {
    const app = resolve(appRoot, '../../..');
    // Translocated or mounted copies are read-only; the learner must drag the app to Applications first.
    if (!app.endsWith('.app') || !installer.endsWith('.dmg') || app.includes('/AppTranslocation/') || app.startsWith('/Volumes/')) return undefined;
    return { command: '/bin/sh', args: ['-c', MAC_SCRIPT, 'dhimantai-update', String(pid), installer, app] };
  }
  if (platform === 'win32') {
    if (!installer.toLowerCase().endsWith('.exe')) return undefined;
    // Inno Setup's runcode task starts the updated app once the silent install completes.
    const script = `$p=${pid}; Wait-Process -Id $p -Timeout ${WAIT_SECONDS} -ErrorAction SilentlyContinue; `
      + `if (Get-Process -Id $p -ErrorAction SilentlyContinue) { exit 1 }; `
      + `Start-Process -FilePath ${quote(installer)} -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/MERGETASKS=runcode'`;
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script] };
  }
  return undefined;
}

/** Linux packages need administrator approval, so install first (while the app keeps running), then relaunch. */
async function installLinux(input: DesktopApplyInput): Promise<DesktopApplyPlan | undefined> {
  const { appRoot, installer, pid, applicationName } = input;
  if (appRoot !== `/usr/share/${applicationName}/resources/app` || !installer.endsWith('.deb')) return undefined;
  const ok = await new Promise<boolean>(done => {
    const child = spawn('pkexec', ['dpkg', '-i', installer], { stdio: 'ignore' });
    child.once('error', () => done(false));
    child.once('exit', code => done(code === 0));
  });
  if (!ok) return undefined;
  return { command: '/bin/sh', args: ['-c', LINUX_SCRIPT, 'dhimantai-update', String(pid), join(dirname(dirname(appRoot)), applicationName)] };
}

export async function prepareDesktopApply(input: DesktopApplyInput): Promise<DesktopApplyPlan | undefined> {
  if (input.platform === 'linux') return installLinux(input);
  const plan = desktopApplyPlan(input);
  if (plan && input.platform === 'darwin') {
    try { await access(dirname(plan.args.at(-1)!), constants.W_OK); } catch { return undefined; }
  }
  return plan;
}

export async function applicationName(appRoot: string): Promise<string> {
  return JSON.parse(await readFile(join(appRoot, 'product.json'), 'utf8')).applicationName;
}

export function startDetached(plan: DesktopApplyPlan): Promise<void> {
  // The extension host enables Node mode for its children. A relaunched desktop needs Electron's GUI.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
