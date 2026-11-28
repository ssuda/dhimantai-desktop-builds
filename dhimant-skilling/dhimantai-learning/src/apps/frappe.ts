import {AppField, AppForm, AppServer, Fetch} from './types';

const TYPES: Record<string, AppField['type']> = {
  Data: 'text', 'Small Text': 'text', Text: 'text', 'Long Text': 'text', 'Text Editor': 'text', 'Read Only': 'text',
  Int: 'number', Float: 'number', Currency: 'number', Percent: 'number',
  Date: 'date', Datetime: 'datetime', Check: 'check', Select: 'select', Link: 'link', 'Dynamic Link': 'link', Table: 'table',
};
const LAYOUT = new Set(['Section Break', 'Column Break', 'Tab Break', 'HTML', 'Button', 'Fold', 'Heading']);

interface DocField { fieldname: string; label?: string; fieldtype: string; reqd?: number; read_only?: number; hidden?: number; options?: string }
interface DocType { name: string; fields: DocField[]; is_submittable?: number }

export class FrappeLoginError extends Error {
  constructor() {super('ERPNext did not accept the training login. Check the account and password.');}
}

/** Frappe applications (ERPNext, Frappe HR, CRM…): REST resources and DocType metadata. */
export class FrappeServer implements AppServer {
  readonly app = 'frappe';
  private cookie = '';
  private deskPath?: string;
  constructor(private readonly origin: string, private readonly user: string, private readonly password: string,
      private readonly request: Fetch = fetch) {}
  async login() {
    if (this.cookie) return;
    let response: Response;
    try {
      response = await this.request(this.origin + '/api/method/login', {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({usr: this.user, pwd: this.password}), redirect: 'error', signal: AbortSignal.timeout(15000)});
    } catch (error) {
      const cause = error instanceof Error ? error.cause as {code?: string; message?: string} | undefined : undefined;
      if (cause?.code && /CERT|SELF_SIGNED|ISSUER/.test(cause.code))
        throw new Error('The ERPNext training site’s HTTPS certificate could not be verified.');
      if (cause?.message === 'unexpected redirect')
        throw new Error('The ERPNext training login redirected. Use the site’s final HTTPS origin and a training account with ERPNext password login.');
      const reason = cause?.code && /^[A-Z0-9_]{1,48}$/.test(cause.code) ? ` (${cause.code})` : '';
      throw new Error('Could not reach the ERPNext training site at ' + this.origin + reason + '. Check its address and network connection.');
    }
    const sid = /(?:^|[,;\s])sid=([^;,\s]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    if (response.status === 401 || response.status === 403) throw new FrappeLoginError();
    if (!response.ok || !sid || sid === 'Guest') throw new Error('This site did not return an ERPNext training session. Check the site URL and its sign-in method.');
    const home = (await response.json().catch(() => ({})) as {home_page?: unknown}).home_page;
    this.deskPath = home === '/app' || home === '/desk' ? home : undefined;
    this.cookie = 'sid=' + sid;
  }
  private async get(path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie) await this.login();
      const response = await this.request(this.origin + path, {headers: {Cookie: this.cookie, Accept: 'application/json',
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})}, ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)}),
        redirect: 'error', signal: AbortSignal.timeout(30000)});
      if (response.status === 401 || response.status === 403) { this.cookie = ''; continue; }
      return response;
    }
    throw new Error('The Frappe sandbox refused the session.');
  }
  /** Creates a record as this login, through the same validation as the form; docstatus 1 also submits it. Returns its name. */
  async insert(form: string, values: Record<string, unknown>): Promise<string> {
    const response = await this.get('/api/resource/' + encodeURIComponent(form), values);
    const body = await response.json().catch(() => ({})) as {data?: {name?: string}; exception?: string};
    if (!response.ok || !body.data?.name) throw new Error(`ERPNext did not accept the ${form}: ${String(body.exception ?? response.status).slice(0, 300)}`);
    return body.data.name;
  }
  async describe(form: string): Promise<AppForm> {
    const response = await this.get('/api/method/frappe.desk.form.load.getdoctype?doctype=' + encodeURIComponent(form));
    if (!response.ok) throw new Error(`Frappe has no form named ${form}.`);
    const docs = ((await response.json()) as {docs: DocType[]}).docs;
    const byName = new Map(docs.map(d => [d.name, d]));
    const fields = (doc: DocType): AppField[] => {
      const result: AppField[] = [];
      let group: string | undefined;
      for (const f of doc.fields) {
        if (f.fieldtype === 'Tab Break' || f.fieldtype === 'Section Break') { if (f.label) group = f.label; continue; }
        if (LAYOUT.has(f.fieldtype)) continue;
        const type = TYPES[f.fieldtype] ?? 'other';
        const field: AppField = {name: f.fieldname, label: f.label || f.fieldname, type, required: !!f.reqd, readOnly: !!f.read_only,
          ...(f.hidden ? {hidden: true} : {}), ...(group ? {group} : {})};
        if (type === 'select' && f.options) field.options = f.options.split('\n').filter(Boolean);
        if ((type === 'link' || type === 'table') && f.options) field.target = f.options;
        if (type === 'table' && f.options && byName.has(f.options)) field.fields = fields(byName.get(f.options)!);
        result.push(field);
      }
      return result;
    };
    const doc = byName.get(form);
    if (!doc) throw new Error(`Frappe returned no metadata for ${form}.`);
    return {form, label: form, fields: fields(doc), actions: doc.is_submittable ? [{name: 'submit', label: 'Submit'}] : []};
  }
  async read(form: string, id: string, _fields?: unknown) {
    const response = await this.get(`/api/resource/${encodeURIComponent(form)}/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('Frappe could not return the record.');
    return ((await response.json()) as {data: Record<string, unknown>}).data;
  }
  async createdBy(record: Record<string, unknown>, login: string) { return record.owner === login; }
  sessionCookie() { return this.cookie ? {name: 'sid', value: this.cookie.slice(4)} : undefined; }
  landingPath() {return this.deskPath;}

  async logout() {
    const cookie = this.cookie;
    this.cookie = '';
    if (cookie) await this.request(this.origin + '/api/method/logout', {headers: {Cookie: cookie}, redirect: 'error', signal: AbortSignal.timeout(5000)});
  }
}
