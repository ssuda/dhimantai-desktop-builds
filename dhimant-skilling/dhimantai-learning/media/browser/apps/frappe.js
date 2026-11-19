/* Page adapter for Frappe applications (ERPNext…). The task player calls only window.dhimantaiApp. */
(() => {
  'use strict';
  if (window.dhimantaiApp) return;
  const json = async response => { if (!response.ok) throw new Error('request failed'); return response.json(); };
  const get = path => fetch(path, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000)}).then(json);
  // Desk retains cur_frm even when it replaces the visible form with a message page.
  const frm = () => window.frappe?.container ? frappe.container.page?.frm : window.cur_frm;
  // The course opens forms from outside ERPNext's sidebar, like its global search.
  // Let Frappe choose a sidebar that actually lists the destination (Item -> Stock),
  // instead of retaining the previous task's Setup sidebar and URL prefix.
  const openRoute = (...route) => {
    frappe.route_flags = {...frappe.route_flags, jump: true};
    return frappe.set_route(...route);
  };
  window.dhimantaiApp = {
    name: 'frappe',
    title: 'ERPNext',
    isFinal: doc => doc?.docstatus === 1,
    ready: () => !!(window.frappe?.session?.user && window.frappe?.ui?.form),
    user: () => frappe.session.user,
    today: () => frappe.datetime.get_today(),
    route() {
      const route = frappe.get_route?.() || [];
      if (route[0] === 'Form' && (frm()?.doctype !== route[1] || frm()?.doc?.name !== route[2])) return '';
      return route.map(String).join('/');
    },
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
      await openRoute('Form', form, frappe.model.get_new_doc(form).name);
    },
    async openRecord(form, id) {
      if (frm()?.is_dirty()) throw new Error('Save or discard your current ERPNext changes first.');
      const label = form + ' ' + id;
      let response;
      try {
        // The same Desk loader as the native form checks access and fills Frappe's document cache.
        response = await frappe.call({method: 'frappe.desk.form.load.getdoc', type: 'GET',
          args: {doctype: form, name: id}, freeze: true});
      } catch (error) {
        if (error?.status === 401 || error?.status === 403)
          throw new Error('Your ERPNext session could not access ' + label + '. Reopen the course with your training account and retry.');
        throw new Error('ERPNext could not load ' + label + '. Check your connection and try again.');
      }
      // A missing document is a successful HTTP response with no matching document.
      if (!response?.docs?.some(doc => doc.doctype === form && doc.name === id))
        throw new Error('ERPNext could not find ' + label + ' in this training site.');

      const route = ['Form', form, id], key = route.join('/');
      await openRoute(...route);
      const page = frappe.container?.page;
      if (page && page === frappe.pages[key] && page.querySelector('.message-page') && frappe.get_route_str() === key) {
        // A second set_route to the same URL keeps the error on screen. The native form
        // factory also reuses that cached page on later visits, even after a successful read.
        delete frappe.pages[key];
        try {
          frappe.router.render();
          await frappe.after_ajax();
        } finally {
          if (frappe.container.page !== page) page.remove();
          else frappe.pages[key] = page;
        }
      }
      if (frm()?.doctype !== form || frm()?.doc?.name !== id)
        throw new Error('ERPNext did not display ' + label + '. Try opening it again.');
    },
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
    /** What a submitted document posted: its general ledger and stock ledger entries, as ERPNext recorded them. */
    async postings(form, record) {
      const list = (doctype, fields) => get('/api/resource/' + encodeURIComponent(doctype) + '?limit_page_length=100&fields=' + encodeURIComponent(JSON.stringify(fields))
        + '&filters=' + encodeURIComponent(JSON.stringify([['voucher_type', '=', form], ['voucher_no', '=', record], ['is_cancelled', '=', 0]]))).then(r => r.data || []);
      const [gl, sle] = await Promise.all([list('GL Entry', ['account', 'debit', 'credit']),
        list('Stock Ledger Entry', ['item_code', 'warehouse', 'actual_qty', 'qty_after_transaction', 'stock_value_difference'])]);
      return {ledger: gl.map(r => ({account: r.account, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0})),
        stock: sle.map(r => ({item: r.item_code, warehouse: r.warehouse, change: Number(r.actual_qty) || 0,
          balance: Number(r.qty_after_transaction) || 0, value: Number(r.stock_value_difference) || 0}))};
    },
    /** The company's account balances from its general ledger, each in its natural direction, with its kind. */
    async books(company) {
      const filters = JSON.stringify([['company', '=', company]]);
      const [accounts, gl] = await Promise.all([
        get('/api/resource/Account?limit_page_length=1000&fields=' + encodeURIComponent('["name","root_type"]') + '&filters=' + encodeURIComponent(filters)),
        get('/api/resource/GL%20Entry?limit_page_length=5000&fields=' + encodeURIComponent('["account","debit","credit"]')
          + '&filters=' + encodeURIComponent(JSON.stringify([['company', '=', company], ['is_cancelled', '=', 0]])))]);
      const kind = Object.fromEntries((accounts.data || []).map(a => [a.name, String(a.root_type || '').toLowerCase()]));
      const net = {};
      for (const r of gl.data || []) net[r.account] = (net[r.account] || 0) + (Number(r.debit) || 0) - (Number(r.credit) || 0);
      // Assets and expenses are debit balances; liabilities, equity and income are credit balances.
      return Object.entries(net).map(([account, debit]) => ({account, kind: kind[account] || 'asset',
        balance: ['asset', 'expense'].includes(kind[account] || 'asset') ? debit : -debit})).filter(l => Math.abs(l.balance) > 0.004);
    },
    /** What ERPNext's standard accounts are for, shown beside the entries that use them. */
    accountNotes: {
      'Stock In Hand': 'the value of goods on your shelves. Receipts add to it; deliveries take from it.',
      'Stock Received But Not Billed': 'a clearing account. The receipt credits it for goods that arrived before their bill; the supplier’s bill debits it back to zero, so goods and bills can arrive in either order.',
      'Creditors': 'what you owe suppliers. Bills add to it; payments reduce it.',
      'Debtors': 'what customers owe you. Sales invoices add to it; payments received reduce it.',
      'Cost of Goods Sold': 'what the goods you delivered cost you. With perpetual inventory ERPNext posts it when goods leave the warehouse, at their valuation rate, not when you bill.',
      'Sales': 'income from what you sold, posted by the sales invoice.',
      'Cash': 'money in hand. Payments received add to it; payments made reduce it.',
    },
    /** The application's own statements, opened for the learner's company. */
    reports: [
      {label: 'Profit and Loss', open: company => { frappe.route_options = {company}; return frappe.set_route('query-report', 'Profit and Loss Statement'); }},
      {label: 'General Ledger', open: company => { frappe.route_options = {company}; return frappe.set_route('query-report', 'General Ledger'); }},
    ],
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
