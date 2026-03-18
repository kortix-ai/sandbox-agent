# SQLite VFS Pool Spec

Date: 2026-03-17
Package: `@rivetkit/sqlite-vfs`
Scope: WASM SQLite only (not Cloudflare D1 driver)

## Problem

Each actor gets its own WASM SQLite instance via `SqliteVfs`, allocating 16.6 MB
of linear memory per instance. With 200+ actors waking simultaneously, this
causes multi-GB memory spikes (40 GB observed in production).

## Design

### Pool model

A `SqliteVfsPool` manages N WASM SQLite instances. Actors are bin-packed onto
instances via sticky assignment. The pool scales instances up to a configured
max as actors arrive, and scales down (after a grace period) when instances have
zero assigned actors.

### Configuration

```typescript
interface SqliteVfsPoolConfig {
  /** Max actors sharing one WASM instance. Default: 50. */
  actorsPerInstance: number;
  /** Max WASM instances the pool will create. Default: Infinity. */
  maxInstances?: number;
  /** Grace period before destroying an empty instance. Default: 30_000ms. */
  idleDestroyMs?: number;
}
```

**Sizing guide**: each WASM instance handles ~13 SQLite ops/sec at 15ms KV RTT
(66 KV ops/sec / ~5 KV ops per SQLite operation). For a target of X ops/sec,
set `actorsPerInstance = totalActors / ceil(X / 13)`.

### Actor-to-instance assignment

Sticky assignment: once an actor is assigned to an instance, it stays there
until it releases (actor sleep/destroy). Assignment uses bin-packing: pick the
instance with the most actors that still has capacity. If all instances are
full, create a new one (up to `maxInstances`).

```
acquire(actorId) -> PooledSqliteHandle
  1. If actorId already assigned, return existing handle
  2. Find instance with most actors that has capacity (< actorsPerInstance)
  3. If none found and instanceCount < maxInstances, create new instance
  4. If none found and at max, wait (queue)
  5. Assign actorId to instance, return handle

release(actorId)
  1. Remove actorId from instance's assignment set
  2. If instance has zero actors, start idle timer
  3. On idle timer expiry, destroy instance (reclaim 16.6 MB)
  4. Cancel idle timer if a new actor is assigned before expiry
```

### Locking mechanism

The existing `#sqliteMutex` on `SqliteVfs` already serializes SQLite operations
within one instance. This is the right level: each individual xRead/xWrite call
acquires the mutex, does its async KV operation, and releases. No change needed
to the mutex itself.

Multiple databases on the same instance share the mutex. This means if actor A
is doing an xRead (15ms), actor B on the same instance waits. This is the
intentional serialization — asyncify cannot handle concurrent suspensions on the
same WASM module.

The pool does NOT add a higher-level lock. The per-instance `#sqliteMutex`
handles all serialization. The pool only manages assignment and lifecycle.

### Multiple databases per instance

Currently `SqliteSystem.registerFile()` enforces one main database file per VFS.
This constraint must be lifted to allow multiple actors' databases to coexist.

**Change**: `SqliteSystem` tracks multiple registered files in a `Map<string, KvVfsOptions>`
instead of a single `#mainFileName`. The VFS callbacks (`xRead`, `xWrite`, etc.)
already receive the file handle and look up the correct options per file.

Each actor opens its own database file (named by actorId) on the shared VFS.
Multiple databases can be open simultaneously on the same WASM instance. The
`#sqliteMutex` ensures only one SQLite call executes at a time.

### PooledSqliteHandle

The handle returned to actors wraps a reference to the pool and its assigned
instance. It exposes the same `open()` interface as `SqliteVfs`.

```typescript
class PooledSqliteHandle {
  readonly #pool: SqliteVfsPool;
  readonly #instanceId: number;
  readonly #actorId: string;

  /** Open a database on this handle's assigned WASM instance. */
  async open(fileName: string, options: KvVfsOptions): Promise<Database> {
    const vfs = this.#pool.getInstance(this.#instanceId);
    return vfs.open(fileName, options);
  }

  /** Release this handle back to the pool. */
  async destroy(): Promise<void> {
    this.#pool.release(this.#actorId);
  }
}
```

