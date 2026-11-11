#!/usr/bin/env node
// Run the live YouTube suite without test-electron's automatic --no-sandbox flags.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

async function main() {
  const executable = process.env.VSCODE_TEST_EXECUTABLE;
  if (!executable || !existsSync(executable)) throw new Error('Set VSCODE_TEST_EXECUTABLE to the native VS Code executable.');
  const root = resolve(__dirname, '..');
  const suite = join(root, 'out/test/integration/suiteLearningVideo.js');
  if (!existsSync(suite)) throw new Error('Run npm run compile first.');
  const { ENVIRONMENTS } = require(join(root, 'out/src/environments'));
  const output = process.env.DHIMANTAI_UX_OUT
    ? resolve(process.env.DHIMANTAI_UX_OUT) : mkdtempSync(join(tmpdir(), 'dhimantai-video-results-'));
  mkdirSync(output, { recursive: true });
  const receipt = join(output, 'video-playback.json');
  // A failed launch must not accidentally reuse a previous passing receipt.
  if (existsSync(receipt)) throw new Error('Choose a fresh DHIMANTAI_UX_OUT directory.');
  const port = process.env.DHIMANTAI_CDP_PORT || '9339';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Invalid CDP port.');
  const profile = mkdtempSync(join(tmpdir(), 'dhimantai-video-profile-'));
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn(executable, [
        '--user-data-dir', profile, '--extensions-dir', join(profile, 'extensions'),
        '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates',
        '--use-inmemory-secretstorage', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
        '--disable-workspace-trust', '--remote-debugging-port=' + port, '--window-size=1440,900',
        '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + suite,
      ], { stdio: 'inherit', env: { ...process.env,
        DHIMANTAI_TEST_ENVIRONMENT: JSON.stringify(ENVIRONMENTS.staging),
        DHIMANTAI_TEST_WELCOME: '0', DHIMANTAI_TEST_COURSES: '0', DHIMANTAI_TEST_LEARNING_WORKSPACE: '0',
        DHIMANTAI_CDP_PORT: port, DHIMANTAI_UX_OUT: output, DHIMANTAI_TEST_RESULTS: receipt,
      } });
      let timedOut = false, killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, 180000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(killTimer);
        if (timedOut || code !== 0) reject(new Error(`Native video check failed: timeout=${timedOut}, code=${code}, signal=${signal}`));
        else resolveRun();
      });
    });
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(result.passed, true, 'Native suite must report actual successful playback.');
    console.log('Passed native YouTube playback and pause/resume with sandbox enabled:', receipt);
    console.log('Catalog, auth and Instructor transport were fixtures. Device capture was not tested.');
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
