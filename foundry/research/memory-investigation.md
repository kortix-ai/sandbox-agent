# Foundry Backend Memory Investigation

Date: 2026-03-17

## Problem

Production Railway deployment shows memory spikes from near-zero to 40+ GB when users interact with the app. Local reproduction shows spikes from ~300 MB to ~2.1 GB when opening a task workspace.

## Architecture

Each actor in the system has **two SQLite instances**:

1. **WASM SQLite** (16.6 MB per actor) - Runs Drizzle ORM queries for actor-specific tables (task data, session transcripts, etc.). Each actor gets its own `SqliteVfs` which instantiates a full `WebAssembly.Instance` with 16.6 MB linear memory.

2. **Native bun:sqlite** (~4-8 MB per actor) - Backs the KV store that the WASM SQLite's VFS reads/writes to. This is the persistence layer. Not visible in JS heap snapshots (native C memory).

## Findings

### Memory breakdown (steady state, 14 active WASM instances)

| Category | Size | % of RSS | Description |
|----------|------|----------|-------------|
| WASM SQLite heaps | 232 MB | 46% | 14 x 16.6 MB ArrayBuffers (WASM linear memory) |
| Bun native (bun:sqlite + runtime) | 225 MB | 44% | KV backing store page caches, mmap'd WAL files, Bun runtime |
| JS application objects | 27 MB | 5% | Closures, actor state, plain objects |
| Module graph | 20 MB | 4% | Compiled code, FunctionCodeBlocks, ModuleRecords |
| ArrayBuffer intermediates | 4 MB | 1% | Non-WASM buffers |
| KV data in transit | ~0 MB | 0% | 4KB chunks copied and freed immediately |

### Spike behavior

When opening a task workspace, many actors wake simultaneously:

| State | WASM Instances | SqliteVfs | WASM Heap | Actors (task) | RSS |
|-------|---------------|-----------|-----------|---------------|-----|
| Baseline | 7-9 | 6-8 | 116-149 MB | 14 | 289-309 MB |
| Spike | 32 | 32 | 531 MB | 25 | 2,118 MB |
| Post-sleep | 14 | 13 | 232 MB | 25 (23 sleeping) | 509 MB |

### Per-actor memory cost

Each actor that wakes up and accesses its database costs:
- 16.6 MB for WASM SQLite linear memory
- ~4-8 MB for native bun:sqlite KV backing store
- **Total: ~20-25 MB per actor**

### No per-actor WASM leak

Controlled testing (3 wake/sleep cycles on a single actor) confirmed WASM is properly freed on sleep:
- Wake: +1 SqliteVfs, +17 MB
- Sleep: -1 SqliteVfs, -17 MB
- No accumulation across cycles

### Production impact

With 200+ PRs in production, if something wakes all task actors simultaneously:
- 200 actors x 25 MB = 5 GB minimum
- Plus JS garbage from git operations, sandbox bootstraps, etc.
- Explains the 40 GB spike seen on Railway (multiple replicas, plus GC pressure)

### The double-SQLite problem

The current file-system driver architecture means every actor runs SQLite-in-WASM on top of SQLite-native:

```
Actor Drizzle queries
    -> WASM SQLite (16.6 MB heap)
        -> VFS layer (copies 4KB chunks)
            -> KV store API
                -> bun:sqlite (native, ~4-8 MB page cache)
                    -> disk (.db files)
```

The engine driver eliminates the WASM layer entirely, using the Rust engine's native SQLite directly.

## Root causes of mass actor wake-up

1. `maybeScheduleWorkspaceRefreshes()` is called twice per `getTaskDetail()` (once directly, once via `buildTaskSummary()`)
2. ~~`getWorkspace()` fetches ALL task details in parallel, waking all task actors~~ **Dead code — removed 2026-03-17.** The frontend uses the subscription system exclusively; `getWorkspaceCompat` and `RemoteWorkspaceStore` had zero callers.
3. Frontend retry interval is 1 second with no backoff
4. No deduplication of concurrent `collectWorkspaceGitState()` calls

## Next steps

- [ ] Test with engine driver enabled to measure WASM elimination impact
- [ ] Investigate what triggers mass actor wake-up in production (the `getWorkspace` fan-out was dead code; the actual trigger is still unknown)
- [ ] Consider sharing a single WASM module across actors (mutex around non-reentrant init)
- [ ] Enable periodic memory logging in production to capture state before OOM kills
