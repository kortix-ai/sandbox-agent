#!/usr/bin/env bash
#
# Memory monitor for Foundry backend.
# Polls /debug/memory and actor counts every N seconds, writes TSV + heap
# snapshots to a timestamped output directory.
#
# Usage:
#   ./foundry/scripts/mem-monitor.sh [interval_seconds] [backend_url]
#
# Defaults: interval=5s, backend=http://127.0.0.1:7741
# Output:   foundry/.foundry/mem-monitor/<run-timestamp>/
#
set -euo pipefail

INTERVAL="${1:-5}"
BACKEND="${2:-http://127.0.0.1:7741}"
RIVETKIT="${3:-http://127.0.0.1:6420}"

RUN_TS="$(date +%Y%m%dT%H%M%S)"
OUT_DIR="foundry/.foundry/mem-monitor/$RUN_TS"
mkdir -p "$OUT_DIR"

MEMORY_TSV="$OUT_DIR/memory.tsv"
ACTORS_TSV="$OUT_DIR/actors.tsv"
EVENTS_LOG="$OUT_DIR/events.log"
HEAP_DIR="$OUT_DIR/heaps"
mkdir -p "$HEAP_DIR"

# Column headers
printf "timestamp\telapsed_s\trss_mb\theap_used_mb\theap_total_mb\texternal_mb\tnon_heap_mb\n" > "$MEMORY_TSV"
printf "timestamp\telapsed_s\torganization\ttask\ttask_sandbox\tuser\tgithub_data\taudit_log\ttotal\n" > "$ACTORS_TSV"

echo "=== Foundry Memory Monitor ==="
echo "  Interval:  ${INTERVAL}s"
echo "  Backend:   $BACKEND"
echo "  RivetKit:  $RIVETKIT"
echo "  Output:    $OUT_DIR"
echo ""

START_EPOCH="$(date +%s)"
TICK=0
PREV_RSS=0

# Record baseline heap snapshot
echo "[$(date +%H:%M:%S)] Recording baseline heap snapshot..."
baseline_resp=$(curl -sf "${BACKEND}/debug/memory?gc=1&heap=1" 2>/dev/null || echo '{}')
baseline_path=$(echo "$baseline_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('heapSnapshotPath',''))" 2>/dev/null || true)
if [[ -n "$baseline_path" ]]; then
  docker cp "foundry-backend-1:${baseline_path}" "$HEAP_DIR/baseline.json" 2>/dev/null && \
    echo "[$(date +%H:%M:%S)] Baseline heap snapshot saved to $HEAP_DIR/baseline.json" || true
fi

# Analyze WASM instances in a heap snapshot file
analyze_heap() {
  local heap_file="$1"
  python3 << PYEOF
import json
with open("$heap_file") as f:
    snap = json.load(f)
strings = snap["strings"]
nodes = snap["nodes"]
fpn = len(snap["snapshot"]["meta"]["node_fields"])
total = len(nodes) // fpn
wasm_inst = 0; sqlite_vfs = 0; big_ab = 0; big_ab_bytes = 0
for i in range(total):
    b = i * fpn
    name = strings[nodes[b+1]]
    size = nodes[b+3]
    if name == "WebAssembly.Instance": wasm_inst += 1
    if name == "SqliteVfs": sqlite_vfs += 1
    if name == "ArrayBuffer" and size > 10*1024*1024:
        big_ab += 1; big_ab_bytes += size
print(f"wasm_instances={wasm_inst} sqlite_vfs={sqlite_vfs} big_arraybuffers={big_ab} wasm_heap_mb={big_ab_bytes/1024/1024:.1f}")
PYEOF
}

if [[ -f "$HEAP_DIR/baseline.json" ]]; then
  baseline_wasm=$(analyze_heap "$HEAP_DIR/baseline.json")
  echo "[$(date +%H:%M:%S)] Baseline WASM: $baseline_wasm"
  echo "$(date +%H:%M:%S) BASELINE wasm: $baseline_wasm" >> "$EVENTS_LOG"
fi

# Record baseline actor counts
get_actor_counts() {
  local counts=""
  local total=0
  for name in organization task taskSandbox user github-data audit-log; do
    # Try without namespace (file-system driver), then with namespace (engine driver)
    c=$(curl -sf "${RIVETKIT}/actors?name=$name" 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('actors',d) if isinstance(d,dict) else d))" 2>/dev/null)
    if [[ -z "$c" || "$c" == "0" ]]; then
      c=$(curl -sf "${RIVETKIT}/actors?name=$name&namespace=default" 2>/dev/null \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('actors',d) if isinstance(d,dict) else d))" 2>/dev/null || echo "0")
    fi
    counts="${counts}\t${c}"
    total=$((total + c))
  done
  counts="${counts}\t${total}"
  echo -e "$counts"
}

