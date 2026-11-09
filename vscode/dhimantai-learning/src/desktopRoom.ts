import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Environment, EnvironmentName } from './environments';

type Grant = {url: string; token: string};
type ClientConfig = {tokenUrl: string; signingKey: string; appName: string};

/** The same token-service request used by Flutter's TokenService. Configuration
 * is injected only into the custom desktop package, never the public VSIX/source.
 * The initial extension grant retains the existing student eligibility checks. */
export async function desktopRoom(extensionPath: string, environment: EnvironmentName, service: Environment,
    account: string, initial: Grant, request: typeof fetch = fetch): Promise<Grant> {
  let config: ClientConfig | undefined;
  try {
    const configs = JSON.parse(await readFile(join(extensionPath, 'desktop-client.json'), 'utf8'));
    config = configs[environment];
  } catch { throw new Error('This desktop package is missing its Flutter client configuration. Reinstall the desktop preview.'); }
  if (!config || config.tokenUrl !== service.apiUrl || !config.signingKey || !config.appName) {
    throw new Error('Live devices are not configured for this service in this desktop package.');
  }
  // Read profile fields only from the HTTPS grant obtained for this signed-in account.
  // This is not a JWT verifier and does not accept a token supplied by the webview.
  const profile = JSON.parse(Buffer.from(initial.token.split('.')[1] ?? '', 'base64url').toString());
  if (profile.sub !== account || profile.attributes?.student_id !== account || profile.attributes?.role !== 'student') {
    throw new Error('The learning account changed. Sign in again.');
  }
  const room = `vidyai-${account}-${randomUUID()}`;
  const body = JSON.stringify({identity: account, room_name: room, name: profile.name || 'Student',
    attributes: {...profile.attributes, agent_mode: 'idle'}, app_name: config.appName});
  const response = await request(config.tokenUrl + '/getToken', {method: 'POST',
    headers: {'Content-Type': 'application/json', Accept: 'application/json',
      'X-Signature': createHmac('sha256', config.signingKey).update(body).digest('hex')},
    body, signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`Could not connect to Instructor (${response.status}). Try again.`);
  const raw = await response.json() as any;
  const data = raw.message ?? raw;
  if (typeof data.serverUrl !== 'string' || typeof data.participantToken !== 'string') {
    throw new Error('Instructor returned an incomplete connection. Try again.');
  }
  const issued = JSON.parse(Buffer.from(data.participantToken.split('.')[1] ?? '', 'base64url').toString());
  if (issued.sub !== account || issued.video?.room !== room || issued.video?.canPublish === false) {
    throw new Error('Instructor did not grant this device connection. Try again.');
  }
  return {url: data.serverUrl, token: data.participantToken};
}
