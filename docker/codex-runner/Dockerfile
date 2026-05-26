FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY browser-mcp/package.json /app/browser-mcp/package.json
COPY browser-provisioner/package.json /app/browser-provisioner/package.json
COPY mistral-agent/package.json /app/mistral-agent/package.json
COPY persist-mcp/package.json /app/persist-mcp/package.json
COPY browser-mcp /app/browser-mcp
COPY browser-provisioner /app/browser-provisioner
COPY mistral-agent /app/mistral-agent
COPY persist-mcp /app/persist-mcp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        awscli \
        bash \
        ca-certificates \
        curl \
        gh \
        git \
        jq \
        less \
        novnc \
        openssh-client \
        python3 \
        python3-chardet \
        websockify \
        x11vnc \
        xvfb \
    && npm install -g @openai/codex \
    && npm_config_ignore_scripts=false npm install -g @github/copilot \
    && npm --prefix /app/browser-mcp install --omit=dev \
    && npm --prefix /app/browser-provisioner install --omit=dev \
    && npm --prefix /app/mistral-agent install --omit=dev \
    && npm --prefix /app/persist-mcp install --omit=dev \
    && npx --prefix /app/browser-mcp playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV RUNTIME_ROOT=/runtime

RUN mkdir -p /runtime \
    && mkdir -p /ms-playwright \
    && chown -R node:node /runtime /home/node /ms-playwright

COPY docker/codex-runner/entrypoint.sh /usr/local/bin/agent-runtime-entrypoint
RUN chmod 755 /usr/local/bin/agent-runtime-entrypoint

USER node
WORKDIR /runtime

ENTRYPOINT ["agent-runtime-entrypoint"]
CMD ["sleep", "infinity"]
