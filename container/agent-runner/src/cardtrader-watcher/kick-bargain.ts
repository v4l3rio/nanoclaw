/**
 * Bargain scan "kick-off" — runs inside the schedule_task pre-script window
 * (30s budget). Three jobs:
 *
 *  1. Pick up the previous completed scan's unnotified candidates, if any,
 *     and emit them as `scriptOutput.alerts` with wakeAgent=true so the
 *     agent gets woken to format and send the notification.
 *  2. Spawn a new bargain-hunter scan in the background (detached). The new
 *     scan persists progress to the DB; we don't wait for it.
 *  3. Exit fast so the task-script timeout never trips.
 *
 * Set list comes from /workspace/agent/pokemon-sets.md (a cache the agent
 * built on first setup). Format: each line `- <Name> → <id>` is parsed for
 * the numeric id. If no cache, the script logs and skips the new scan (the
 * agent must do the initial setup once via chat).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createBargainScan,
  getBargainScan,
  latestBargainScan,
  listBargainCandidates,
  markCandidatesNotified,
} from './db.js';

const SETS_CACHE_PATH = process.env.POKEMON_SETS_CACHE_PATH || '/workspace/agent/pokemon-sets.md';
const LOG_DIR = '/workspace/agent/logs';
const BARGAIN_SCRIPT = '/app/src/cardtrader-watcher/bargain-hunter.ts';
const THRESHOLD_PCT = Number(process.env.POKEMON_BARGAIN_THRESHOLD_PCT ?? '20');

function readSetsCache(): number[] {
  if (!fs.existsSync(SETS_CACHE_PATH)) return [];
  const content = fs.readFileSync(SETS_CACHE_PATH, 'utf8');
  const ids: number[] = [];
  for (const line of content.split('\n')) {
    // Match patterns like: "- Base Set → 12345" or "- Base Set => 12345"
    const m = line.match(/(?:→|=>|->|:|—|–)\s*(\d+)\b/);
    if (m) ids.push(Number(m[1]));
  }
  return Array.from(new Set(ids));
}

function previousUnnotifiedSummary(): {
  scan_id: string | null;
  status: string | null;
  candidates: Array<{
    blueprint_id: number;
    name: string | null;
    expansion_name: string | null;
    variant_props: unknown;
    prev_min_eur: number;
    curr_min_eur: number;
    drop_pct: number;
    sample_seller: string | null;
  }>;
} {
  const latest = latestBargainScan();
  if (!latest || latest.status !== 'completed') {
    return { scan_id: latest?.scan_id ?? null, status: latest?.status ?? null, candidates: [] };
  }
  const cands = listBargainCandidates(latest.scan_id).filter((c) => !c.notified);
  if (cands.length === 0) {
    return { scan_id: latest.scan_id, status: latest.status, candidates: [] };
  }
  // Mark notified up-front: even if the wake-up is lost, we don't double-fire.
  markCandidatesNotified(latest.scan_id);
  const compact = cands.slice(0, 50).map((c) => ({
    blueprint_id: c.blueprint_id,
    name: c.name,
    expansion_name: c.expansion_name,
    variant_props: (() => {
      try {
        return JSON.parse(c.variant_props);
      } catch {
        return c.variant_props;
      }
    })(),
    prev_min_eur: c.prev_min_eur,
    curr_min_eur: c.curr_min_eur,
    drop_pct: c.drop_pct,
    sample_seller: c.sample_seller,
  }));
  return { scan_id: latest.scan_id, status: latest.status, candidates: compact };
}

function startNewScan(expansionIds: number[]): { scan_id: string | null; reason?: string } {
  if (expansionIds.length === 0) {
    return { scan_id: null, reason: 'sets-cache-empty' };
  }
  // Don't pile up scans: if one is currently running, skip the kick.
  const latest = latestBargainScan();
  if (latest && latest.status === 'running') {
    // Sanity: if running for >2h treat as stale and start a new one anyway.
    const ageMs = Date.now() - new Date(latest.started_at).getTime();
    if (ageMs < 2 * 60 * 60 * 1000) {
      return { scan_id: null, reason: `scan-already-running:${latest.scan_id}` };
    }
  }

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const scanId = randomUUID();
  const logPath = path.join(LOG_DIR, `bargain-${scanId}.log`);
  createBargainScan(scanId, expansionIds, THRESHOLD_PCT, logPath);

  const out = fs.openSync(logPath, 'a');
  const child = spawn(
    'bun',
    [
      BARGAIN_SCRIPT,
      '--scan-id', scanId,
      '--expansion-ids', expansionIds.join(','),
      '--threshold-pct', String(THRESHOLD_PCT),
      '--log-path', logPath,
    ],
    { detached: true, stdio: ['ignore', out, out] },
  );
  child.unref();
  return { scan_id: scanId };
}

function main() {
  const previous = previousUnnotifiedSummary();
  const expansionIds = readSetsCache();
  const newScan = startNewScan(expansionIds);

  const alerts = previous.candidates;
  const wakeAgent = alerts.length > 0;

  // Verify the scan we just created actually started (file exists & in DB).
  let newScanState: unknown = null;
  if (newScan.scan_id) {
    newScanState = getBargainScan(newScan.scan_id);
  }

  process.stdout.write(
    JSON.stringify({
      wakeAgent,
      data: {
        ts: new Date().toISOString(),
        previous_scan: {
          scan_id: previous.scan_id,
          status: previous.status,
          alerts_count: alerts.length,
        },
        new_scan: {
          scan_id: newScan.scan_id,
          skipped_reason: newScan.reason ?? null,
          expansion_count: expansionIds.length,
          state: newScanState,
        },
        alerts,
      },
    }),
  );
}

main();
