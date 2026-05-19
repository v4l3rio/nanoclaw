/**
 * Pokemon watcher local DB. Lives in /workspace/agent/pokemon-watcher.db.
 *
 * Shared by:
 *  - the MCP tools (mcp-tools/pokemon-watch.ts) — for watchlist CRUD
 *  - the scheduled task script (watchlist-monitor.ts) — runs without LLM
 *
 * Schema is created on first open. Migrations are intentionally trivial
 * (CREATE TABLE IF NOT EXISTS) — if we need to evolve, add explicit
 * ALTER TABLE blocks gated on PRAGMA user_version.
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DB_PATH = process.env.POKEMON_WATCHER_DB_PATH || '/workspace/agent/pokemon-watcher.db';

let cached: Database | null = null;

export function openDb(): Database {
  if (cached) return cached;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode=DELETE');
  db.exec('PRAGMA foreign_keys=ON');
  initSchema(db);
  cached = db;
  return db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      blueprint_id     INTEGER PRIMARY KEY,
      name             TEXT NOT NULL,
      expansion        TEXT,
      game             TEXT,
      language         TEXT,
      foil             INTEGER,
      condition_min    TEXT,
      target_price_eur REAL,
      drop_pct         REAL NOT NULL DEFAULT 15.0,
      notes            TEXT,
      created_at       TEXT NOT NULL,
      paused           INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      blueprint_id  INTEGER NOT NULL,
      ts            TEXT NOT NULL,
      min_price_eur REAL,
      median_eur    REAL,
      listings_count INTEGER NOT NULL,
      snapshot_json TEXT,
      FOREIGN KEY(blueprint_id) REFERENCES watchlist(blueprint_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_bp_ts ON price_history(blueprint_id, ts DESC);

    CREATE TABLE IF NOT EXISTS alerts_sent (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      blueprint_id  INTEGER NOT NULL,
      ts            TEXT NOT NULL,
      price_eur     REAL NOT NULL,
      median30d     REAL,
      reason        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_sent_bp_ts ON alerts_sent(blueprint_id, ts DESC);

    -- Bargain hunter: temporal price comparison across full scans.
    -- One scan = many snapshots, one per (blueprint, variant). Bargain
    -- detection compares each variant's current min price vs the same
    -- variant's price in the previous completed scan.
    CREATE TABLE IF NOT EXISTS bargain_scans (
      scan_id        TEXT PRIMARY KEY,
      status         TEXT NOT NULL,           -- 'running' | 'completed' | 'failed' | 'aborted'
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      expansion_ids  TEXT NOT NULL,           -- JSON array
      threshold_pct  REAL NOT NULL,
      total_blueprints  INTEGER,
      done_blueprints   INTEGER NOT NULL DEFAULT 0,
      api_errors        INTEGER NOT NULL DEFAULT 0,
      api_retries       INTEGER NOT NULL DEFAULT 0,
      candidates_count  INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT,
      log_path          TEXT
    );

    CREATE TABLE IF NOT EXISTS bargain_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id       TEXT NOT NULL REFERENCES bargain_scans(scan_id) ON DELETE CASCADE,
      blueprint_id  INTEGER NOT NULL,
      name          TEXT,
      expansion_id  INTEGER,
      expansion_name TEXT,
      variant_key   TEXT NOT NULL,             -- canonical hash of distinguishing properties
      variant_props TEXT NOT NULL,             -- JSON of the properties used for variant_key (for display)
      min_price_eur REAL,                       -- min among CT0 listings for this variant
      listings_count INTEGER NOT NULL,
      sample_seller TEXT,                       -- seller username of the min listing (for display)
      ts            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bargain_snapshots_scan_bp_var
      ON bargain_snapshots(scan_id, blueprint_id, variant_key);
    CREATE INDEX IF NOT EXISTS idx_bargain_snapshots_var_ts
      ON bargain_snapshots(variant_key, ts DESC);

    CREATE TABLE IF NOT EXISTS bargain_candidates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id       TEXT NOT NULL REFERENCES bargain_scans(scan_id) ON DELETE CASCADE,
      blueprint_id  INTEGER NOT NULL,
      name          TEXT,
      expansion_name TEXT,
      variant_key   TEXT NOT NULL,
      variant_props TEXT NOT NULL,
      prev_min_eur  REAL NOT NULL,
      curr_min_eur  REAL NOT NULL,
      drop_pct      REAL NOT NULL,
      prev_scan_id  TEXT NOT NULL,
      sample_seller TEXT,
      flagged_at    TEXT NOT NULL,
      notified      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_bargain_candidates_scan
      ON bargain_candidates(scan_id);
  `);
}

export interface WatchEntry {
  blueprint_id: number;
  name: string;
  expansion: string | null;
  game: string | null;
  language: string | null;
  foil: number | null;
  condition_min: string | null;
  target_price_eur: number | null;
  drop_pct: number;
  notes: string | null;
  created_at: string;
  paused: number;
}

export function addWatchEntry(e: Omit<WatchEntry, 'created_at' | 'paused'>): void {
  const db = openDb();
  db.prepare(
    `INSERT OR REPLACE INTO watchlist
     (blueprint_id, name, expansion, game, language, foil, condition_min,
      target_price_eur, drop_pct, notes, created_at, paused)
     VALUES ($bp, $name, $exp, $game, $lang, $foil, $cond, $target, $drop, $notes, $ts, 0)`,
  ).run({
    $bp: e.blueprint_id,
    $name: e.name,
    $exp: e.expansion,
    $game: e.game,
    $lang: e.language,
    $foil: e.foil,
    $cond: e.condition_min,
    $target: e.target_price_eur,
    $drop: e.drop_pct,
    $notes: e.notes,
    $ts: new Date().toISOString(),
  });
}

export function removeWatchEntry(blueprintId: number): boolean {
  const db = openDb();
  const r = db.prepare('DELETE FROM watchlist WHERE blueprint_id=$bp').run({ $bp: blueprintId });
  return r.changes > 0;
}

export function listWatch(includePaused = true): WatchEntry[] {
  const db = openDb();
  const sql = includePaused
    ? 'SELECT * FROM watchlist ORDER BY name'
    : 'SELECT * FROM watchlist WHERE paused=0 ORDER BY name';
  return db.prepare(sql).all() as WatchEntry[];
}

export function setPaused(blueprintId: number, paused: boolean): boolean {
  const db = openDb();
  const r = db
    .prepare('UPDATE watchlist SET paused=$p WHERE blueprint_id=$bp')
    .run({ $p: paused ? 1 : 0, $bp: blueprintId });
  return r.changes > 0;
}

export interface PriceSample {
  ts: string;
  min_price_eur: number | null;
  median_eur: number | null;
  listings_count: number;
}

export function recordPriceSample(
  blueprintId: number,
  sample: PriceSample,
  snapshotJson?: string,
): void {
  openDb()
    .prepare(
      `INSERT INTO price_history
       (blueprint_id, ts, min_price_eur, median_eur, listings_count, snapshot_json)
       VALUES ($bp, $ts, $min, $med, $n, $snap)`,
    )
    .run({
      $bp: blueprintId,
      $ts: sample.ts,
      $min: sample.min_price_eur,
      $med: sample.median_eur,
      $n: sample.listings_count,
      $snap: snapshotJson ?? null,
    });
}

export function median30dFor(blueprintId: number): number | null {
  const rows = openDb()
    .prepare(
      `SELECT min_price_eur FROM price_history
       WHERE blueprint_id=$bp
         AND ts >= datetime('now','-30 days')
         AND min_price_eur IS NOT NULL`,
    )
    .all({ $bp: blueprintId }) as Array<{ min_price_eur: number }>;
  if (rows.length === 0) return null;
  const sorted = rows.map((r) => r.min_price_eur).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function recentHistory(blueprintId: number, limit = 20): PriceSample[] {
  return openDb()
    .prepare(
      `SELECT ts, min_price_eur, median_eur, listings_count
       FROM price_history WHERE blueprint_id=$bp ORDER BY ts DESC LIMIT $n`,
    )
    .all({ $bp: blueprintId, $n: limit }) as PriceSample[];
}

export function recentAlertWithin(blueprintId: number, hours: number): boolean {
  const r = openDb()
    .prepare(
      `SELECT 1 FROM alerts_sent WHERE blueprint_id=$bp
       AND ts >= datetime('now', $delta) LIMIT 1`,
    )
    .get({ $bp: blueprintId, $delta: `-${hours} hours` });
  return r != null;
}

// ---------------------------------------------------------------------------
// Bargain hunter helpers
// ---------------------------------------------------------------------------

export interface BargainScan {
  scan_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  expansion_ids: string;
  threshold_pct: number;
  total_blueprints: number | null;
  done_blueprints: number;
  api_errors: number;
  api_retries: number;
  candidates_count: number;
  last_error: string | null;
  log_path: string | null;
}

export function createBargainScan(scanId: string, expansionIds: number[], thresholdPct: number, logPath: string): void {
  openDb()
    .prepare(
      `INSERT INTO bargain_scans (scan_id, status, started_at, expansion_ids, threshold_pct, log_path)
       VALUES ($id, 'running', $ts, $exp, $th, $log)`,
    )
    .run({
      $id: scanId,
      $ts: new Date().toISOString(),
      $exp: JSON.stringify(expansionIds),
      $th: thresholdPct,
      $log: logPath,
    });
}

export function updateBargainScanProgress(
  scanId: string,
  patch: Partial<{
    total_blueprints: number;
    done_blueprints: number;
    api_errors: number;
    api_retries: number;
    candidates_count: number;
    last_error: string | null;
  }>,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k}=$${k}`).join(', ');
  const params: Record<string, unknown> = { $id: scanId };
  for (const k of keys) params[`$${k}`] = (patch as Record<string, unknown>)[k];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openDb().prepare(`UPDATE bargain_scans SET ${set} WHERE scan_id=$id`).run(params as any);
}

export function finishBargainScan(scanId: string, status: 'completed' | 'failed' | 'aborted', err?: string): void {
  openDb()
    .prepare(
      `UPDATE bargain_scans SET status=$s, finished_at=$ts, last_error=COALESCE($e, last_error) WHERE scan_id=$id`,
    )
    .run({ $id: scanId, $s: status, $ts: new Date().toISOString(), $e: err ?? null });
}

export function getBargainScan(scanId: string): BargainScan | null {
  const r = openDb().prepare('SELECT * FROM bargain_scans WHERE scan_id=$id').get({ $id: scanId });
  return (r as BargainScan | undefined) ?? null;
}

export function latestBargainScan(): BargainScan | null {
  const r = openDb().prepare('SELECT * FROM bargain_scans ORDER BY started_at DESC LIMIT 1').get();
  return (r as BargainScan | undefined) ?? null;
}

export function recordBargainSnapshot(row: {
  scan_id: string;
  blueprint_id: number;
  name: string | null;
  expansion_id: number | null;
  expansion_name: string | null;
  variant_key: string;
  variant_props: string;
  min_price_eur: number | null;
  listings_count: number;
  sample_seller: string | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO bargain_snapshots
       (scan_id, blueprint_id, name, expansion_id, expansion_name, variant_key, variant_props,
        min_price_eur, listings_count, sample_seller, ts)
       VALUES ($scan, $bp, $name, $exp, $expname, $vk, $vp, $min, $n, $seller, $ts)`,
    )
    .run({
      $scan: row.scan_id,
      $bp: row.blueprint_id,
      $name: row.name,
      $exp: row.expansion_id,
      $expname: row.expansion_name,
      $vk: row.variant_key,
      $vp: row.variant_props,
      $min: row.min_price_eur,
      $n: row.listings_count,
      $seller: row.sample_seller,
      $ts: new Date().toISOString(),
    });
}

/**
 * For a given variant in the current scan, find the same variant's min price
 * from the most recent *previous* completed scan.
 */
