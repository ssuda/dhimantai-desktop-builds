import {FrappeServer} from './frappe';
import {OdooServer} from './odoo';
import {AppServer, Fetch} from './types';

export * from './types';
/** Connection details for one application sandbox. New applications register a case here. */
export interface AppConnection { app: 'frappe' | 'odoo'; url: string; user: string; password: string; db?: string }

export function appServer(connection: AppConnection, request: Fetch = fetch): AppServer {
  switch (connection.app) {
    case 'frappe': return new FrappeServer(connection.url, connection.user, connection.password, request);
    case 'odoo':
      if (!connection.db) throw new Error('Odoo needs the database name.');
      return new OdooServer(connection.url, connection.db, connection.user, connection.password, request);
    default: throw new Error(`No adapter for ${(connection as {app: string}).app}.`);
  }
}
