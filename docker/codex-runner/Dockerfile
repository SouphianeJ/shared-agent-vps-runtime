FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        openssh-client \
        python3 \
    && npm install -g @openai/codex \
    && npm_config_ignore_scripts=false npm install -g @github/copilot \
    && rm -rf /var/lib/apt/lists/*

ENV RUNTIME_ROOT=/runtime

RUN mkdir -p /runtime \
    && chown -R node:node /runtime /home/node

COPY docker/codex-runner/entrypoint.sh /usr/local/bin/agent-runtime-entrypoint
RUN chmod 755 /usr/local/bin/agent-runtime-entrypoint

USER node
WORKDIR /runtime

ENTRYPOINT ["agent-runtime-entrypoint"]
CMD ["sleep", "infinity"]