export function previousVariantPrice(
  variantKey: string,
  currentScanId: string,
): { scan_id: string; min_price_eur: number; listings_count: number } | null {
  const r = openDb()
    .prepare(
      `SELECT bs.scan_id, bs.min_price_eur, bs.listings_count
       FROM bargain_snapshots bs
       JOIN bargain_scans s ON s.scan_id = bs.scan_id
       WHERE bs.variant_key = $vk
         AND bs.scan_id != $cur
         AND s.status = 'completed'
         AND bs.min_price_eur IS NOT NULL
       ORDER BY bs.ts DESC
       LIMIT 1`,
    )
    .get({ $vk: variantKey, $cur: currentScanId });
  return (r as { scan_id: string; min_price_eur: number; listings_count: number } | undefined) ?? null;
}

export function recordBargainCandidate(row: {
  scan_id: string;
  blueprint_id: number;
  name: string | null;
  expansion_name: string | null;
  variant_key: string;
  variant_props: string;
  prev_min_eur: number;
  curr_min_eur: number;
  drop_pct: number;
  prev_scan_id: string;
  sample_seller: string | null;
}): void {
  openDb()
    .prepare(
      `INSERT INTO bargain_candidates
       (scan_id, blueprint_id, name, expansion_name, variant_key, variant_props,
        prev_min_eur, curr_min_eur, drop_pct, prev_scan_id, sample_seller, flagged_at)
       VALUES ($scan, $bp, $name, $expname, $vk, $vp, $prev, $curr, $drop, $prev_scan, $seller, $ts)`,
    )
    .run({
      $scan: row.scan_id,
      $bp: row.blueprint_id,
      $name: row.name,
      $expname: row.expansion_name,
      $vk: row.variant_key,
      $vp: row.variant_props,
      $prev: row.prev_min_eur,
      $curr: row.curr_min_eur,
      $drop: row.drop_pct,
      $prev_scan: row.prev_scan_id,
      $seller: row.sample_seller,
      $ts: new Date().toISOString(),
    });
}

