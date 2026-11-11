import {AppAction, AppField, AppForm, AppServer, Fetch, FieldSpec} from './types';

const TYPES: Record<string, AppField['type']> = {
  char: 'text', text: 'text', html: 'text', integer: 'number', float: 'number', monetary: 'number',
  date: 'date', datetime: 'datetime', boolean: 'check', selection: 'select', many2one: 'link', one2many: 'table', many2many: 'table',
};
interface OdooField { string: string; type: string; required?: boolean; readonly?: boolean; relation?: string; selection?: [string, string][] }

/** Odoo (Community and Enterprise): JSON-RPC models, form views and their buttons. */
export class OdooServer implements AppServer {
  readonly app = 'odoo';
  private cookie = '';
  private users = new Map<string, number>();
  constructor(private readonly origin: string, private readonly db: string, private readonly user: string,
      private readonly password: string, private readonly request: Fetch = fetch) {}
  async login() {
    const response = await this.request(this.origin + '/web/session/authenticate', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {db: this.db, login: this.user, password: this.password}})});
    const body = await response.json() as {result?: {uid?: number}; error?: unknown};
    const session = /(?:^|[,;\s])session_id=([^;,\s]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    if (!response.ok || body.error || !body.result?.uid || !session) throw new Error('The Odoo sandbox did not accept the login.');
    this.cookie = 'session_id=' + session;
  }
  /** One ORM call, signing in again once if the session expired. */
  async call<T>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie) await this.login();
      const response = await this.request(`${this.origin}/web/dataset/call_kw/${model}/${method}`, {method: 'POST',
        headers: {'Content-Type': 'application/json', Cookie: this.cookie}, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {model, method, args, kwargs}})});
      const body = await response.json() as {result?: T; error?: {data?: {name?: string; message?: string}}};
      if (body.error?.data?.name === 'odoo.http.SessionExpiredException') { this.cookie = ''; continue; }
      if (body.error) throw new Error(`Odoo ${model}.${method}: ${body.error.data?.message ?? 'request failed'}`);
      return body.result as T;
    }
    throw new Error('The Odoo sandbox refused the session.');
  }
  private async fieldsOf(model: string) {
    return this.call<Record<string, OdooField>>(model, 'fields_get', [], {attributes: ['string', 'type', 'required', 'readonly', 'relation', 'selection']});
  }
  /** The form view's own fields and buttons: what a person actually sees, not every technical column. */
  private async formView(model: string): Promise<string> {
    const views = await this.call<{views: {form: {arch: string}}}>(model, 'get_views', [[[false, 'form']]], {});
    return views.views.form.arch;
  }
  async describe(form: string): Promise<AppForm> {
    const [meta, arch] = await Promise.all([this.fieldsOf(form), this.formView(form)]);
    const {fields: top, rows} = viewFields(arch);
    const convert = async (model: string, fieldNames: string[], fields: Record<string, OdooField>, inner?: Map<string, string[]>): Promise<AppField[]> => {
      const result: AppField[] = [];
      for (const name of fieldNames) {
        const f = fields[name];
        if (!f || name === 'id') continue;
        const type = TYPES[f.type] ?? 'other';
        const field: AppField = {name, label: f.string || name, type, required: !!f.required, readOnly: !!f.readonly};
        if (f.selection) field.options = f.selection.map(([value]) => value);
        if (f.relation) field.target = f.relation;
        if (f.type === 'one2many' && f.relation) {
          const rowNames = inner?.get(name) ?? [];
          field.fields = rowNames.length ? await convert(f.relation, rowNames, await this.fieldsOf(f.relation)) : [];
        }
        result.push(field);
      }
      return result;
    };
    const actions: AppAction[] = [...arch.matchAll(/<button\s+([^>]*)>/g)].map(m => m[1])
      .filter(attrs => /type="object"/.test(attrs) && /name="([a-z0-9_]+)"/.test(attrs))
      .map(attrs => ({name: /name="([a-z0-9_]+)"/.exec(attrs)![1], label: /string="([^"]+)"/.exec(attrs)?.[1] ?? /name="([a-z0-9_]+)"/.exec(attrs)![1]}))
      .filter((a, i, all) => all.findIndex(b => b.name === a.name) === i);
    return {form, label: form, fields: await convert(form, top, meta, rows), actions};
  }
  /**
   * Reads a record as plain values: many2one becomes its display name, one2many becomes rows.
   * Tasks therefore name partners and products as a person sees them.
   */
  async read(form: string, id: string, fields?: FieldSpec) {
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric < 1) return undefined;
    const meta = await this.fieldsOf(form);
    const names = fields ? [...new Set([...Object.keys(fields), 'create_uid', ...(meta.state ? ['state'] : [])])].filter(n => meta[n]) : [];
    const [record] = await this.call<Record<string, unknown>[]>(form, 'read', [[numeric]], fields ? {fields: names} : {});
    if (!record) return undefined;
    return this.plain(record, meta, fields);
  }
  private async plain(record: Record<string, unknown>, meta: Record<string, OdooField>, fields?: FieldSpec): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record)) {
      const f = meta[name];
      if (f?.type === 'many2one') result[name] = Array.isArray(value) ? value[1] : null;
      else if (f?.type === 'one2many' && Array.isArray(value) && f.relation && value.length && value.length <= 50) {
        const rowMeta = await this.fieldsOf(f.relation), rowFields = fields?.[name];
        const rows = await this.call<Record<string, unknown>[]>(f.relation, 'read', [value],
          Array.isArray(rowFields) ? {fields: rowFields.filter(n => rowMeta[n])} : {});
        result[name] = await Promise.all(rows.map(row => this.plain(row, rowMeta)));
      } else result[name] = value;
    }
    result.create_uid_id = Array.isArray(record.create_uid) ? record.create_uid[0] : record.create_uid;
    return result;
  }
  sessionCookie() { return this.cookie ? {name: 'session_id', value: this.cookie.slice('session_id='.length)} : undefined; }
  async createdBy(record: Record<string, unknown>, login: string) {
    if (!this.users.has(login)) {
      const [user] = await this.call<{id: number}[]>('res.users', 'search_read', [[['login', '=', login]]], {fields: ['id'], limit: 1});
      if (!user) return false;
      this.users.set(login, user.id);
    }
    return record.create_uid_id === this.users.get(login);
  }
}

