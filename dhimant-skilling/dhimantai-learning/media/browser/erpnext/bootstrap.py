"""Idempotent prerequisites only. Learners create the documents used by the course checks."""
from datetime import date
import os
import frappe

os.chdir('/home/frappe/frappe-bench/sites')
frappe.init(site='frontend', sites_path='/home/frappe/frappe-bench/sites')
frappe.connect()
try:
    frappe.set_user('Administrator')
    if not frappe.db.get_single_value('System Settings', 'setup_complete'):
        from frappe.desk.page.setup_wizard.setup_wizard import setup_complete
        year = date.today().year
        result = setup_complete({
            'language': 'English', 'country': 'India', 'timezone': 'Asia/Kolkata',
            'currency': 'INR', 'full_name': 'Training Learner',
            'company_name': 'dhimantAI Training', 'company_abbr': 'DT',
            'chart_of_accounts': 'Standard', 'fy_start_date': f'{year}-01-01',
            'fy_end_date': f'{year}-12-31', 'enable_telemetry': 0,
        })
        if result.get('status') != 'ok':
            raise RuntimeError('ERPNext company setup did not finish')
    learner = os.environ['DHIMANTAI_LEARNER']
    tag = learner[:10]
    email = f'learner-{learner}@training.invalid'
    company = f'Training {tag}'
    roles = ['Accounts User', 'Sales User', 'Purchase User', 'Stock User',
             'Manufacturing User', 'Purchase Master Manager', 'Item Manager']
    if not frappe.db.exists('Company', company):
        frappe.get_doc({'doctype': 'Company', 'company_name': company, 'abbr': tag,
                        'default_currency': 'INR', 'country': 'India',
                        'chart_of_accounts': 'Standard'}).insert()
    if not frappe.db.exists('User', email):
        frappe.get_doc({'doctype': 'User', 'email': email, 'first_name': 'Learner ' + tag,
                        'send_welcome_email': 0, 'new_password': os.environ['DHIMANTAI_LEARNER_PASSWORD'],
                        'roles': [{'role': role} for role in roles]}).insert()
    else:
        # Reconnect retained volumes after local credential storage is restored or replaced.
        from frappe.utils.password import update_password
        update_password(email, os.environ['DHIMANTAI_LEARNER_PASSWORD'])
        frappe.get_doc('User', email).add_roles(*roles)
    # One local ERPNext instance, separate logins and company-scoped transactional data.
    if not frappe.db.exists('User Permission', {'user': email, 'allow': 'Company', 'for_value': company}):
        frappe.get_doc({'doctype': 'User Permission', 'user': email, 'allow': 'Company',
                        'for_value': company, 'apply_to_all_doctypes': 1}).insert()
    frappe.defaults.set_user_default('Company', company, user=email)
    # A manufactured item is a prerequisite; its BOM is the learner's work.
    kit = f'TRAINING-KIT-{tag}'
    if not frappe.db.exists('Item', kit):
        frappe.get_doc({'doctype': 'Item', 'item_code': kit,
                        'item_name': 'Training Kit', 'item_group': 'Products',
                        'stock_uom': 'Nos', 'is_stock_item': 1}).insert()
    frappe.db.commit()
finally:
    frappe.destroy()
