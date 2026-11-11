"""Add the guide to the pinned ERPNext Desk template and its existing static asset directory."""
from pathlib import Path
import shutil

bench = Path('/home/frappe/frappe-bench')
template = bench / 'apps/frappe/frappe/www/desk.html'
text = template.read_text()
assert text.count('</body>') == 1, 'ERPNext Desk template changed; review the guide integration'
assets = bench / 'apps/frappe/frappe/public/dhimantai'
assets.mkdir(exist_ok=True)
for name in ('guide.js', 'live.js', 'course.json', 'launch.html', 'launch.js'):
    shutil.copyfile(Path('/opt/dhimantai') / name, assets / name)
template.write_text(text.replace('</body>', '<script defer src="/assets/frappe/dhimantai/guide.js"></script><script defer src="/assets/frappe/dhimantai/live.js"></script></body>'))
# The local browser origin is 127.0.0.1, while the single Frappe site is named frontend.
# Preserve the real Origin so Frappe's websocket origin check can compare it with Host.
nginx = Path('/templates/nginx/frappe.conf.template')
config = nginx.read_text()
old = 'proxy_set_header Origin $proxy_x_forwarded_proto://${FRAPPE_SITE_NAME_HEADER};'
assert config.count(old) == 1, 'Review the upstream websocket proxy configuration'
# Same-origin polling requests can omit Origin. Keep a supplied Origin intact;
# only infer it from the request host when absent (as in the browser's polling handshake).
config = ('map $http_origin $dhimantai_origin {\n'
          '  default $http_origin;\n'
          '  "" "$proxy_x_forwarded_proto://$http_host";\n'
          '}\n' + config)
config = config.replace(old, 'proxy_set_header Origin $dhimantai_origin;')
# Keep the published loopback port in absolute login/logout redirects.
assert 'proxy_set_header Host $host;' in config
nginx.write_text(config.replace('proxy_set_header Host $host;', 'proxy_set_header Host $http_host;'))
