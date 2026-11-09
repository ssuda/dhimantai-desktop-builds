# Course runtime. Edit this recipe or requirements.txt, then select the course again.
FROM docker.io/library/node:22-bookworm-slim AS node_runtime
FROM docker.io/library/python:3.12-slim-bookworm
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 util-linux sudo git curl \
 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash learner \
 && printf 'ALL ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/dhimantai-course \
 && chmod 440 /etc/sudoers.d/dhimantai-course
RUN python -m pip install --no-cache-dir ipykernel==6.29.5 nbformat==5.10.4 \
 && python -m ipykernel install --prefix=/usr/local --name=python3 --display-name='dhimantAI Python'
COPY requirements.txt /opt/dhimantai/requirements.txt
RUN python -m pip install --no-cache-dir -r /opt/dhimantai/requirements.txt
# COURSE_EXTRA_INSTALL
COPY runtime/ /opt/dhimantai/
RUN chmod -R a+rX /opt/dhimantai && sh /opt/dhimantai/shell.sh \
 && install -m 755 /opt/dhimantai/language.sh /usr/local/sbin/dhimantai-language \
 && /usr/local/sbin/dhimantai-language COURSE_LANGUAGE \
 && usermod --shell /bin/zsh learner
ENV SHELL=/bin/zsh
USER learner
WORKDIR /course
CMD ["sleep", "infinity"]
