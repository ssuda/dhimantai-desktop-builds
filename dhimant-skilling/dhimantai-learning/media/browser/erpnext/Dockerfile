# ERPNext v16.54.0, upstream multi-architecture manifest (amd64 + arm64).
FROM docker.io/frappe/erpnext@sha256:32145acc7f699dc598ca141018a95ebf8e56f516d4a0e76beb7287ae68b303b8
COPY --chown=frappe:0 . /opt/dhimantai/
USER root
RUN /home/frappe/frappe-bench/env/bin/python /opt/dhimantai/install.py
USER frappe
