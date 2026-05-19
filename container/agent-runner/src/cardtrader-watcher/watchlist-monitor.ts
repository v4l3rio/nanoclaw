/**
 * Watchlist monitor — runs as the schedule_task pre-script (no LLM cost).
 *
 * Iterates the watchlist, queries CardTrader marketplace, records a price
 * sample, and decides whether the agent should be woken to notify the
 * user. Output protocol (stdout, single JSON line):
 *
 *   { "wakeAgent": <bool>, "data": { ... } }
 *
 * Wake only if at least one card crossed an alert threshold AND no alert
 * for the same card was sent in the last 24h.
 *
 * Alert rules (per card):
 *   - target_price_eur set: alert when min_price <= target
 *   - else if median30d available and >= 3 samples: alert when
 *     (median30d - min_price) / median30d >= drop_pct / 100
 *
 * During warm-up (< 3 history samples for a card), we record but never
 * alert.
 */
import {
  addWatchEntry as _addUnused, // silence unused import in some bun configs
  listWatch,
  median30dFor,
  recentAlertWithin,
  recordAlert,
  recordPriceSample,
} from './db.js';
import { searchListings, summarizeListings } from './api.js';
import { Database } from 'bun:sqlite';
import { DB_PATH } from './db.js';

void _addUnused;

const MIN_SAMPLES_FOR_PCT_ALERT = 3;
const ALERT_COOLDOWN_HOURS = 24;
const MAX_LISTINGS_PER_CARD = 20;
const REQUEST_SPACING_MS = 150; // ~6 req/s, well under the 10/s cap

interface CardAlert {
  blueprint_id: number;
  name: string;
  expansion: string | null;
  min_price_eur: number;
  median30d_eur: number | null;
  drop_pct_observed: number | null;
  target_price_eur: number | null;
  reason: 'target_hit' | 'pct_drop';
  top_listings: Array<{ price: number; condition?: string; language?: string; seller?: string }>;
}

function sampleCount(blueprintId: number): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const r = db
      .prepare('SELECT COUNT(*) AS c FROM price_history WHERE blueprint_id=$bp')
      .get({ $bp: blueprintId }) as { c: number };
    return r.c;
  } finally {
    db.close();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const entries = listWatch(false); // exclude paused
  const alerts: CardAlert[] = [];
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0) await sleep(REQUEST_SPACING_MS);

    try {
      const listings = await searchListings({
        blueprint_id: e.blueprint_id,
        foil: e.foil == null ? undefined : Boolean(e.foil),
        language: e.language,
        condition_min: e.condition_min,
      });
      const top = listings.slice(0, MAX_LISTINGS_PER_CARD);
      const summary = summarizeListings(top);
      recordPriceSample(e.blueprint_id, {
        ts: new Date().toISOString(),
        min_price_eur: summary.min,
        median_eur: summary.median,
        listings_count: summary.count,
      });

      if (summary.min == null) continue;

      const median30 = median30dFor(e.blueprint_id);
      const samples = sampleCount(e.blueprint_id);

      let alertReason: CardAlert['reason'] | null = null;
      let dropPct: number | null = null;

      if (e.target_price_eur != null && summary.min <= e.target_price_eur) {
        alertReason = 'target_hit';
      } else if (
        median30 != null &&
        median30 > 0 &&
        samples >= MIN_SAMPLES_FOR_PCT_ALERT
      ) {
        dropPct = ((median30 - summary.min) / median30) * 100;
        if (dropPct >= e.drop_pct) alertReason = 'pct_drop';
      }

      if (!alertReason) continue;
      if (recentAlertWithin(e.blueprint_id, ALERT_COOLDOWN_HOURS)) continue;

      const reasonLabel = alertReason === 'target_hit' ? `target_hit@${e.target_price_eur}` : `drop_${dropPct?.toFixed(1)}%`;
      recordAlert(e.blueprint_id, summary.min, median30, reasonLabel);

      alerts.push({
        blueprint_id: e.blueprint_id,
        name: e.name,
        expansion: e.expansion,
        min_price_eur: summary.min,
        median30d_eur: median30,
        drop_pct_observed: dropPct,
        target_price_eur: e.target_price_eur,
        reason: alertReason,
        top_listings: top.slice(0, 5).map((l) => {
          const cents = typeof l.price_cents === 'number' ? l.price_cents : l.price?.cents;
          const price = typeof cents === 'number' ? cents / 100 : NaN;
          return {
            price,
            condition: l.properties_hash?.condition,
            language: l.properties_hash?.mtg_language || l.properties_hash?.pokemon_language,
            seller: l.user?.username,
          };
        }),
      });
    } catch (err) {
      errors.push(`bp=${e.blueprint_id} (${e.name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const out = {
    wakeAgent: alerts.length > 0,
    data: {
      ts: new Date().toISOString(),
      watched: entries.length,
      alerts,
      errors: errors.length > 0 ? errors : undefined,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({ wakeAgent: false, data: { error: err instanceof Error ? err.message : String(err) } }),
  );
  process.exit(0);
});
