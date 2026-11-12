/** Playwright over the desktop's existing tab-scoped CDP transport. No browser installation or public debug port. */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {Browser, Page} from 'playwright-core';
import type * as WS from 'ws';
import {CdpTransport} from './inject';

export async function connectPlaywright(transport: CdpTransport, origin: string) {
  const {WebSocketServer} = require('../../vendor/ws') as typeof WS;
  const {chromium} = require('../../vendor/playwright-core') as typeof import('playwright-core');
  const path = '/' + randomBytes(32).toString('hex');
  const server = createServer((_req, res) => {res.writeHead(404); res.end();});
  const sockets = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024});
  let socket: WS.WebSocket | undefined, next = 1_000_000;
  const ids = new Map<number, number>();
  const subscription = transport.onMessage(raw => {
    const m = raw as {id?: number};
    if (m.id !== undefined) {
      const id = ids.get(m.id); if (id === undefined) return;
      ids.delete(m.id); socket?.send(JSON.stringify({...m, id}));
    } else if (socket?.readyState === 1) socket.send(JSON.stringify(m));
  });
  server.on('upgrade', (request, connection, head) => {
    if (request.url !== path || request.headers.origin || socket) {connection.destroy(); return;}
    sockets.handleUpgrade(request, connection, head, client => {
      socket = client;
      client.on('message', bytes => {
        try {
          const m = JSON.parse(bytes.toString());
          if (!Number.isInteger(m.id) || typeof m.method !== 'string') {client.close(); return;}
          // Browser.close must not close the user's desktop tab or other browser sessions.
          if (m.method === 'Browser.close') {client.send(JSON.stringify({id:m.id, result:{}})); return;}
          const id = ++next; ids.set(id, m.id);
          Promise.resolve(transport.send({...m, id})).catch(() => client.close());
        } catch {client.close();}
      });
    });
  });
  let browser: Browser | undefined;
  const close = async () => {
    // Closing the socket disconnects Playwright without closing the author's app.
    subscription.dispose(); socket?.terminate(); sockets.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); ids.clear();
  };
  try {
    await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Browser connection unavailable.');
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${address.port}${path}`, {timeout: 10000});
    const matches = browser.contexts().flatMap(c => c.pages()).filter(p => {try{return new URL(p.url()).origin === origin;}catch{return false;}});
    if (matches.length !== 1) throw new Error('Keep one authoring tab open for this training app.');
    const page = matches[0]; page.setDefaultTimeout(8000);
    return {page, close};
  } catch (error) {await close(); throw error;}
}

export async function discoverWebMcp(page: Page): Promise<{status: string; names: string[]}> {
  const api = (page as Page & {webmcp?: {tools(options: {timeout: number}): Promise<{name: string}[]>}}).webmcp;
  if (!api) return {status: 'unsupported', names: []};
  try {
    const tools = await api.tools({timeout: 2000});
    return {status: tools.length ? 'available' : 'empty', names: tools.slice(0, 20).map(t => String(t.name).slice(0, 100))};
  } catch {return {status: 'unsupported', names: []};}
}
