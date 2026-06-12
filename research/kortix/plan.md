# Kortix v1 — Execution Plan

Status: DRAFT — 2026-06-13. Companion to `research/kortix/spec.md` (the WHAT/WHY; this is the HOW/WHEN).
Design conversation: Claude Code session `a0c5f00b-06fb-4d18-8bd7-ccac4a14484c` (`claude --resume a0c5f00b-06fb-4d18-8bd7-ccac4a14484c`) — full fork/ACP design discussion of 2026-06-12/13.
Repos touched: `kortix-ai/sandbox-agent` (this fork, "the daemon"), `kortix-ai/suna` (`apps/api` = central API, `apps/web`, `apps/cli`, `apps/kortix-sandbox-agent-server` = legacy daemon to be absorbed/retired).

Phase ordering is dependency-driven; ①②④ contain the critical path. ⑤⑥ parallelize against late ②/④. Sizing: S = days, M = 1–2 wk, L = 3+ wk of focused work.

---

## Phase 0 — Fork hygiene (S)

Make the fork ours, buildable, and safe before feature work.

- [ ] CI green on `kortix-ai/sandbox-agent`: Rust workspace build (`cargo build --release -p sandbox-agent`), TS workspace (pnpm), Docker-backed integration tests. Disable upstream release/publish workflows.
- [ ] Telemetry: flip `tc.rivet.dev` reporting to default-OFF immediately; delete `telemetry.rs` wiring in Phase 2 teardown.
- [ ] Branding: add `Kortix` to `BrandingMode` (router.rs:59); leave binary name as-is until naming decision (D2, §Decisions).
- [ ] Delete `foundry/` (separate webapp, unused). Keep `gigacode/` (free TUI debug client against our compat surface).
- [ ] License: keep Apache-2.0, add NOTICE documenting modifications.
- [ ] Adapter manifest scaffold: pinned versions for `claude-code-acp`, `codex-acp`, `opencode` (native ACP); `SANDBOX_AGENT_ACP_REGISTRY_URL` honored for bake-time fetch only.
- [ ] Repo settings: branch protection on main mirroring suna-light (gitleaks), CODEOWNERS.

Exit gate: clean clone → CI green → release binary builds for linux-x64-musl + darwin-arm64.

## Phase 1 — Spike: one Claude Code session e2e (M) ← DE-RISKING GATE

Goal: prove the whole vertical — baked daemon in a Daytona snapshot, relay through apps/api, Claude Code runtime, streamed events — before committing to the big build. Use the daemon AS-IS (current `/v1` + ACP endpoints); no fork feature work beyond Phase 0.

- [ ] Build static `sandbox-agent` binary (linux-x64-musl); record size + startup time.
- [ ] Bake into the default snapshot via `dockerfile-layer.ts` (same pattern as the kortix CLI bake; pre-built artifact rides the API image, fingerprinted on fork-src).
- [ ] Pre-bake `claude-code-acp` + claude binary; run daemon with `--token $KORTIX_TOKEN`, preinstall required.
- [ ] Daemon starts alongside `kortix-sandbox-agent-server` (port 2468; no behavior coupling).
- [ ] Minimal relay in `apps/api` sandbox-proxy → daemon (HTTP + SSE passthrough), gated by a new experimental flag `acp_runtimes` in `apps/api/src/experimental/features.ts`.
- [ ] Script-driven session: create → prompt → streamed response, with ANTHROPIC creds injected via spawn env (per-session env lands in Phase 2; static is fine for spike).
- [ ] Measure: boot delta on warm path (daemon start + adapter spawn + initialize + session/new), SSE behavior through Cloudflare/ALB/WAF (we have prior `*_BODY` 403 scar tissue — test big prompts), event latency.
- [ ] **Decide D1 (transport)**: SSE profile vs WebSocket, based on observed relay behavior through our prod-like edge.

Exit gate: prompt→streamed-response round trip from a script against dev API; boot-cost and transport report; go/no-go + D1 decided.

## Phase 2 — ACP core in the fork (L) ← THE BIG BUILD

Execute upstream's `research/acp/` plan (spec.md, migration-steps.md, 00-delete-first.md) with Kortix deltas. This is mostly Rust.