/**
 * Field names a person sees on an Odoo form view: top-level fields, and for each table field the
 * columns of its embedded list (its embedded detail form is ignored). Always-invisible fields are skipped;
 * conditionally invisible ones are kept, since they appear in some states.
 */
export function viewFields(arch: string): {fields: string[]; rows: Map<string, string[]>} {
  const fields: string[] = [], rows = new Map<string, string[]>();
  const stack: {tag: string; field?: string; skip?: boolean}[] = [];
  const hidden = (attrs: string) => /\binvisible="(1|True|true)"/.test(attrs) || /\bcolumn_invisible="(1|True|true)"/.test(attrs);
  for (const m of arch.matchAll(/<(\/?)([a-zA-Z_][\w.-]*)((?:\s+[\w:.-]+(?:="[^"]*")?)*)\s*(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { while (stack.length && stack.pop()!.tag !== tag); continue; }
    const owner = [...stack].reverse().find(entry => entry.field)?.field;
    const inDetail = stack.some(entry => entry.skip);
    if (tag === 'field') {
      const name = /\bname="([a-z0-9_]+)"/.exec(attrs)?.[1];
      if (name && !hidden(attrs) && !inDetail) {
        const list = owner ? (rows.get(owner) ?? rows.set(owner, []).get(owner)!) : fields;
        if (!list.includes(name)) list.push(name);
      }
      if (!selfClosing) stack.push({tag, field: owner ? undefined : name});
      continue;
    }
    // Inside a table field only its list columns count; its pop-up detail form and kanban cards do not.
    if (!selfClosing) stack.push({tag, skip: !!owner && (tag === 'form' || tag === 'kanban')});
  }
  return {fields, rows};
}
