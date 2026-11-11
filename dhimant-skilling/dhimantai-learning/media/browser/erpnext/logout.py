"""Revoke only the learning account leaving this desktop session."""
import re
import os
import sys
import frappe
from frappe.sessions import clear_sessions

assert re.fullmatch(r'[a-f0-9]{20}', sys.argv[1])
os.chdir('/home/frappe/frappe-bench/sites')
frappe.init(site='frontend', sites_path='/home/frappe/frappe-bench/sites')
frappe.connect()
try:
    clear_sessions(user=f'learner-{sys.argv[1]}@training.invalid', force=True)
    frappe.db.commit()
finally:
    frappe.destroy()