> Verified at fork point (ab3ff01b, 2026-06-13): upstream's `server/CLAUDE.md` describes this phase's END state as if done — it is NOT. HEAD has no `/v1/rpc`, no `acp_runtime/`; `universal_events.rs`, legacy `/v1` session REST, and `opencode_compat.rs` are all still present. The implemented ACP starting point is `/v1/acp` + `/v1/acp/stream/:server_id` via `acp_proxy_runtime.rs` (per-AgentId shared processes). Both CLAUDE.md files carry fork-status notes to prevent agents trusting the aspirational text.

**Upstream archaeology (2026-06-13) — where their ACP work actually lives:**
- The ACP-native rewrite was started ON MAIN and aborted: PR #155 "acp spec" (merged 2026-02-11) added `acp_runtime/{backend,ext_meta,ext_methods,helpers,mock,mod}.rs` + the rewritten CLAUDE.md/docs; hours later `94353f76` "chore: fix bad merge" deleted the code but left the docs text — the source of the aspirational CLAUDE.md. Even at peak (#155) there was no `/v1/rpc` transport and universal_events was untouched (scaffolding only). View the deleted scaffolding: `git show e72eb9f6`.
- **`03-30-feat_server_client_acp_add_specific_header_for_restoring_history` = v0.5.0-rc.3 — upstream's TRUE final state** (4 days past main, +217/−53): SSE history-restore header in the TS client + opencode-adapter work + tags v0.5.0-rc.1..rc.3. Directly relevant to envelope replay/`Last-Event-ID`. See D8.
- `acp-permissions-sdk` (2026-03-10, 35 files +1785): TS SDK + acp-http-client permission flow (incl. fix preventing silent once→always escalation) + mock-agent tests → mine in P5.
- `geneva-v1` (2026-03-15): ACP SDK 0.16.1 pin + e2e guidance → grab pin.
- Feature PRs worth mining later: #223 builtin-agent-skills (auto-inject skills/CLAUDE.md at startup → P6 materializer), #301 opencode builtin commands via GET /opencode/command (→ P6 commands), #202 model/mode/thought-level config validation (→ config options), #225 hooks example.
- `recovery/*` branches = workspace dumps (foundry/UI), ignore.

**2a. Teardown** (per `00-delete-first.md`)
- [ ] Delete universal-agent-schema + extracted-agent-schemas crates, conversion docs, v1 session/event model. KEEP: fs, processes/PTY, desktop runtimes, agent-management (→ runtime-management).
- [ ] `/opencode/*` disabled during core bring-up (re-enabled Phase 5 only if needed — see D4).

**2b. Transport**
- [ ] `POST /rpc` (client→agent JSON-RPC), `GET /rpc` (SSE, monotonic ids, 15s heartbeat, `Last-Event-ID` ring-buffer replay), `DELETE /rpc` (idempotent close), `X-ACP-Connection-Id`, problem+json errors — or the WS profile if D1 says so.
- [ ] Bearer auth middleware on everything (`KORTIX_TOKEN`).

**2c. Per-session adapter processes** (explicit upstream override — spec §9)
- [ ] Session registry keyed by kortix bootstrap id; one adapter process per session, spawned with merged env (base ∪ overlay); reaped on `_kortix/session/terminate` or session end.
- [ ] Per-session restart blast radius; no cross-session env visibility.

