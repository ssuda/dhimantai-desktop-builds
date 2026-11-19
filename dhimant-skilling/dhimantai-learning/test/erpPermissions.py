"""Run with the pinned ERPNext image's Python against a local training site.

Copy this file and media/browser/erpnext/training_permissions.py to /tmp, then
run /home/frappe/frappe-bench/env/bin/python /tmp/erpPermissions.py.
All database changes are rolled back. No course records are written.
"""
import os
import frappe
from training_permissions import ROLE, ensure_training_permissions


os.chdir('/home/frappe/frappe-bench/sites')
frappe.init(site='frontend', sites_path='/home/frappe/frappe-bench/sites')
frappe.connect()
learner = None
try:
    frappe.set_user('Administrator')
    learners = frappe.get_all('User', filters={'email': ['like', 'learner-%@training.invalid']}, pluck='name')
    assert learners, 'Provision a local training learner before this check'
    learner = learners[0]
    ensure_training_permissions()
    ensure_training_permissions()
    assert frappe.db.count('Custom DocPerm', {'parent': 'Accounting Dimension', 'role': ROLE}) == 1
    frappe.get_doc('User', learner).add_roles(ROLE)
    frappe.set_user(learner)
    # This is the exact query used by ERPNext's financial statements widget.
    frappe.get_list('Accounting Dimension', fields=['document_type'], filters={'disabled': 0})
    assert frappe.has_permission('Accounting Dimension', 'read')
    for permission in ('create', 'write', 'delete'):
        assert not frappe.has_permission('Accounting Dimension', permission), permission
    assert not {'Accounts Manager', 'System Manager'} & set(frappe.get_roles())
    # Other learners have no new dimension permissions until their own setup.
    if len(learners) > 1 and ROLE not in frappe.get_roles(learners[1]):
        assert not frappe.has_permission('Accounting Dimension', 'read', user=learners[1])
    print('PASS: dimension query, read-only access, idempotence, learner isolation')
finally:
    frappe.db.rollback()
    if learner:
        frappe.clear_cache(user=learner)
    frappe.clear_cache(doctype='Accounting Dimension')
    frappe.destroy()
