/**
 * One contract for every business application a practical course can run in (ERPNext, Odoo,
 * and later Salesforce, Workday…). Course content, authoring, verification and the in-page
 * player depend only on these shapes; each application supplies a small adapter.
 */

/** A field normalized across applications. Values are compared in the application's own terms. */
export interface AppField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'datetime' | 'check' | 'select' | 'link' | 'table' | 'other';
  required: boolean;
  readOnly: boolean;
  hidden?: boolean;
  /** Choices for a select field, as stored values. */
  options?: string[];
  /** The form a link field points to, or the row form of a table. */
  target?: string;
  /** The tab or section the field sits under, when the application groups fields. */
  group?: string;
  /** Row fields of a table. */
  fields?: AppField[];
}

/** An action on a saved record, such as Submit or Confirm. */
export interface AppAction { name: string; label: string }

/** A form as the application describes it, independent of how it is drawn on screen. */
export interface AppForm {
  form: string;
  label: string;
  fields: AppField[];
  /** Workflow actions a learner can take on the record (Odoo buttons, Frappe submit). */
  actions: AppAction[];
}

/** Server-side access to one application sandbox, used by authoring and by verification. */
export interface AppServer {
  readonly app: string;
  /** Signs in; later calls reuse the session and sign in again once if it expires. */
  login(): Promise<void>;
  /** Describes the fields a person sees on a form, including table rows. */
  describe(form: string): Promise<AppForm>;
  /** Reads a saved record with table rows expanded, or undefined when it does not exist. With a field list, reads only those. */
  read(form: string, id: string, fields?: FieldSpec): Promise<Record<string, unknown> | undefined>;
  /** Whether a saved record was created by this application login. */
  createdBy(record: Record<string, unknown>, login: string): Promise<boolean>;
  /** After login: the application's session cookie, which the desktop hands to the browser tab. */
  sessionCookie(): {name: string; value: string} | undefined;
}

export type Fetch = typeof fetch;
/** Fields to read: true for a value, or the row keys for a table. */
export type FieldSpec = Record<string, true | string[]>;
/** The fields a task's expected record compares, so checks read only what they need. */
export function fieldsFor(expected: Record<string, unknown>, extra: string[] = []): FieldSpec {
  const spec: FieldSpec = {};
  for (const [name, value] of Object.entries(expected))
    spec[name] = Array.isArray(value) ? [...new Set(value.flatMap(row => row && typeof row === 'object' ? Object.keys(row) : []))] : true;
  for (const name of extra) spec[name] ??= true;
  return spec;
}
