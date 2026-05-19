/**
 * Bargain hunter — full async scan of CardTrader expansions for outlier prices.
 *
 * Detection: per (blueprint, variant), compare current CT0 min price against
 * the same variant's min price from the most recent *previous* completed scan.
 * Flag when drop_pct >= threshold.
 *
 * Process model:
 *   - Launched as a detached process by the MCP tool `pokemon_bargain_scan_start`.
 *   - Persists progress to bargain_scans + bargain_snapshots tables as it runs,
 *     so the agent can poll status and pick up results even if the container
 *     was respawned mid-scan.
 *   - On finish, status is flipped to 'completed' / 'failed'.
 *
 * Args (process.argv):
 *   --scan-id <uuid>          required
 *   --expansion-ids <list>    comma-separated ints, required
 *   --threshold-pct <num>     default 20
 *   --log-path <path>         optional; defaults to /workspace/agent/logs/bargain-<scan>.log
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createBargainScan,
  finishBargainScan,
  recordBargainCandidate,
  recordBargainSnapshot,
  previousVariantPrice,
  updateBargainScanProgress,
} from './db.js';
import {
  extractVariant,
  getJsonResilient,
  listingPriceEur,
  type FetchStats,
  type MarketplaceListing,
} from './api.js';

interface Args {
  scanId: string;
  expansionIds: number[];
  thresholdPct: number;
  logPath: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scanId = get('--scan-id');
  const exp = get('--expansion-ids');
  if (!scanId) throw new Error('Missing --scan-id');
  if (!exp) throw new Error('Missing --expansion-ids');
  const expansionIds = exp
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (expansionIds.length === 0) throw new Error('No valid expansion ids');
  const thresholdPct = Number(get('--threshold-pct') ?? '20');
  const logPath =
    get('--log-path') ||
    path.join('/workspace/agent/logs', `bargain-${scanId}.log`);
  return { scanId, expansionIds, thresholdPct, logPath };
}

function ensureLogDir(p: string): void {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logger(logPath: string) {
  ensureLogDir(logPath);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    stream.write(line);
  };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = logger(args.logPath);
  log(`Bargain scan starting: scan_id=${args.scanId} expansions=[${args.expansionIds.join(',')}] threshold=${args.thresholdPct}%`);

  // Register scan row (idempotent — caller may have created it already).
  try {
    createBargainScan(args.scanId, args.expansionIds, args.thresholdPct, args.logPath);
  } catch {
    // already exists — that's fine, we'll update it in place
  }

  const stats: FetchStats = { retries: 0, errors: 0 };
  const expansionNames = new Map<number, string>();

  try {
    // Step 1: load expansions index for human-readable names
    const expansions = (await getJsonResilient('/expansions', undefined, stats, 5)) as unknown[] | null;
    if (Array.isArray(expansions)) {
      for (const e of expansions) {
        const o = e as { id?: number; name?: string };
        if (typeof o.id === 'number' && typeof o.name === 'string') expansionNames.set(o.id, o.name);
      }
    } else {
      log('WARN: could not load /expansions index — names will be missing');
    }

    // Step 2: gather all blueprints across requested expansions
    const allBlueprints: Array<{ id: number; name: string; expansion_id: number }> = [];
    for (const expId of args.expansionIds) {
      const bps = (await getJsonResilient('/blueprints/export', { expansion_id: expId }, stats, 5)) as unknown[] | null;
      if (!Array.isArray(bps)) {
        log(`WARN: failed to fetch blueprints for expansion ${expId}`);
        continue;
      }
      for (const b of bps) {
        const o = b as { id?: number; name?: string };
        if (typeof o.id === 'number' && typeof o.name === 'string') {
          allBlueprints.push({ id: o.id, name: o.name, expansion_id: expId });
        }
      }
      await sleep(200);
    }
    log(`Collected ${allBlueprints.length} blueprints across ${args.expansionIds.length} expansion(s)`);
    updateBargainScanProgress(args.scanId, {
      total_blueprints: allBlueprints.length,
      api_retries: stats.retries,
      api_errors: stats.errors,
    });

    // Step 3: iterate blueprints, fetch CT0 listings, snapshot per variant, detect drops
    const REQUEST_SPACING_MS = 200;
    const PROGRESS_FLUSH_EVERY = 25;
    let done = 0;
    let candidatesCount = 0;

    for (const bp of allBlueprints) {
      const raw = (await getJsonResilient('/marketplace/products', { blueprint_id: bp.id }, stats, 5)) as
        | unknown
        | null;

      let listings: MarketplaceListing[] = [];
      if (Array.isArray(raw)) {
        listings = raw as MarketplaceListing[];
      } else if (raw && typeof raw === 'object') {
        for (const v of Object.values(raw as Record<string, unknown>)) {
          if (Array.isArray(v)) listings = listings.concat(v as MarketplaceListing[]);
        }
      }

      // Filter to CT0 (hub-eligible) + sanity filters
      listings = listings.filter(
        (l) => l.user?.can_sell_via_hub === true && !l.on_vacation && !l.graded,
      );

      // Group by variant
      const buckets = new Map<
        string,
        { props: Record<string, unknown>; prices: number[]; sellers: string[] }
      >();
      for (const l of listings) {
        const v = extractVariant(l);
        const price = listingPriceEur(l);
        if (price == null) continue;
        const bucket = buckets.get(v.key) || { props: v.props, prices: [], sellers: [] };
        bucket.prices.push(price);
        if (l.user?.username) bucket.sellers.push(l.user.username);
        buckets.set(v.key, bucket);
      }

      // Snapshot each variant + compare to previous scan
      for (const [vk, b] of buckets) {
        b.prices.sort((x, y) => x - y);
        const minPrice = b.prices[0];
        const minIdx = b.prices.indexOf(minPrice);
        const sampleSeller = b.sellers[minIdx] || b.sellers[0] || null;

        recordBargainSnapshot({
          scan_id: args.scanId,
          blueprint_id: bp.id,
          name: bp.name,
          expansion_id: bp.expansion_id,
          expansion_name: expansionNames.get(bp.expansion_id) || null,
          variant_key: vk,
          variant_props: JSON.stringify(b.props),
          min_price_eur: minPrice,
          listings_count: b.prices.length,
          sample_seller: sampleSeller,
        });

        const prev = previousVariantPrice(vk, args.scanId);
        // ----------------------------------------------------------------
        // Bargain detection filters (anti false-positive)
        // ----------------------------------------------------------------
        // Rationale: an earlier production run produced 16k "candidates"
        // dominated by junk: single-listing prev_min anomalies (e.g. a
        // seller typo making one listing €8222 instead of €82.22), penny
        // cards where prev=€0.50 → curr=€0.30 is "40% drop" but worthless,
        // and >90% drops that are almost always artifacts not real deals.
        // We require:
        //   - both scans had >= MIN_LISTINGS_PER_SIDE CT0 listings for the variant
        //   - prev_min >= MIN_PREV_PRICE (skip pure junk)
        //   - drop within [thresholdPct, MAX_DROP_PCT] (cap removes outliers)
        const MIN_LISTINGS_PER_SIDE = 3;
        const MIN_PREV_PRICE_EUR = 5;
        const MAX_DROP_PCT = 70;
        const robustEnough =
          prev != null &&
          prev.min_price_eur >= MIN_PREV_PRICE_EUR &&
          prev.listings_count >= MIN_LISTINGS_PER_SIDE &&
          b.prices.length >= MIN_LISTINGS_PER_SIDE;
        if (robustEnough && prev.min_price_eur > 0) {
          const dropPct = ((prev.min_price_eur - minPrice) / prev.min_price_eur) * 100;
          if (dropPct >= args.thresholdPct && dropPct <= MAX_DROP_PCT) {
            recordBargainCandidate({
              scan_id: args.scanId,
              blueprint_id: bp.id,
              name: bp.name,
              expansion_name: expansionNames.get(bp.expansion_id) || null,
              variant_key: vk,
              variant_props: JSON.stringify(b.props),
              prev_min_eur: prev.min_price_eur,
              curr_min_eur: minPrice,
              drop_pct: dropPct,
              prev_scan_id: prev.scan_id,
              sample_seller: sampleSeller,
            });
            candidatesCount++;
            log(
              `BARGAIN: bp=${bp.id} "${bp.name}" variant=${vk.slice(0, 80)} ` +
                `€${prev.min_price_eur.toFixed(2)} → €${minPrice.toFixed(2)} (-${dropPct.toFixed(1)}%)`,
            );
          }
        }
      }

      done++;
      if (done % PROGRESS_FLUSH_EVERY === 0 || done === allBlueprints.length) {
        updateBargainScanProgress(args.scanId, {
          done_blueprints: done,
          api_retries: stats.retries,
          api_errors: stats.errors,
          candidates_count: candidatesCount,
        });
        log(`progress ${done}/${allBlueprints.length} candidates=${candidatesCount} retries=${stats.retries} errors=${stats.errors}`);
      }
      await sleep(REQUEST_SPACING_MS);
    }

    updateBargainScanProgress(args.scanId, {
      done_blueprints: done,
      api_retries: stats.retries,
      api_errors: stats.errors,
      candidates_count: candidatesCount,
    });
    finishBargainScan(args.scanId, 'completed');
    log(`DONE. blueprints=${done} candidates=${candidatesCount} retries=${stats.retries} errors=${stats.errors}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${msg}`);
    finishBargainScan(args.scanId, 'failed', msg);
    process.exit(1);
  }
}

main();
