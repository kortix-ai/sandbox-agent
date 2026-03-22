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
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.28.2

RUN curl -fsSL "https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh" | sh

ENV PATH="/root/.local/bin:${PATH}"
ENV SANDBOX_AGENT_BIN="/root/.local/bin/sandbox-agent"
ENV RIVET_RUNNER_VERSION_FILE=/etc/foundry/rivet-runner-version
RUN mkdir -p /etc/foundry \
  && date +%s > /etc/foundry/rivet-runner-version

WORKDIR /app

CMD ["bash", "-lc", "git config --global --add safe.directory /app >/dev/null 2>&1 || true; pnpm install --frozen-lockfile --filter @sandbox-agent/foundry-backend... && pnpm --filter @sandbox-agent/foundry-shared build && pnpm --filter @sandbox-agent/foundry-backend build && exec node foundry/packages/backend/dist/index.js start --host 0.0.0.0 --port 7741"]