export interface BargainCandidate {
  id: number;
  scan_id: string;
  blueprint_id: number;
  name: string | null;
  expansion_name: string | null;
  variant_key: string;
  variant_props: string;
  prev_min_eur: number;
  curr_min_eur: number;
  drop_pct: number;
  prev_scan_id: string;
  sample_seller: string | null;
  flagged_at: string;
  notified: number;
}

export function listBargainCandidates(scanId: string): BargainCandidate[] {
  return openDb()
    .prepare(`SELECT * FROM bargain_candidates WHERE scan_id=$id ORDER BY drop_pct DESC`)
    .all({ $id: scanId }) as BargainCandidate[];
}

export function markCandidatesNotified(scanId: string): void {
  openDb().prepare(`UPDATE bargain_candidates SET notified=1 WHERE scan_id=$id`).run({ $id: scanId });
}

export function recordAlert(blueprintId: number, priceEur: number, median30d: number | null, reason: string): void {
  openDb()
    .prepare(
      `INSERT INTO alerts_sent (blueprint_id, ts, price_eur, median30d, reason)
       VALUES ($bp, $ts, $price, $med, $reason)`,
    )
    .run({
      $bp: blueprintId,
      $ts: new Date().toISOString(),
      $price: priceEur,
      $med: median30d,
      $reason: reason,
    });
}
