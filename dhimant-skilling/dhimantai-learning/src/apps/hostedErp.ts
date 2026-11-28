import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {FrappeLoginError, FrappeServer} from './frappe';
import type {EnvironmentName} from '../environments';

export const ERP_SITE = 'dhimantai.erpnext.trainingSite';

function trainingOrigin(value: string, fromBrowser = false) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || (!fromBrowser && (url.pathname !== '/' || url.search || url.hash)))
    throw new Error('Enter the HTTPS address of the ERPNext site, without a path.');
  return url.origin;
}

export function hostedErpOrigin() {
  const configured = vscode.workspace.getConfiguration('dhimantai.erpnext').get<string>('trainingSite')?.trim();
  if (!configured) return undefined;
  return trainingOrigin(configured);
}

export async function connectHostedErp(origin: string, savedLogin?: string, savedPassword?: string) {
  const user = savedLogin ?? await vscode.window.showInputBox({title: 'ERPNext training login', prompt: origin, ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter your training account login.'});
  if (user === undefined) return;
  const password = savedPassword ?? await vscode.window.showInputBox({title: 'ERPNext training password', prompt: origin, password: true, ignoreFocusOut: true});
  if (password === undefined) return;
  const login = user.trim();
  const server = new FrappeServer(origin, login, password);
  return {login, password, server};
}

type SavedSite = {id: string; name: string; origin: string; login: string};

/** Endpoint profiles are per dhimantAI account and environment. Only SecretStorage holds passwords. */
export class HostedErpConnections {
  constructor(private context: vscode.ExtensionContext) {}

  private key(environment: EnvironmentName, account: string) {return `browser.erpnext.sites.${environment}.${account}`;}

  list(environment: EnvironmentName, account: string) {
    return this.sites(environment, account).map(({id, name, origin}) => ({id, name, origin}));
  }

  private sites(environment: EnvironmentName, account: string) {
    return this.context.globalState.get<SavedSite[]>(this.key(environment, account), []);
  }

  async connect(environment: EnvironmentName, account: string, id: string, current: () => Promise<boolean>) {
    const key = this.key(environment, account);
    const sites = this.sites(environment, account);
    let saved = sites.find(site => site.id === id);
    if (id !== 'connect' && !saved) throw new Error('That saved ERPNext connection is unavailable.');
    if (!saved) {
      const address = await vscode.window.showInputBox({title: 'Connect to ERPNext', prompt: 'Enter the HTTPS site address',
        placeHolder: 'https://erp.example.com', ignoreFocusOut: true, validateInput: value => {
          try {trainingOrigin(value, true); return undefined;}
          catch {return 'Enter an HTTPS site address.';}
        }});
      if (address === undefined || !await current()) return;
      const origin = trainingOrigin(address, true);
      const name = await vscode.window.showInputBox({title: 'Name this ERPNext connection', prompt: origin,
        value: new URL(origin).hostname, ignoreFocusOut: true, validateInput: value => {
          const name = value.trim();
          if (!name || name.length > 80) return 'Enter a connection name of up to 80 characters.';
          if (sites.some(site => site.name.toLowerCase() === name.toLowerCase())) return 'That connection name is already in use.';
        }});
      if (name === undefined || !await current()) return;
      saved = {id: randomBytes(16).toString('hex'), name: name.trim(), origin, login: ''};
    }
    const secretKey = `${key}.${saved.id}`;
    const password = await this.context.secrets.get(secretKey);
    if (!await current()) return;
    let connection = await connectHostedErp(saved.origin, saved.login || undefined, password);
    if (!connection || !await current()) return;
    try {await connection.server.login();}
    catch (error) {
      if (!(error instanceof FrappeLoginError) || password === undefined || !await current()) throw error;
      await vscode.window.showInformationMessage('ERPNext rejected the saved password. Enter the current password.');
      connection = await connectHostedErp(saved.origin, saved.login);
      if (!connection || !await current()) return;
      await connection.server.login();
    }
    const profile = {...saved, login: connection.login};
    const {server, password: verifiedPassword} = connection;
    return {id: profile.id, name: profile.name, origin: profile.origin, login: profile.login, server,
      save: async () => {
        if (!await current()) return;
        await this.context.secrets.store(secretKey, verifiedPassword);
        if (!sites.some(site => site.id === profile.id)) try {
          await this.context.globalState.update(key, [...sites, profile]);
        } catch (error) {
          await Promise.resolve(this.context.secrets.delete(secretKey)).catch(() => {});
          throw error;
        }
      }};
  }
}
