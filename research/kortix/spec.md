# Kortix v1: ACP-Native Runtime Control Plane

Status: DRAFT for review — 2026-06-12
Design conversation: Claude Code session `a0c5f00b-06fb-4d18-8bd7-ccac4a14484c` (`claude --resume a0c5f00b-06fb-4d18-8bd7-ccac4a14484c`).
Fork of rivet-dev/sandbox-agent (upstream dead since 2026-03-30). This spec supersedes and builds on upstream's own unexecuted ACP migration plan in `research/acp/` (esp. `spec.md`, `v1-schema-to-acp-mapping.md`, `rfds-vs-extensions.md`), which we inherit as the protocol/transport baseline. This document defines the Kortix deltas and product architecture on top.

## 1. Decision summary

- Hard fork, permanent divergence accepted. Upstream: last push 2026-03-30, 75 open issues.
- Execute upstream's ACP-native v1 plan: delete the in-house universal-event schema, expose ACP directly over HTTP, runtimes driven exclusively through ACP agent processes. No agent-specific JSON parsing in server core.
- The daemon runs on a server/sandbox and manages OpenCode / Claude Code / Codex / (Amp/Cursor/…) through ONE uniform API.
- The Kortix platform API (apps/api) is the single central API that fronts N daemons. Clients (web, CLI, SDK) only ever talk to the central API.
- Terminology fix (the founding gripe): what upstream calls "agent" is the RUNTIME. In Kortix, "agent" = user-defined persona. Code rename: `AgentId` → `RuntimeId`, `/v1/agents` → `/v1/runtimes` (control plane).

## 2. Topology

```
web / CLI / SDK
      │  (Kortix API: REST for product resources + ACP-over-HTTP relay for sessions)
      ▼
Kortix platform API  ── persists ACP envelope log, owns catalogs/policy/tenancy/billing
      │  (relay, per-sandbox routing, KORTIX_TOKEN auth)
      ▼
daemon (this fork) — one per sandbox/server
      │  (ACP JSON-RPC over stdio)
      ▼
runtime adapter processes: opencode (native ACP) | claude-code-acp | codex-acp | …
```

## 3. Protocol rules