**2d. Env store** (spec §9)
- [ ] `PUT/GET/DELETE /sessions/:bootstrapId/env` host HTTP; tmpfs-backed (verify like today's /dev/shm check); base scope at daemon start.
- [ ] Enforcement: reject/strip secrets in ACP `_meta` (envelope log is persisted — secrets never on the wire); test for it.

**2e. Supervision** (spec §8 — the one machine)
- [ ] Fingerprint watcher (notify crate) over materialized inputs: runtime config dirs, compiled agent/skill/command artifacts, MCP config, env overlay.
- [ ] Drift → recompile signal → graceful restart (drain or abort in-flight turn; define turn-drain semantics) → re-attach via `session/resume`/`session/load` per negotiated capability.
- [ ] Same path: crash recovery (RestartPolicy), env rotation, persona switch on non-opencode runtimes, snapshot park/claim respawn hook (`KORTIX_SNAPSHOT_PARK` integration point).

**2f. Extensions**
- [ ] `_sandboxagent/*` → `_kortix/*`; `_meta["sandboxagent.dev"]` → `_meta["kortix.dev"]`. Keep: detach, terminate, ended, list_models, set_metadata, request_question.

**2g. Runtime control plane**
- [ ] `AgentId` → `RuntimeId`; `/v1/agents` → `/runtimes`.
- [ ] Capability matrix per runtime: negotiated ACP caps + semantic layer (mode interpretation kind: personas|permission-postures; persona-switch cost: set_mode|restart-resume; models/modes folded into runtime payload per upstream mapping).
- [ ] Manifest-pinned installs, provenance (`registry`|`fallback`), `require_preinstall=true` default for prod builds.

**2h. Tests** (upstream test contract: real adapters, no synthetic fixtures)
- [ ] ACP conformance + transport contract suites.
- [ ] Runtime matrix in Docker: opencode + claude + codex — turn flow, cancel, permission round trip, streaming.
- [ ] Supervision suite: env change mid-session → restart → resume → history intact; config drift; crash; park/claim.
- [ ] Secrets-on-wire enforcement test.

**2i. Inspector** (lower priority)
- [ ] ACP-native rework per upstream spec §6.2; keep at `/ui/` as daemon-level debug surface.

Exit gate: 3-runtime matrix green in CI; mid-session env rotation with surviving session demonstrated; capability matrix returned correctly per runtime.

## Phase 3 — Host capability absorption (M) — fork ⊕ legacy daemon

One daemon ships. Port the Kortix-specific host routes from `apps/kortix-sandbox-agent-server` into the fork as host-HTTP modules.

- [ ] Git: credential helper endpoint + commit-push (port `git.ts`, `routes/git.ts`) — auths against the managed git proxy with `KORTIX_TOKEN`.
- [ ] Previews: static-web, web-proxy, port-proxy routes (port `static-web.ts`, `routes/port-proxy.ts`, `routes/web-proxy.ts`, `proxy-utils.ts`).
- [ ] Boot orchestration: repo materialization (clone → resolve config → ready), the materializer hook (Phase 6 consumes), project-env handling, abort/refresh routes.
- [ ] Park mode: `KORTIX_SNAPSHOT_PARK` equivalent in the fork daemon (stateful snapshots phase-1 parity).
- [ ] Parity checklist vs legacy daemon (file routes already covered by fork's `/fs`; PTY by `/processes/:id/terminal` — delete apps/api `ws-proxy.ts` opencode-PTY special-casing once cut over).
- [ ] Retire `apps/kortix-sandbox-agent-server` (keep until Phase 7 cutover; mark frozen).

Exit gate: a sandbox runs ONE daemon binary providing ACP sessions + git + previews + files + PTY; legacy daemon not in the new snapshot.

## Phase 4 — Central API integration (L) — suna `apps/api`

- [ ] **Relay**: ACP-over-HTTP(/WS) proxy under `/v1/sessions/:id/...` through the existing sandbox-proxy chokepoints (backend resolver + preview-auth pattern); SSE/WS passthrough hardened against ALB/WAF/Cloudflare.
- [ ] **Session pipeline** (spec §5): `POST /sessions {project, agent, runtime, model}` → resolve persona/skills/commands/connectors/env → claim sandbox → materialize → stage env overlay → adapter spawn → `initialize` (persist capability matrix on session row) → `session/new` with `_meta["kortix.dev"]` bootstrap ref.
- [ ] **Persistence**: sequenced raw ACP envelope log table; append from a relay tap; replay endpoint serving the identical format as live; kortix-session ↔ ACP-sessionId binding with re-bind on resume (deletes the pin/heal machinery conceptually — legacy opencode sessions stay on the legacy read path, no backfill).
- [ ] **Permission policy layer**: per-agent/persona auto-answer rules; else forward `session/request_permission` to the client; audit log.
- [ ] **Models catalog**: billing-aware listing; router base-URL injection; per-session ephemeral router tokens (mint/rotate APIs).
- [ ] **Token model**: sandbox-scoped KORTIX_TOKEN (daemon auth) vs session-scoped router tokens — scope review.
- [ ] ke2e: new flows — session create per runtime, prompt round trip, permission round trip, env rotation mid-session, replay equivalence (live log == replayed log).

Exit gate: web-less e2e (script/CLI) of the full pipeline on dev for all 3 runtimes; envelope replay byte-equivalent to live capture.

## Phase 5 — SDK + frontend (L) — suna `apps/web`, `apps/cli`, new SDK pkg

- [ ] **Kortix TS SDK**: wraps `@agentclientprotocol/sdk` (ClientSideConnection + types); custom ACP-over-HTTP/WS transport → central API relay; auth/bootstrap; catalogs client; session helpers (create/list/resume/replay). NO second ACP protocol implementation.
- [ ] **Web — envelope renderer**: one renderer for live + replay (`session/update` variants: message/thought chunks, tool_call(+update), plan, available_commands_update, current_mode_update). Map today's OpenCode parts-UI to ACP updates.
- [ ] **Web — surfaces**: agent picker + runtime picker (explicit, from capability matrix); "/" command menu joined on our catalog; permission prompt UI; mode/config-option rendering via interpretation tables (never raw); PTY tab → daemon terminal WS; file panel → daemon `/fs`; attachments → upload via host fs + `resource_link` content blocks.
- [ ] **CLI**: `kortix chat`/sessions on the SDK.
- [ ] **Transitional bridge (D4)**: only if frontend port is slow — re-enable `/opencode/*` compat in the fork so the existing frontend drives new sessions unchanged. If the renderer lands fast, skip bridge hardening entirely.

Exit gate: dev web UI runs a full session on each runtime; replay of a historical session renders identically to its live run.

## Phase 6 — Catalogs: agents / skills / commands (M–L) — suna + fork materializer hooks

- [ ] **Data model**: ONE primitive (`kind: agent|skill|command`), versioned, account/project-scoped, with metadata (description, icon, source); CRUD API + UI.
- [ ] **Materializers** (run in the pipeline's materialize step; outputs are fingerprint inputs):
  - opencode: agents → opencode config agents; commands → `.opencode/command/`; skills → `.opencode/skill/` + `skills.paths`.
  - claude: persona → CLAUDE.md/append-system-prompt + settings; commands → `.claude/commands/`; skills → `.claude/skills/`.
  - codex: persona → `AGENTS.md`/`model_instructions_file`; commands → `~/.codex/prompts`; skills: per support.
- [ ] **Round-trip**: opencode advertises our agents back as ACP modes → map mode ids ↔ agent ids; mid-session persona switch = `set_mode` (opencode) / supervised restart+resume (others); surface the cost in UI from capability matrix.
- [ ] **Interpretation tables**: modes + config options per runtime (versioned with adapter pins).
- [ ] Capability gaps recorded, not papered over (custom agents = opencode-only top-level; system-prompt replace = codex-only; etc.).
- [ ] Registry/marketplace (shadcn-modeled, ties to core-decoupling direction): DESIGN DOC ONLY this phase.

Exit gate: create agent+command+skill in UI → visible/invocable in sessions on all runtimes (within capability matrix); persona switch works both ways.

## Phase 7 — Productionization & rollout (M)

- [ ] Snapshot/bake: adapters + runtime binaries pinned in default snapshot; source-based fingerprints (no binary hashing — known art); stateful-snapshot park/claim verified with per-session adapter spawn.
- [ ] Perf budget: boot timeline (daemon start → adapter spawn → initialize → session/new) measured against current warm-boot baseline; no regression on claim path.
- [ ] Security review: token scopes, env store isolation, secrets-on-wire enforcement, relay authz matrix (user/PAT/SA principals — reuse preview-auth learnings), WAF rules for SSE/WS + big bodies.
- [ ] ke2e in promote gate; prod smoke flows.
- [ ] Rollout: experimental flag per project (dev) → dev default-on → promote to prod via main-only pipeline; legacy OpenCode path kept until cutover quota hit; then EOL: delete `apps/kortix-sandbox-agent-server`, opencode HTTP proxy paths, pin/heal session-mapping code, PTY ws-proxy special-casing.
- [ ] Docs: sandboxagent.dev fork docs decision (D5) + internal runbooks.

Exit gate: prod sessions on ACP path by default; legacy daemon deleted from snapshots; old code paths removed from apps/api.

---

## Parallelization map

```
P0 ──► P1 (spike, decides D1) ──► P2 (fork core) ──► P3 (host absorption) ─┐
                                        │                                   ├─► P7 (prod)
                                        ├─► P4 (central API; can start     │
                                        │    relay/persistence against     │
                                        │    spike daemon early)           │
                                        └─► P5 SDK (transport早 after D1); ┘
                                             P5 frontend + P6 catalogs after P4 pipeline lands
```
- P4 relay + persistence can develop against the Phase-1 spike daemon (old API) and swap transport later.
- P5 SDK transport work starts the moment D1 is decided; renderer needs P4's relay.
- P6 materializers can be built/tested against local runtimes before P4 finishes.

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rust capacity (TS shop) | core daemon velocity | scope Rust to fork core (2b–2g); everything else TS; agent-assisted dev; keep upstream architecture (don't redesign, execute) |
| Adapter quality variance (esp. `codex-acp`; amp/cursor unknown) | runtime feature gaps | capability matrix is load-bearing: gate features per runtime; launch tier = opencode+claude first, codex behind matrix flags (D6) |
| ACP unstable methods drift (`session/resume`/`list`/`fork`/`set_model`) | resume/supervision semantics | pin adapter versions in manifest; conformance tests per pin bump; fallback = recreate-session with history replay into prompt |
| opencode-via-ACP < opencode-native-API parity (our frontend uses native server heavily today) | UX regressions on our flagship runtime | daemon fs/edit interception covers diffs/status universally; gap-audit early in P5; D4 bridge as escape hatch |
| SSE/WS through Cloudflare+ALB+WAF | streaming breakage (prior 403 scar tissue) | spike tests this explicitly (P1); D1 decided on evidence |
| Per-session adapter processes × shared sandboxes | memory/process pressure | our model ≈ one active session per sandbox; enforce session cap per daemon; measure in P1 |
| Envelope-log growth | storage cost | sequenced append-only with retention policy; raw `raw` payloads optional |
| Fork = we own all bugs (75 upstream issues) | maintenance tail | P2 teardown deletes the surfaces most issues live in (universal schema, old v1); triage upstream issues once post-P2 |

## Decisions

| # | Decision | When | Default |
|---|---|---|---|
| D1 | Transport: SSE profile vs WebSocket | end of P1 (evidence-based) | SSE (upstream spec) unless edge pain |
| D2 | Naming: repo/binary vs `kortix-sandbox-agent-server` confusion | before P3 | rename legacy out of the way; fork keeps `sandbox-agent` binary, repo stays `kortix-ai/sandbox-agent` |
| D3 | How much upstream `/v1` REST survives | during P2 teardown | keep fs/processes/PTY/desktop + control plane; 410 the session/event REST |
| D4 | OpenCode-compat bridge: harden vs skip | start of P5 | skip if renderer lands fast; bridge only as schedule insurance |
| D5 | Public docs/site for the fork | P7 | internal-only until stable |
| D6 | Launch runtime tier | end of P2 | opencode + claude GA; codex beta; amp/cursor/gemini later |
| D7 | Desktop runtime | P0 | KEEP (Computers experimental section) |
| D8 | Rebase fork base onto upstream v0.5.0-rc.3 (the 03-30 branch — upstream's true final state) vs stay on main@0.4.2 | before P2 starts | merge the rc.3 branch in (small diff, includes SSE history-restore work we want) |

## Deletion list (what dies in suna at cutover)

- `apps/kortix-sandbox-agent-server` (entire app — absorbed into fork)
- OpenCode HTTP proxy session paths in apps/api (opencode:4096 special-casing), PTY `ws-proxy.ts` opencode targeting
- `use-canonical-opencode-session.ts` pin/heal machinery (legacy sessions read-only path until EOL)
- Frontend OpenCode API client/hooks (replaced by Kortix SDK renderer)
- In fork: `foundry/`, telemetry, universal-agent-schema + extracted-agent-schemas crates, old v1 session/event model

## Standing constraints (from project rules)

- Prod ships only via main → Promote workflow; experimental-flag gating per project for all new surfaces.
- No plaintext secrets in committed env files (dotenvx); env store is tmpfs-only.
- Source-based snapshot fingerprinting (never hash compiled binaries).
- Spec/docs live next to code in this repo (`research/kortix/`), not in ad-hoc root folders in suna.
