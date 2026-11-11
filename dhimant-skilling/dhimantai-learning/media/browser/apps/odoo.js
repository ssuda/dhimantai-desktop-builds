/* Page adapter for the Odoo web client (17/18). The task player calls only window.dhimantaiApp. */
(() => {
  'use strict';
  if (window.dhimantaiApp) return;
  const services = () => window.odoo?.__WOWL_DEBUG__?.root?.env?.services;
  const orm = () => services().orm;
  /** The form controller currently shown, found in the OWL component tree. */
  function controller() {
    const root = window.odoo?.__WOWL_DEBUG__?.root?.__owl__;
    let found, seen = new Set();
    const walk = node => {
      if (!node || seen.has(node) || found) return;
      seen.add(node);
      const c = node.component;
      if (c?.model?.root?.resModel && c.constructor?.name === 'FormController' && document.body.contains(node.bdom?.el ?? c.rootRef?.el ?? document.body)) { found = c; return; }
      for (const child of Object.values(node.children || {})) walk(child);
    };
    walk(root);
    return found;
  }
  const record = () => controller()?.model?.root;
  /** Plain values as people name them: many2one by name, dates as ISO, table rows as objects. */
  function plain(rec) {
    const out = {};
    for (const [name, value] of Object.entries(rec.data || {})) {
      const type = rec.fields?.[name]?.type;
      if (type === 'many2one') out[name] = Array.isArray(value) ? value[1] : value && typeof value === 'object' ? value.display_name : value || null;
      else if ((type === 'one2many' || type === 'many2many') && value?.records) out[name] = value.records.map(plain);
      else if (value && typeof value === 'object' && typeof value.toISODate === 'function') out[name] = type === 'datetime' ? value.toISO() : value.toISODate();
      else out[name] = value;
    }
    out.id = rec.resId || null;
    return out;
  }
  const isFinal = doc => !!doc?.state && !['draft', 'sent', 'cancel'].includes(doc.state);
  /** Finds a related record id by its display name, as a person would pick it in a dropdown. */
  async function pick(model, name) {
    const found = await orm().call(model, 'name_search', [], {name, operator: '=', limit: 1});
    if (!found?.length) throw new Error(`No ${model} named ${name}.`);
    return found[0];
  }
  async function assign(rec, values) {
    const changes = {};
    for (const [name, value] of Object.entries(values)) {
      const field = rec.fields[name];
      if (!field) throw new Error(`Unknown field ${name}.`);
      if (field.type === 'many2one') changes[name] = value == null || value === false ? false : await pick(field.relation, value);
      else if (field.type === 'date' || field.type === 'datetime') changes[name] = value ? window.luxon.DateTime.fromISO(value) : false;
      else changes[name] = value;
    }
    await rec.update(changes);
  }
  async function readPlain(model, ids, spec) {
    const meta = await orm().call(model, 'fields_get', [], {attributes: ['type', 'relation']});
    const names = spec ? [...new Set([...Object.keys(spec), ...(meta.state ? ['state'] : [])])].filter(n => meta[n]) : Object.keys(meta).filter(n => !['binary', 'html'].includes(meta[n].type));
    const rows = await orm().read(model, ids, names);
    const result = [];
    for (const row of rows) {
      const out = {};
      for (const [name, value] of Object.entries(row)) {
        const f = meta[name];
        if (f?.type === 'many2one') out[name] = Array.isArray(value) ? value[1] : null;
        else if (f?.type === 'one2many' && Array.isArray(value) && value.length && value.length <= 50)
          out[name] = await readPlain(f.relation, value, Array.isArray(spec?.[name]) ? Object.fromEntries(spec[name].map(k => [k, true])) : undefined);
        else out[name] = value;
      }
      result.push(out);
    }
    return result;
  }
  window.dhimantaiApp = {
    name: 'odoo',
    title: 'Odoo',
    isFinal,
    ready: () => !!(services()?.orm && window.odoo?.loader?.modules?.get('@web/core/user')?.user?.login),
    user: () => window.odoo.loader.modules.get('@web/core/user').user.login,
    route: () => location.pathname + location.hash,
    current() {
      const rec = record();
      if (!rec) return undefined;
      const values = plain(rec);
      return {form: rec.resModel, id: rec.resId ? String(rec.resId) : null, isNew: !!rec.isNew, dirty: !!rec.dirty, final: isFinal(values), values};
    },
    label: field => record()?.fields?.[field]?.string,
    element: field => document.querySelector(`.o_form_view .o_field_widget[name="${CSS.escape(field)}"], .o_form_view div[name="${CSS.escape(field)}"]`) || undefined,
    scrollTo(field) { this.element(field)?.scrollIntoView({block: 'center'}); },
    /** Enters a value; table rows fill matching rows in place and add missing ones, never removing unrelated rows. */
    async setValue(field, value) {
      const rec = record();
      if (!Array.isArray(value)) return assign(rec, {[field]: value});
      const list = rec.data[field], key = Object.keys(value[0] || {})[0];
      const existing = list.records.filter(row => plain(row)[key]);
      for (const [i, values] of value.entries()) {
        const row = existing[i] || await list.addNewRecord({position: 'bottom'});
        const current = plain(row);
        await assign(row, Object.fromEntries(Object.entries(values).filter(([k, v]) => current[k] !== v)));
      }
    },
    openNew: form => services().action.doAction({type: 'ir.actions.act_window', res_model: form, views: [[false, 'form']], target: 'current'}),
    openRecord: (form, id) => services().action.doAction({type: 'ir.actions.act_window', res_model: form, res_id: Number(id), views: [[false, 'form']], target: 'current'}),
    async read(form, id, spec) {
      const numeric = Number(id);
      if (!Number.isSafeInteger(numeric) || numeric < 1) return undefined;
      try { return (await readPlain(form, [numeric], spec))[0]; } catch (error) { console.warn('dhimantAI read', form, error); return undefined; }
    },
    async find(form, field, value) {
      const rows = await orm().searchRead(form, [[field, '=', value]], ['id'], {limit: 1});
      return rows[0] ? String(rows[0].id) : undefined;
    },
    errors: () => [...document.querySelectorAll('.o_notification.border-danger .o_notification_content, .o_notification_manager .bg-danger, .o_error_dialog .modal-body, .modal.o_technical_modal .modal-body .alert-danger')]
      .filter(e => e.getClientRects().length).map(e => e.textContent.trim().slice(0, 500)).filter(Boolean).slice(0, 2),
    async logout() { const r = await fetch('/web/session/logout', {credentials: 'same-origin', redirect: 'manual'}); return r.ok || r.type === 'opaqueredirect'; },
    /** Odoo's own record of an effect: on-hand stock of a product in a location, or a journal entry's lines. */
    async evidence(spec, record) {
      if (spec.type === 'stock') {
        const quants = await orm().searchRead('stock.quant', [['product_id.display_name', '=', spec.item], ['location_id.complete_name', '=', spec.warehouse]], ['quantity']);
        return `${quants.reduce((sum, q) => sum + q.quantity, 0)} in ${spec.warehouse}.`;
      }
      const lines = await orm().searchRead('account.move.line', [['move_id', '=', Number(record)]], ['account_id', 'debit', 'credit']);
      return lines.length ? lines.map(l => `${l.account_id[1]} ${l.debit ? 'debit ' + l.debit : 'credit ' + l.credit}`).join(' · ') + '.' : 'no journal items.';
    },
    // Authoring replay: perform what a learner would, through the form's own controls.
    save: () => record().save(),
    /** A final action: the form button with this method name (action_confirm) or label (Confirm). */
    async act(name) {
      const button = [...document.querySelectorAll('.o_form_view button')].find(b => b.getAttribute('name') === name || b.textContent.trim() === name);
      if (!button) throw new Error(`No button ${name}.`);
      button.click();
    },
    /** Follows a header button that creates the next document (Create Invoice, Delivery…). */
    create(label) { return this.act(label); },
    launchPath: '/web/login',
  };
})();