1. **ACP-native wherever ACP has a primitive.** Sessions, prompts, streaming updates, tool calls, permissions, plans, modes, config options, command advertisement, attachments (content blocks), MCP wiring (`session/new.mcpServers` — verified: opencode registers them per-session, `acp/service.ts:186,193`), fs and terminal client capabilities.
2. **Extensions under `_kortix/*` methods and `_meta["kortix.dev"]`** (replacing `_sandboxagent/*` / `_meta["sandboxagent.dev"]`). Carried over from upstream's set: session detach/terminate/ended, list_models, set_metadata, request_question.
3. **Host capabilities stay plain HTTP** (upstream's boundary rule, kept verbatim): binary file streaming (`/fs/file`, upload-batch), runtime install/control plane, health, PTY WS, processes — plus Kortix additions: git (credential helper, commit-push), preview/port proxies, dynamic env store (§9).
4. **Transport:** ACP-over-HTTP per `research/acp/spec.md` — `POST /rpc` (client→agent JSON-RPC), `GET /rpc` SSE (agent→client envelopes), `DELETE /rpc`, `X-ACP-Connection-Id`, `Last-Event-ID` replay. OPEN DECISION: WebSocket profile instead/additionally (community pilots report simpler bidirectional handling; we already run WS proxying in prod).

## 4. Primitive ownership

| Primitive | Owner | Boundary crossing |
|---|---|---|
| Prompt turns, streaming, tool calls, plans | ACP | `session/prompt` + `session/update` |
| Permission requests | ACP | `session/request_permission` |
| Permission policy (auto-approve rules, posture) | Kortix | our layer answers or forwards to human |
| Modes / in-session model switch | ACP wire, Kortix semantics | per-runtime interpretation table (§6) |
| Config options | ACP wire, Kortix semantics | `session/set_config_option`; render from interpretation, never raw |
| **Agents (personas)** | Kortix catalog | compiled per-runtime, materialized pre-`session/new`; round-trips as opencode modes |
| **Skills** | Kortix catalog | materialized (`.claude/skills/`, `.opencode/skill/`); surface as commands/tools on wire |
| **Commands ("/" saved)** | Kortix catalog | materialized (`.claude/commands/`, `.opencode/command/`, `~/.codex/prompts`); advertised back via `available_commands_update`; UI joins on our catalog |
| **Runtimes** | Kortix control plane | catalog, baked versions, capability matrix, explicit `runtime` field at session create |
| MCP / connectors | Kortix catalog | wired ACP-native via `session/new.mcpServers`; materialization fallback per adapter support |
| Custom tools | Kortix | = MCP servers we provide (executor etc.); no separate ACP primitive |
| Attachments | ACP | content blocks (text/image/resource/resource_link); upload via host fs HTTP, referenced in prompt |
| Models catalog (pre-session, billing-aware) | Kortix | acknowledged ACP gap (upstream RFD list); in-session switch via `set_model`/config option |
| Sessions (durable) | Kortix | session row + persisted ACP envelope log; ACP sessionId = ephemeral binding, re-bound via `resume`/`load` |
| fs / terminal client capabilities | daemon implements | ACP inversion: agent asks client → universal edit-interception point across all runtimes |
| Env / credentials | Kortix (dynamic, §9) | env store + supervised restart; upstream is static `spawn.env` only |
| Workspace/git/previews/processes/desktop | Kortix host HTTP | never on ACP |

**Catalog pattern:** agents, skills, commands are ONE shaped primitive — versioned, fetchable, renderable (our metadata: description, icon, source), materializable per-runtime. Registry/marketplace direction applies to all three uniformly.

## 5. Session start pipeline

1. Client → Kortix API: `POST /sessions {project, agent, runtime, model, …}` (ownership of all session-start primitives is ours; ACP is not consulted yet).
2. Kortix API resolves agent def + skills + commands + connectors + env → claims sandbox → **materializes** compiled config into workspace → stages per-session env overlay via host HTTP (§9) → daemon spawns a dedicated adapter process for this session with the merged env.
3. ACP `initialize` → capture negotiated capability matrix onto the session record.
4. ACP `session/new` with `cwd`, `mcpServers`, `_meta["kortix.dev"] = {kortixSessionId, agent, …}` (bootstrap reference only — no secrets on the wire, §9).
5. Everything after is wire-level ACP, relayed + persisted by the central API.

## 6. Mode / config-option interpretation (verified facts)

- **opencode** advertises **its agents as ACP session modes** (`sst/opencode` `packages/opencode/src/acp/directory.ts:118-126`: `agent.list()` minus subagents/hidden → `availableModes`). Agent switch = `session/set_mode`. Also exposes mode+model+variants via `set_config_option`, `unstable_setSessionModel`.
- **claude-code-acp** (Zed, ACTIVE — v0.44.0 on 2026-06-09) advertises **permission modes** as ACP modes; slash commands, client MCP, terminals, todo, edit review supported.
- Same primitive, different semantics → Kortix owns a small per-runtime interpretation table; UI renders Kortix concepts (agent picker, permission posture), never raw mode lists.
- **Persona switch cost** is part of the runtime capability matrix: opencode = instant `set_mode`; claude/codex = recompile → graceful restart → `session/resume` (same machinery as §8).

## 7. Pre-session knobs (non-ACP, non-universal)

Effort level, system prompts, skills, MCP files — filesystem/config materialization before `session/new`. Per upstream's `research/wip-agent-support.md` matrix: custom agents = opencode-only; system-prompt replace = codex-only; permission models differ. The materializer compiles Kortix agent definitions into each runtime's idiom; gaps are recorded in the capability matrix rather than papered over.

## 8. Supervision (config invalidation, crash, persona switch — one machine)

- Fingerprint (content-hash) the materialization inputs: compiled agent/skill/command artifacts, MCP config, env/credentials, runtime config dirs.
- On drift: recompile → graceful adapter restart (drain or abort in-flight turn) → re-attach via ACP `session/resume`/`session/load` (capability-gated; unstable methods adopted per upstream spec §3).
- Same path serves: config invalidation, crash recovery (process runtime RestartPolicy exists upstream; the watcher does not — we build it), persona switch on non-opencode runtimes, env/credential rotation (§9), and snapshot park/claim respawn.
- Sessions survive because Kortix owns session identity; ACP sessionIds are re-bound.

## 9. Per-session env & LLM credentials (Kortix delta — upstream is static + daemon-global)

Upstream: credentials only via `spawn.env` at DAEMON start (one env for everything); config-file extraction fallbacks; explicitly no runtime mutation. Kortix requirement: **env is a per-SESSION-start concern, changeable while running.**

- **Env scoping:** daemon env store holds a `base` scope (sandbox-level: KORTIX_TOKEN, KORTIX_API_URL) plus a **per-session overlay** supplied at session start by the central API (compiled from project env, connectors, user input). Effective env for a session = base ∪ overlay.
- **Process model consequence (explicit upstream override):** upstream spec §4.2 shares one adapter process per runtime type ("agent processes are shared per AgentId"). Per-session env requires **one adapter process per session** — env is process-level in Unix; there is no per-ACP-session env primitive in any runtime. Kortix v1 spawns a dedicated adapter process per session with the merged env; session terminate reaps it. Side benefits: hard credential isolation between sessions on the same box, per-session restart blast radius, and it matches the stateful-snapshot park/claim model already shipped (runtime respawns on claim with per-session creds).
- **Secrets never ride ACP:** the session event log persists raw envelopes (§10), so env must NOT travel in `session/new` `_meta`. Flow: central API stages the overlay via host HTTP (`PUT /sessions/:bootstrapId/env`, token-authed, tmpfs-backed — never disk) BEFORE `session/new`; the ACP message carries only the bootstrap reference.
- **Mid-session change:** `PUT` the overlay → supervised restart of THAT session's adapter only (§8) → `session/resume`. Other sessions untouched; user perceives a continuous session.
- **LLM credentials:** runtimes point at the Kortix LLM router via base-URL override with per-session ephemeral tokens (two-var contract derived). Billing/budget/attribution at our router; rotation = overlay update → supervised restart; no session loss. BYOK: tenant keys flow through the same overlay with the same semantics.

## 10. Persistence

- The session event log = raw, sequenced ACP envelopes persisted by the central API (replaces opencode_session_id pinning entirely).
- Replay and live streaming are the same format; the renderer doesn't know the difference.
- Daemon keeps only an in-memory ring buffer for SSE `Last-Event-ID` resumption; durability is host-side.

## 11. SDK & frontend

- **No second ACP implementation** (upstream rule, kept): the Kortix TS SDK wraps `@agentclientprotocol/sdk` (`ClientSideConnection`, protocol types) with a custom ACP-over-HTTP transport pointed at the central API relay, plus auth/bootstrap convenience and product helper APIs.
- The web frontend does NOT reimplement ACP: it consumes the Kortix SDK — envelope renderer for sessions (live + replay), REST for catalogs (agents/skills/commands/models), host HTTP for PTY/files/previews.
- **OpenCode-compatible API bridge** (upstream Phase 7, `/opencode/*`): kept as an optional compatibility surface so existing OpenCode-speaking frontends/CLI plug-n-play during migration. Demoted from primary API to transitional bridge; re-enabled only after ACP core is stable.
- Inspector UI: keep, make ACP-native per upstream spec §6.2; useful as the daemon-level debug surface.

## 12. Runtime install model

- Adapters pinned via manifest (upstream §5.2/5.3): `claude` → `claude-code-acp`, `codex` → `codex-acp`, `opencode` → native ACP mode.
- Production: binaries BAKED into sandbox snapshots; `require_preinstall=true`; no lazy registry installs (supply chain + warm-boot latency). Registry (`cdn.agentclientprotocol.com`) used at bake time only, with provenance recorded.

## 13. Security

- Bearer token = `KORTIX_TOKEN`; daemon never holds real host credentials (git via credential-helper proxy, LLM via router tokens).
- Strip `tc.rivet.dev` telemetry (default off, then delete).
- Branding: add `Kortix` to `BrandingMode`.

## 14. Migration phases (product)

1. **Spike:** bake daemon into snapshot beside kortix-sandbox-agent-server, behind experimental flag; one Claude Code session e2e through the relay.
2. **ACP core:** execute upstream `research/acp/migration-steps.md` with Kortix deltas (`_kortix` namespace, baked installs, env store, supervision watcher).
3. **Host absorption:** PTY/files/process traffic moves to daemon; kortix-sandbox-agent-server shrinks to git/previews/boot orchestration (or merges in as host-HTTP routes).
4. **Persistence cutover:** ACP envelope log replaces opencode session pinning; frontend renderer consumes envelopes (opencode-compat bridge available as fallback).
5. **Catalogs:** agents/skills/commands unified primitive + materializers; registry/marketplace direction.

## 15. Open decisions

- Transport: SSE profile (upstream spec) vs WebSocket — decide in spike.
- Fork naming vs existing `kortix-sandbox-agent-server` (confusable); rename repo/binary?
- How much of upstream `/v1` REST survives vs HTTP 410 (upstream wanted hard removal; we may keep fs/process/PTY surface).
- Desktop runtime: keep (slots into experimental Computers) — default keep.
- Amp/Cursor/Gemini support tier at launch (registry has ~35 adapters; we pin what we bake).
- Rust ownership: we are a TS shop; core daemon is Rust (axum/tokio). Accepted cost; revisit per-component.

## 16. Verified source references

- opencode agents→modes: `sst/opencode` `packages/opencode/src/acp/directory.ts:118-126`
- opencode MCP at session/new: `packages/opencode/src/acp/service.ts:186,193`
- opencode set_model/config options: `packages/opencode/src/acp/agent.ts:71-76`, `config-option.ts`
- claude-code-acp activity: v0.44.0, 2026-06-09, 104 releases
- Upstream ACP plan: `research/acp/spec.md` (transport, SDK mandate, fs boundary), `rfds-vs-extensions.md` (RFD vs `_kortix` extension sorting), `v1-schema-to-acp-mapping.md`
- Upstream credentials = static spawn.env: sandboxagent.dev/docs/llm-credentials
