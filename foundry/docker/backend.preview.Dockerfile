# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim

ARG SANDBOX_AGENT_VERSION=0.3.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gh \
    openssh-client \
  && npm install -g pnpm@10.28.2 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh" | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV SANDBOX_AGENT_BIN="/root/.local/bin/sandbox-agent"
ENV RIVET_RUNNER_VERSION_FILE=/etc/foundry/rivet-runner-version
RUN mkdir -p /etc/foundry \
  && date +%s > /etc/foundry/rivet-runner-version

WORKDIR /workspace/quebec

COPY quebec /workspace/quebec

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sandbox-agent/foundry-shared build
RUN pnpm --filter @sandbox-agent/foundry-client build
RUN pnpm --filter @sandbox-agent/foundry-backend build

CMD ["bash", "-lc", "git config --global --add safe.directory /workspace/quebec >/dev/null 2>&1 || true; exec node packages/backend/dist/index.js start --host 0.0.0.0 --port 7841"]
