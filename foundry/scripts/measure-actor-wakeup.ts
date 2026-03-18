#!/usr/bin/env npx tsx
/**
 * Actor Wake-Up Timing Measurement Script
 *
 * 1. Finds a sleeping actor via the Rivet API
 * 2. Records LOCAL wall-clock time, then sends /health to the gateway to wake it
 * 3. Records LOCAL wall-clock time when response arrives
 * 4. Fetches the actor state from the Rivet API to get connectable_ts
 * 5. Fetches Railway logs for the actor ID to find startup timestamps
 * 6. Writes a report with all timing data
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";

const RIVET_API = "https://api.rivet.dev";
const NAMESPACE = "sandbox-agent-t2ta-prod-1ved";
const TOKEN = "pk_qufWQ7qDoQge0B4iBjSbX1E2ygIfuUKZcFhBJ65jBFLzjHPjuiLIgwbtOv6BJwZP";
const REPORT_PATH = "/Users/nathan/sandbox-agent/.agents/notes/wakeup-timing-report.md";

// Known actor configs to try waking
const ACTOR_CONFIGS = [
  { name: "auditLog", key: "org/test-wake-1/audit-log", label: "auditLog (test-wake-1)" },
  { name: "auditLog", key: "org/test-wake-2/audit-log", label: "auditLog (test-wake-2)" },
  { name: "auditLog", key: "org/test-wake-3/audit-log", label: "auditLog (test-wake-3)" },
  { name: "task", key: "org/rivet-dev/task/71d7fa2abec273e5/8f5265b4-297e-47ab-b8af-d54c0fe7e98c", label: "task (rivet-dev/71d7...)" },
  { name: "task", key: "org/rivet-dev/task/d49a32ea4570b3fa/ccd735aa-06bf-437b-823e-24f8c230743b", label: "task (rivet-dev/d49a...)" },
  { name: "organization", key: "org/app", label: "org/app (app shell)" },
  { name: "organization", key: "org/rivet-dev", label: "org/rivet-dev" },
];

interface ActorState {
  actor: {
    actor_id: string;
    name: string;
    key: string;
    create_ts: number;
    start_ts: number | null;
    pending_allocation_ts: number | null;
    connectable_ts: number | null;
    sleep_ts: number | null;
    reschedule_ts: number | null;
    destroy_ts: number | null;
  };
  created: boolean;
}

async function getOrCreateActor(name: string, key: string): Promise<ActorState> {
  const res = await fetch(`${RIVET_API}/actors?namespace=${NAMESPACE}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      key,
      runner_name_selector: "default",
      input: "Y2FwcA==",
      crash_policy: "sleep",
    }),
  });
  if (!res.ok) {
    throw new Error(`getOrCreate failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ActorState>;
}

async function pingHealth(actorId: string): Promise<{
  status: number;
  body: string;
  durationMs: number;
  localRequestStartMs: number;
  localResponseEndMs: number;
}> {
  const localRequestStartMs = Date.now();
  const start = performance.now();
  const res = await fetch(`${RIVET_API}/gateway/${actorId}@${TOKEN}/health`, { method: "GET" });
  const body = await res.text();
  const durationMs = performance.now() - start;
  const localResponseEndMs = Date.now();
  return { status: res.status, body, durationMs, localRequestStartMs, localResponseEndMs };
}

function getRailwayLogs(lines: number = 500): string {
  try {
    return execSync(`cd /Users/nathan/sandbox-agent/foundry && railway logs --deployment --lines ${lines}`, { encoding: "utf-8", timeout: 30_000 });
  } catch (e: any) {
    return e.stdout || e.message || "Failed to fetch Railway logs";
  }
}

function extractActorLogs(allLogs: string, actorId: string): string[] {
  return allLogs.split("\n").filter((line) => line.includes(actorId));
}

function formatTs(ts: number | null): string {
  if (ts === null) return "null";
  return `${new Date(ts).toISOString()} (${ts})`;
}

async function measureWakeup() {
  const report: string[] = [];
  report.push("# Actor Wake-Up Timing Report");
  report.push(`**Generated:** ${new Date().toISOString()}`);
  report.push("");

  // Step 1: Find a sleeping actor
  console.log("Step 1: Finding a sleeping actor...");
  let sleepingActor: ActorState | null = null;
  let actorLabel = "";

  for (const config of ACTOR_CONFIGS) {
    console.log(`  Checking ${config.label}...`);
    try {
      const state = await getOrCreateActor(config.name, config.key);
      console.log(`    actor_id=${state.actor.actor_id} sleep_ts=${state.actor.sleep_ts} connectable_ts=${state.actor.connectable_ts}`);
      if (state.actor.sleep_ts !== null && state.actor.connectable_ts === null) {
        sleepingActor = state;
        actorLabel = config.label;
        console.log(`  Found sleeping actor: ${config.label}`);
        break;
      }
    } catch (e) {
      console.log(`  Error: ${e}`);
    }
  }

  if (!sleepingActor) {
    console.log("No sleeping actors found. Waiting 45s for first actor to go back to sleep...");
    const config = ACTOR_CONFIGS[0]!;
    const state = await getOrCreateActor(config.name, config.key);
    if (state.actor.connectable_ts !== null) {
      console.log(`Actor ${config.label} is awake. Waiting 45s...`);
      await new Promise((r) => setTimeout(r, 45_000));
      const recheck = await getOrCreateActor(config.name, config.key);
      sleepingActor = recheck;
      actorLabel = config.label;
      if (recheck.actor.sleep_ts !== null && recheck.actor.connectable_ts === null) {
        console.log("Actor went back to sleep.");
      } else {
        console.log(`Actor still awake. Proceeding anyway.`);
      }
    } else {
      sleepingActor = state;
      actorLabel = config.label;
    }
  }

  const actorId = sleepingActor.actor.actor_id;
  const wasSleeping = sleepingActor.actor.sleep_ts !== null && sleepingActor.actor.connectable_ts === null;

  report.push(`## Target Actor`);
  report.push(`- **Label:** ${actorLabel}`);
  report.push(`- **Actor ID:** ${actorId}`);
  report.push(`- **Was sleeping:** ${wasSleeping}`);
  report.push(`- **State before wake:**`);
  report.push(`  - create_ts: ${formatTs(sleepingActor.actor.create_ts)}`);
  report.push(`  - start_ts: ${formatTs(sleepingActor.actor.start_ts)}`);
  report.push(`  - connectable_ts: ${formatTs(sleepingActor.actor.connectable_ts)}`);
  report.push(`  - sleep_ts: ${formatTs(sleepingActor.actor.sleep_ts)}`);
  report.push(`  - pending_allocation_ts: ${formatTs(sleepingActor.actor.pending_allocation_ts)}`);
  report.push("");

  // Step 2: Ping /health to wake the actor
  console.log("\nStep 2: Pinging /health to wake actor...");

  const healthResult = await pingHealth(actorId);

  console.log(`  LOCAL request start:  ${new Date(healthResult.localRequestStartMs).toISOString()} (${healthResult.localRequestStartMs})`);
  console.log(`  LOCAL response end:   ${new Date(healthResult.localResponseEndMs).toISOString()} (${healthResult.localResponseEndMs})`);
  console.log(`  Duration: ${healthResult.durationMs.toFixed(0)}ms`);
  console.log(`  Response status: ${healthResult.status}`);
  console.log(`  Response body: ${healthResult.body.substring(0, 300)}`);

  report.push(`## Health Endpoint Timing`);
  report.push(`- **Endpoint:** GET /gateway/${actorId}@.../health`);
  report.push(`- **LOCAL request start:** ${formatTs(healthResult.localRequestStartMs)}`);
  report.push(`- **LOCAL response end:** ${formatTs(healthResult.localResponseEndMs)}`);
  report.push(`- **Total round-trip:** ${healthResult.durationMs.toFixed(0)}ms`);
  report.push(`- **HTTP status:** ${healthResult.status}`);
  report.push(`- **Response:** \`${healthResult.body.substring(0, 300)}\``);
  report.push("");

  // Step 3: Fetch actor state after wake to get new connectable_ts
  console.log("\nStep 3: Fetching actor state after wake...");
  await new Promise((r) => setTimeout(r, 500));

  const afterState = await getOrCreateActor(sleepingActor.actor.name, sleepingActor.actor.key);
  console.log(`  connectable_ts: ${afterState.actor.connectable_ts}`);
  console.log(`  sleep_ts: ${afterState.actor.sleep_ts}`);
  console.log(`  start_ts: ${afterState.actor.start_ts}`);

  report.push(`## Actor State After Wake`);
  report.push(`- start_ts: ${formatTs(afterState.actor.start_ts)}`);
  report.push(`- connectable_ts: ${formatTs(afterState.actor.connectable_ts)}`);
  report.push(`- sleep_ts: ${formatTs(afterState.actor.sleep_ts)}`);
  report.push(`- pending_allocation_ts: ${formatTs(afterState.actor.pending_allocation_ts)}`);
  report.push("");

  // Step 4: Compute timing deltas
  report.push(`## Timing Analysis`);

  const localStart = healthResult.localRequestStartMs;
  const localEnd = healthResult.localResponseEndMs;

  if (wasSleeping && afterState.actor.connectable_ts) {
    const sleepTs = sleepingActor.actor.sleep_ts!;
    const connectableTs = afterState.actor.connectable_ts;

    const requestToConnectable = connectableTs - localStart;
    const sleepToConnectable = connectableTs - sleepTs;
    const connectableToResponse = localEnd - connectableTs;

    report.push(`### Key Deltas`);
    report.push(`| Metric | Value |`);
    report.push(`|--------|-------|`);
    report.push(`| LOCAL request start → LOCAL response end (total round-trip) | ${healthResult.durationMs.toFixed(0)}ms |`);
    report.push(`| LOCAL request start → connectable_ts (network hop to engine + engine wake) | ${requestToConnectable}ms |`);
    report.push(`| connectable_ts → LOCAL response end (KV reads + /health + network hop back) | ${connectableToResponse}ms |`);
    report.push(`| sleep_ts → connectable_ts (time actor was asleep before our request) | ${sleepToConnectable}ms |`);
    report.push("");

    report.push(`### Timeline`);
    report.push("```");
    report.push(`${formatTs(sleepTs)}  - Actor went to sleep (ENGINE timestamp)`);
    report.push(`${formatTs(localStart)}  - LOCAL: HTTP request sent to gateway`);
    report.push(`${formatTs(connectableTs)}  - ENGINE: connectable_ts set (actor allocated to runner)`);
    report.push(`${formatTs(localEnd)}  - LOCAL: HTTP response received`);
    report.push("```");
    report.push("");
    report.push(`**Note:** LOCAL vs ENGINE timestamps include clock skew + network latency.`);
    report.push("");
  } else {
    report.push(`Actor was not sleeping or connectable_ts not set after wake.`);
    report.push(`- wasSleeping: ${wasSleeping}`);
    report.push(`- afterState.connectable_ts: ${afterState.actor.connectable_ts}`);
    report.push("");
  }

  // Step 5: Fetch Railway logs
  console.log("\nStep 4: Fetching Railway logs...");
  const railwayLogs = getRailwayLogs(500);
  const actorLogs = extractActorLogs(railwayLogs, actorId);
  console.log(`  Found ${actorLogs.length} log lines mentioning actor ${actorId}`);

  const startupKeywords = ["CommandStartActor", "ActorStateRunning", "starting actor", "kv", "sleep", "wake", "connectable", actorId];

  const relevantLogs = railwayLogs
    .split("\n")
    .filter((line) => startupKeywords.some((kw) => line.toLowerCase().includes(kw.toLowerCase())))
    .slice(-50);

  report.push(`## Railway Logs`);
  report.push(`### Lines mentioning actor ID (${actorId})`);
  if (actorLogs.length > 0) {
    report.push("```");
    for (const line of actorLogs.slice(-30)) {
      report.push(line);
    }
    report.push("```");
  } else {
    report.push("*No log lines found mentioning the actor ID directly.*");
  }
  report.push("");

  report.push(`### Startup-related log lines (last 50)`);
  if (relevantLogs.length > 0) {
    report.push("```");
    for (const line of relevantLogs) {
      report.push(line);
    }
    report.push("```");
  } else {
    report.push("*No startup-related log lines found.*");
  }
  report.push("");

  // Step 6: Poll actor state
  console.log("\nStep 5: Polling actor state over next 5 seconds...");
  report.push(`## Actor State Polling (post-wake)`);
  report.push(`| Time | connectable_ts | sleep_ts |`);
  report.push(`|------|---------------|----------|`);

  for (let i = 0; i < 5; i++) {
    const pollState = await getOrCreateActor(sleepingActor.actor.name, sleepingActor.actor.key);
    const now = new Date().toISOString();
    report.push(`| ${now} | ${formatTs(pollState.actor.connectable_ts)} | ${formatTs(pollState.actor.sleep_ts)} |`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  report.push("");

  // Write report
  const reportContent = report.join("\n");
  writeFileSync(REPORT_PATH, reportContent);
  console.log(`\nReport written to: ${REPORT_PATH}`);
  console.log("\n--- Report Preview ---");
  console.log(reportContent);
}

measureWakeup().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
