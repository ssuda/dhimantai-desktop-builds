"""The training Desk reads dimension metadata without administering dimensions."""
import frappe
from frappe.permissions import add_permission


ROLE = 'DhimantAI Learner'


def ensure_training_permissions():
    if not frappe.db.exists('Role', ROLE):
        frappe.get_doc({'doctype': 'Role', 'role_name': ROLE, 'desk_access': 1}).insert()
    # ERPNext's financial widgets fetch this list even when no custom dimensions
    # exist. Standard Accounts User cannot read it. Keep all existing manager
    # permissions; grant training learners only read access to this metadata.
    if not frappe.db.exists('Custom DocPerm', {
        'parent': 'Accounting Dimension', 'role': ROLE, 'permlevel': 0, 'if_owner': 0,
    }):
        add_permission('Accounting Dimension', ROLE, ptype='read')
        frappe.clear_cache(doctype='Accounting Dimension')
