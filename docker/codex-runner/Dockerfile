FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY browser-mcp/package.json /app/browser-mcp/package.json
COPY persist-mcp/package.json /app/persist-mcp/package.json

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
        openssh-client \
        python3 \
    && npm install -g @openai/codex \
    && npm_config_ignore_scripts=false npm install -g @github/copilot \
    && npm --prefix /app/browser-mcp install --omit=dev \
    && npm --prefix /app/persist-mcp install --omit=dev \
    && npx --prefix /app/browser-mcp playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV RUNTIME_ROOT=/runtime

RUN mkdir -p /runtime \
    && mkdir -p /ms-playwright \
    && chown -R node:node /runtime /home/node /ms-playwright

COPY docker/codex-runner/entrypoint.sh /usr/local/bin/agent-runtime-entrypoint
RUN chmod 755 /usr/local/bin/agent-runtime-entrypoint

COPY browser-mcp /app/browser-mcp
COPY persist-mcp /app/persist-mcp

USER node
WORKDIR /runtime

ENTRYPOINT ["agent-runtime-entrypoint"]
CMD ["sleep", "infinity"]
