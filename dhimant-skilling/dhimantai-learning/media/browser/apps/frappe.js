/* Page adapter for Frappe applications (ERPNext…). The task player calls only window.dhimantaiApp. */
(() => {
  'use strict';
  if (window.dhimantaiApp) return;
  const json = async response => { if (!response.ok) throw new Error('request failed'); return response.json(); };
  const get = path => fetch(path, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)}).then(json);
  const frm = () => window.cur_frm;
  window.dhimantaiApp = {
    name: 'frappe',
    title: 'ERPNext',
    isFinal: doc => doc?.docstatus === 1,
    ready: () => !!(window.frappe?.session?.user && window.frappe?.ui?.form),
    user: () => frappe.session.user,
    today: () => frappe.datetime.get_today(),
    route: () => (frappe.get_route?.() || []).map(String).join('/'),
    /** The open form as plain values, or undefined when no form is open. */
    current() {
      const f = frm();
      if (!f?.doc || !f.doctype) return undefined;
      return {form: f.doctype, id: f.is_new() ? null : f.doc.name, isNew: !!f.is_new(), dirty: !!f.is_dirty(),
        final: f.doc.docstatus === 1, values: f.doc};
    },
    label: field => frm()?.fields_dict?.[field]?.df?.label,
    element: field => frm()?.fields_dict?.[field]?.wrapper,
    scrollTo: field => frm()?.scroll_to_field?.(field, false),
    /** Enters a value; table rows fill matching rows in place and never replace unrelated ones. */
    async setValue(field, value) {
      const f = frm();
      if (!Array.isArray(value)) return f.set_value(field, value);
      const key = Object.keys(value[0] || {})[0];
      const existing = (f.doc[field] || []).filter(row => row[key]);
      if (!existing.length) f.clear_table(field);
      for (const [i, values] of value.entries()) {
        const row = existing[i] || f.add_child(field);
        for (const [name, v] of Object.entries(values)) if (row[name] !== v) await frappe.model.set_value(row.doctype, row.name, name, v);
      }
      f.refresh_field(field); f.dirty();
    },
    async openNew(form) {
      // new_doc opens Quick Entry for master data; the course needs the complete form and stable field wrappers.
      await frappe.model.with_doctype(form);
      frappe.route_options = {};
      await frappe.set_route('Form', form, frappe.model.get_new_doc(form).name);
    },
    openRecord: (form, id) => frappe.set_route('Form', form, id),
    async read(form, id) {
      try { return (await get('/api/resource/' + encodeURIComponent(form) + '/' + encodeURIComponent(id))).data; }
      catch { return undefined; }
    },
    async find(form, field, value) {
      const rows = (await get('/api/resource/' + encodeURIComponent(form) + '?filters=' + encodeURIComponent(JSON.stringify([[field, '=', value]])))).data;
      return rows?.[0]?.name;
    },
    errors: () => [...document.querySelectorAll('.modal.show .msgprint, .alert-danger')]
      .filter(e => e.getClientRects().length).map(e => e.textContent.trim().slice(0, 500)).filter(Boolean).slice(0, 2),
    async logout() {
      const result = await fetch('/api/method/logout', {method: 'POST', credentials: 'same-origin', headers: {'X-Frappe-CSRF-Token': frappe.csrf_token}});
      return result.ok;
    },
    /** ERPNext's own record of an effect: an item's stock in a warehouse, or a voucher's ledger entries. */
    async evidence(spec, record) {
      if (spec.type === 'stock') {
        const rows = (await get('/api/resource/Bin?fields=' + encodeURIComponent('["actual_qty"]') + '&filters='
          + encodeURIComponent(JSON.stringify([['item_code', '=', spec.item], ['warehouse', '=', spec.warehouse]])))).data || [];
        return `${Number(rows[0]?.actual_qty ?? 0)} in ${spec.warehouse}.`;
      }
      const rows = (await get('/api/resource/GL%20Entry?fields=' + encodeURIComponent('["account","debit","credit"]') + '&filters='
        + encodeURIComponent(JSON.stringify([['voucher_no', '=', record], ['is_cancelled', '=', 0]])))).data || [];
      return rows.length ? rows.map(r => `${r.account} ${Number(r.debit) ? 'debit ' + Number(r.debit) : 'credit ' + Number(r.credit)}`).join(' · ') + '.' : 'no ledger entries.';
    },
    // Authoring replay: perform what a learner would, through the form's own controls.
    save: () => frm().save(),
    /** A final action; Frappe's is Submit. */
    act: name => name === 'submit' || name === 'Submit' ? frm().save('Submit') : frm().page.btn_primary?.trigger('click'),
    /** Follows a Create menu entry on the open record, as a learner would choose it. */
    create(label) {
      const button = frm()?.custom_buttons?.[label];
      if (!button?.length) throw new Error(`No Create entry named ${label}.`);
      button.trigger('click');
    },
    courseAsset: '/assets/frappe/dhimantai/course.json',
    launchPath: '/assets/frappe/dhimantai/launch.html',
  };
})();
