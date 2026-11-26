# Course runtime. Edit this recipe or requirements.txt, then select the course again.
FROM docker.io/library/node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node_runtime
FROM docker.io/library/python@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 util-linux sudo git curl \
 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash learner \
 && printf 'ALL ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/dhimantai-course \
 && chmod 440 /etc/sudoers.d/dhimantai-course
RUN python -m pip install --no-cache-dir ipykernel==6.29.5 nbformat==5.10.4 \
 && python -m ipykernel install --prefix=/usr/local --name=python3 --display-name='dhimantAI Python'

COPY runtime/ /opt/dhimantai/
RUN chmod -R a+rX /opt/dhimantai && sh /opt/dhimantai/shell.sh \
 && install -m 755 /opt/dhimantai/language.sh /usr/local/sbin/dhimantai-language \
 && for item in javascript postgres redis; do /usr/local/sbin/dhimantai-language "$item" || exit 1; done \
 && for item in python; do /usr/local/sbin/dhimantai-language "$item" || exit 1; done \
 && usermod --shell /bin/zsh learner && rm -rf /var/lib/apt/lists/* /root/.cache
ENV SHELL=/bin/zsh PATH=/usr/lib/postgresql/17/bin:$PATH
RUN python -m pip check && python -c "import ipykernel, nbformat"
USER learner
WORKDIR /course
CMD ["sleep", "infinity"]
