/**
 * Perspective scaling profiler.
 *
 * Starts an AD4M executor, then creates perspectives in batches (1, 3, 10)
 * and snapshots system resource usage after each batch.
 *
 * Usage: npx tsx profile-perspectives.ts
 */

import { execSync } from "node:child_process";
import {
  startExecutor,
  apolloClient,
  killProcess,
  sleep,
  BOOTSTRAP_SEED_PATH,
  AD4M_EXECUTOR_PATH,
} from "./utils/utils.js";
import { Ad4mClient } from "@coasys/ad4m";

const DATA_PATH = "/tmp/ad4m-profile-test";
const GQL_PORT = 14000;
const HC_ADMIN_PORT = 14001;
const HC_APP_PORT = 14002;

interface Snapshot {
  label: string;
  perspectiveCount: number;
  rssKB: number;
  vszKB: number;
  cpuPercent: string;
  childProcesses: number;
  timestamp: number;
}

// getProcessTree removed — using getFullProcessTree with recursive pgrep instead

function getAllDescendantPids(pid: number): string[] {
  const result = [pid.toString()];
  try {
    const children = execSync(`pgrep -P ${pid} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
    if (children) {
      for (const childPid of children.split("\n").filter(Boolean)) {
        result.push(...getAllDescendantPids(parseInt(childPid, 10)));
      }
    }
  } catch {}
  return result;
}

function getFullProcessTree(pid: number): { rssKB: number; vszKB: number; cpuPercent: string; childCount: number } {
  try {
    const pids = [...new Set(getAllDescendantPids(pid))];
    const uniquePids = pids.join(",");

    const raw = execSync(
      `ps -o pid=,rss=,vsz=,%cpu=,comm= -p ${uniquePids} 2>/dev/null || true`,
      { encoding: "utf-8" }
    ).trim();

    const lines = raw.split("\n").filter(Boolean);
    let totalRSS = 0;
    let totalVSZ = 0;
    let totalCPU = 0;
    let count = 0;
    const details: string[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        const rss = parseInt(parts[1], 10) || 0;
        const vsz = parseInt(parts[2], 10) || 0;
        const cpu = parseFloat(parts[3]) || 0;
        const comm = parts.slice(4).join(" ");
        totalRSS += rss;
        totalVSZ += vsz;
        totalCPU += cpu;
        count++;
        details.push(`    PID ${parts[0]}: ${(rss / 1024).toFixed(1)}MB RSS, ${cpu}% CPU — ${comm}`);
      }
    }

    if (details.length > 0) {
      console.log("  Process breakdown:");
      details.forEach(d => console.log(d));
    }

    return { rssKB: totalRSS, vszKB: totalVSZ, cpuPercent: totalCPU.toFixed(1), childCount: Math.max(0, count - 1) };
  } catch {
    return { rssKB: 0, vszKB: 0, cpuPercent: "0", childCount: 0 };
  }
}

async function takeSnapshot(label: string, pid: number, perspectiveCount: number): Promise<Snapshot> {
  // Let things settle
  await sleep(3000);

  const tree = getFullProcessTree(pid);

  const snapshot: Snapshot = {
    label,
    perspectiveCount,
    rssKB: tree.rssKB,
    vszKB: tree.vszKB,
    cpuPercent: tree.cpuPercent,
    childProcesses: tree.childCount,
    timestamp: Date.now(),
  };

  console.log(`\n=== ${label} ===`);
  console.log(`  Perspectives: ${perspectiveCount}`);
  console.log(`  Total RSS: ${(snapshot.rssKB / 1024).toFixed(1)} MB`);
  console.log(`  Total VSZ: ${(snapshot.vszKB / 1024).toFixed(1)} MB`);
  console.log(`  Total CPU: ${snapshot.cpuPercent}%`);
  console.log(`  Child processes: ${snapshot.childProcesses}`);

  return snapshot;
}

async function main() {
  console.log("=== AD4M Perspective Scaling Profiler ===\n");
  console.log(`Executor: ${AD4M_EXECUTOR_PATH}`);
  console.log(`Bootstrap: ${BOOTSTRAP_SEED_PATH}`);
  console.log(`Data path: ${DATA_PATH}`);
  console.log();

  // Start executor
  console.log("Starting executor...");
  const executorProcess = await startExecutor(
    DATA_PATH,
    BOOTSTRAP_SEED_PATH,
    GQL_PORT,
    HC_ADMIN_PORT,
    HC_APP_PORT,
    false,
    "test-profile-token"
  );

  const pid = executorProcess.pid!;
  console.log(`Executor PID: ${pid}`);

  const snapshots: Snapshot[] = [];

  try {
    // Create AD4M client
    const client = new Ad4mClient(apolloClient(GQL_PORT, "test-profile-token"));

    // Generate agent
    console.log("\nGenerating agent...");
    await client.agent.generate("profiletest123");
    await sleep(2000);

    // Baseline: 0 perspectives
    snapshots.push(await takeSnapshot("Baseline (0 perspectives)", pid, 0));

    // Batch 1: Create 1 perspective
    console.log("\n--- Creating 1 perspective ---");
    await client.perspective.add("profile-test-1");
    snapshots.push(await takeSnapshot("After 1 perspective", pid, 1));

    // Batch 2: Create 2 more (total 3)
    console.log("\n--- Creating 2 more perspectives (total 3) ---");
    for (let i = 2; i <= 3; i++) {
      await client.perspective.add(`profile-test-${i}`);
    }
    snapshots.push(await takeSnapshot("After 3 perspectives", pid, 3));

    // Batch 3: Create 7 more (total 10)
    console.log("\n--- Creating 7 more perspectives (total 10) ---");
    for (let i = 4; i <= 10; i++) {
      await client.perspective.add(`profile-test-${i}`);
    }
    snapshots.push(await takeSnapshot("After 10 perspectives", pid, 10));

    // Summary table
    console.log("\n\n=== SUMMARY ===\n");
    console.log("Perspectives | RSS (MB)  | VSZ (MB)  | CPU %  | Processes");
    console.log("-------------|-----------|-----------|--------|----------");
    for (const s of snapshots) {
      console.log(
        `${String(s.perspectiveCount).padStart(12)} | ${(s.rssKB / 1024).toFixed(1).padStart(9)} | ${(s.vszKB / 1024).toFixed(1).padStart(9)} | ${s.cpuPercent.padStart(6)} | ${String(s.childProcesses).padStart(9)}`
      );
    }

    // Delta analysis
    console.log("\n=== DELTA PER PERSPECTIVE ===\n");
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];
      const added = curr.perspectiveCount - prev.perspectiveCount;
      const rssDelta = curr.rssKB - prev.rssKB;
      const procDelta = curr.childProcesses - prev.childProcesses;
      console.log(
        `${prev.perspectiveCount} → ${curr.perspectiveCount}: +${(rssDelta / 1024).toFixed(1)} MB RSS (${(rssDelta / 1024 / added).toFixed(1)} MB/perspective), +${procDelta} processes`
      );
    }
  } finally {
    console.log("\nCleaning up...");
    await killProcess(executorProcess, "executor");
  }
}

main().catch((err) => {
  console.error("Profile failed:", err);
  process.exit(1);
});
