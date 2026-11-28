import type { EnvironmentName } from './environments';

// Only the configured DhimantAI signaling hosts are reachable in this webview.
// Local development can run a private loopback server on a separate port.
const hosts: Record<EnvironmentName, string[]> = {
  production: ['wss://lk-prod.dhimant.ai', 'wss://lk.dhimant.ai'],
  staging: ['wss://lk-staging.dhimant.ai'], development: ['wss://lk-dev.vidyai.in'],
  local: ['ws://localhost:*', 'ws://127.0.0.1:*'],
};
export const audioPolicy = Object.values(hosts).flat().flatMap(u => [u, u.replace(/^ws/, 'http')]).join(' ');

export function trustedRoomUrl(environment: EnvironmentName, url: string) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password) return false;
  return environment === 'local'
    ? endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
    : hosts[environment].includes(endpoint.origin);
}