### Integration with drivers

The `ActorDriver.createSqliteVfs()` method currently returns `new SqliteVfs()`.
With pooling:

```typescript
// Before
async createSqliteVfs(): Promise<SqliteVfs> {
  return new SqliteVfs();
}

// After
async createSqliteVfs(actorId: string): Promise<PooledSqliteHandle> {
  return this.#vfsPool.acquire(actorId);
}
```

The `PooledSqliteHandle` must satisfy the same interface that actors expect from
`SqliteVfs` (specifically the `open()` and `destroy()` methods). Either:
- `PooledSqliteHandle` implements the `SqliteVfs` interface (duck typing)
- Or extract an interface type that both implement

The actor instance code in `mod.ts` calls `this.#sqliteVfs = await driver.createSqliteVfs()`.
It then passes `this.#sqliteVfs` to the DB provider which calls `.open()`. On
cleanup it calls `.destroy()`. The pooled handle supports both.

### Scale-up and scale-down

**Scale-up**: new instance created lazily on `acquire()` when all existing
instances are at capacity. WASM module is loaded in `#ensureInitialized()` on
first `open()` call (existing lazy behavior). Cost: ~16.6 MB + WASM compile time.

**Scale-down**: when last actor releases from an instance, start a timer
(`idleDestroyMs`). If no new actor is assigned before the timer fires, call
`sqliteVfs.destroy()` to free the WASM module. This reclaims 16.6 MB.

If an actor is assigned to an instance that is in the idle-destroy grace period,
cancel the timer and reuse the instance.

### Memory budget examples

| Actors | actorsPerInstance | Instances | WASM Memory |
|--------|-------------------|-----------|-------------|
| 50     | 50                | 1         | 17 MB       |
| 200    | 50                | 4         | 66 MB       |
| 500    | 50                | 10        | 166 MB      |
| 200    | 25                | 8         | 133 MB      |

Compare to current: 200 actors = 200 instances = 3,320 MB.

## Changes required

### `@rivetkit/sqlite-vfs`

1. **`SqliteSystem`**: Remove single-main-file constraint. Replace
   `#mainFileName`/`#mainFileOptions` with a `Map<string, KvVfsOptions>`.
   Update `registerFile()` to insert into the map. Update VFS callbacks to look
   up options by file handle.

2. **`SqliteVfs`**: Allow multiple `open()` calls with different filenames.
   Each returns an independent `Database` handle. All share the same WASM
   module and `#sqliteMutex`.

3. **New `SqliteVfsPool`**: Manages instance lifecycle, actor assignment, and
   scale-up/scale-down. Exported from the package.

4. **New `PooledSqliteHandle`**: Returned by `pool.acquire()`. Implements the
   subset of `SqliteVfs` that actors use (`open`, `destroy`).

### `rivetkit` (drivers)

5. **`ActorDriver` interface**: `createSqliteVfs()` signature adds `actorId`
   parameter so the pool can do sticky assignment.

6. **File-system driver**: Create `SqliteVfsPool` once, call
   `pool.acquire(actorId)` in `createSqliteVfs()`.

7. **Engine driver**: Same change as file-system driver.

8. **Actor instance (`mod.ts`)**: Pass `actorId` to `driver.createSqliteVfs(actorId)`.
   No other changes needed — the handle quacks like `SqliteVfs`.

### Not changed

- Cloudflare driver (uses D1, no WASM)
- KV storage layer (unchanged)
- Drizzle integration (unchanged, still receives a `Database` from `open()`)
- `#sqliteMutex` behavior (unchanged, already serializes correctly)

## Risks

1. **Hot instance**: If one instance has 50 chatty actors, the mutex contention
   increases latency for all of them. Mitigation: monitor mutex wait time, tune
   `actorsPerInstance` down if needed.

2. **WASM memory growth**: SQLite can grow WASM linear memory via
   `memory.grow()`. If one actor causes growth, all actors on that instance pay
   the cost. In practice, SQLite's page cache is small and growth is rare.

3. **Database close ordering**: If actor A crashes without closing its DB, the
   open file handle leaks inside the VFS. The pool must track open databases
   and force-close on `release()`.