baseline_actors=$(get_actor_counts)
echo "[$(date +%H:%M:%S)] Baseline actors: $baseline_actors"
echo "$(date +%H:%M:%S) BASELINE actors:$baseline_actors" >> "$EVENTS_LOG"

# Print baseline memory
baseline_mem=$(curl -sf "${BACKEND}/debug/memory?gc=1" 2>/dev/null || echo '{}')
baseline_rss=$(echo "$baseline_mem" | python3 -c "import json,sys; print(json.load(sys.stdin).get('rssMb',0))" 2>/dev/null || echo "?")
echo "[$(date +%H:%M:%S)] Baseline RSS (after GC): ${baseline_rss} MB"
echo "$(date +%H:%M:%S) BASELINE rss=${baseline_rss}MB" >> "$EVENTS_LOG"
echo ""
echo "[$(date +%H:%M:%S)] Monitoring started. Press Ctrl+C to stop."
echo ""

# Spike detection state
PEAK_RSS=0
SPIKE_HEAP_TAKEN=0
SPIKE_THRESHOLD_MB=100  # delta from baseline to trigger heap snapshot

while true; do
  NOW="$(date +%H:%M:%S)"
  ELAPSED=$(( $(date +%s) - START_EPOCH ))
  TICK=$((TICK + 1))

  # Memory poll (no GC — we want to see real usage)
  mem_json=$(curl -sf "${BACKEND}/debug/memory" 2>/dev/null || echo '{}')
  rss=$(echo "$mem_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('rssMb',0))" 2>/dev/null || echo 0)
  heap_used=$(echo "$mem_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('heapUsedMb',0))" 2>/dev/null || echo 0)
  heap_total=$(echo "$mem_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('heapTotalMb',0))" 2>/dev/null || echo 0)
  external=$(echo "$mem_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('externalMb',0))" 2>/dev/null || echo 0)
  non_heap=$(echo "$mem_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('nonHeapMb',0))" 2>/dev/null || echo 0)

  printf "%s\t%d\t%s\t%s\t%s\t%s\t%s\n" "$NOW" "$ELAPSED" "$rss" "$heap_used" "$heap_total" "$external" "$non_heap" >> "$MEMORY_TSV"

  delta=$((rss - PREV_RSS))
  PREV_RSS=$rss

  # Track peak
  if [[ "$rss" -gt "$PEAK_RSS" ]]; then
    PEAK_RSS=$rss
  fi

  # Print live status
  printf "\r[%s] +%4ds  RSS: %4s MB (Δ%+d)  heap: %4s MB  ext: %4s MB  peak: %4s MB" \
    "$NOW" "$ELAPSED" "$rss" "$delta" "$heap_used" "$external" "$PEAK_RSS"

  # Auto-capture heap snapshot on spike
  spike_delta=$((rss - baseline_rss))
  if [[ "$spike_delta" -gt "$SPIKE_THRESHOLD_MB" && "$SPIKE_HEAP_TAKEN" -eq 0 ]]; then
    SPIKE_HEAP_TAKEN=1
    echo ""
    echo "[${NOW}] SPIKE DETECTED: RSS=${rss}MB (+${spike_delta}MB from baseline). Capturing heap snapshot..."
    spike_resp=$(curl -sf "${BACKEND}/debug/memory?heap=1" 2>/dev/null || echo '{}')
    spike_path=$(echo "$spike_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('heapSnapshotPath',''))" 2>/dev/null || true)
    if [[ -n "$spike_path" ]]; then
      docker cp "foundry-backend-1:${spike_path}" "$HEAP_DIR/spike-${NOW}.json" 2>/dev/null && \
        echo "[${NOW}] Spike heap snapshot saved to $HEAP_DIR/spike-${NOW}.json" || true
      spike_wasm=$(analyze_heap "$HEAP_DIR/spike-${NOW}.json" 2>/dev/null || echo "analysis failed")
      echo "[${NOW}] Spike WASM: $spike_wasm"
      echo "${NOW} SPIKE rss=${rss}MB delta=+${spike_delta}MB wasm: $spike_wasm" >> "$EVENTS_LOG"
    fi
  fi

  # Reset spike detection when RSS drops back near baseline
  if [[ "$spike_delta" -lt 50 && "$SPIKE_HEAP_TAKEN" -eq 1 ]]; then
    SPIKE_HEAP_TAKEN=0
    echo ""
    echo "[${NOW}] RSS returned near baseline (${rss}MB). Spike detection re-armed."
    echo "${NOW} SPIKE_RESET rss=${rss}MB" >> "$EVENTS_LOG"
  fi

  # Actor counts every 6th tick (every 30s at default interval)
  if [[ $((TICK % 6)) -eq 0 ]]; then
    actor_counts=$(get_actor_counts)
    printf "%s\t%d%s\n" "$NOW" "$ELAPSED" "$actor_counts" >> "$ACTORS_TSV"
  fi

  sleep "$INTERVAL"
done
