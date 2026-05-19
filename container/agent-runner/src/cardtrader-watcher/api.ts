/**
 * Thin CardTrader API client shared by the MCP tools and the scheduled
 * scripts. Uses fetch (Bun has it natively); auth is injected by the
 * OneCLI gateway via HTTPS_PROXY, so we don't add Authorization here.
 */
const BASE_URL = process.env.CARDTRADER_BASE_URL || 'https://api.cardtrader.com/api/v2';

export interface MarketplaceListing {
  id?: number;
  price?: { cents?: number; currency?: string; formatted?: string };
  price_cents?: number;
  user?: { username?: string; can_sell_via_hub?: boolean; country_code?: string };
  quantity?: number;
  properties_hash?: { condition?: string; mtg_language?: string; pokemon_language?: string; signed?: boolean };
  on_vacation?: boolean;
  bundle_size?: number;
  graded?: boolean;
  [k: string]: unknown;
}

export interface FetchStats {
  retries: number;
  errors: number;
}

/**
 * Default fetch wrapper. Single try, no retries. Used by simple lookups
 * (games, expansions, single blueprint searches) where the caller can
 * just bail on failure.
 */
async function getJson(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const url = new URL(BASE_URL.replace(/\/$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'nanoclaw-pokemon-watcher/1.0' },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`CardTrader ${path} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Resilient GET with exponential backoff for transient errors (429, 5xx,
 * network). Designed for the bargain hunter which makes hundreds of calls
 * and must survive temporary CardTrader throttling. Mutates `stats` so the
 * caller can persist retry/error counts.
 *
 * Returns null on persistent failure (after max attempts).
 */
export async function getJsonResilient(
  path: string,
  query: Record<string, string | number | boolean | undefined> | undefined,
  stats: FetchStats,
  maxAttempts = 5,
): Promise<unknown | null> {
  const url = new URL(BASE_URL.replace(/\/$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url.toString(), {
        headers: { Accept: 'application/json', 'User-Agent': 'nanoclaw-pokemon-watcher/1.0' },
      });
      if (r.ok) {
        const text = await r.text();
        return text ? JSON.parse(text) : null;
      }
      // Transient: retry. 4xx (except 429) is permanent.
      if (r.status === 429 || r.status >= 500) {
        stats.retries++;
        // Honor Retry-After header if present, else exponential backoff.
        const ra = r.headers.get('retry-after');
        const waitMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : Math.min(15_000, 500 * Math.pow(2, attempt - 1));
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }
      stats.errors++;
      return null; // permanent failure
    } catch {
      stats.retries++;
      const waitMs = Math.min(15_000, 500 * Math.pow(2, attempt - 1));
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }
  stats.errors++;
  return null;
}

export async function searchBlueprints(expansionId: number): Promise<unknown[]> {
  const data = await getJson('/blueprints/export', { expansion_id: expansionId });
  return Array.isArray(data) ? data : [];
}

export async function listExpansions(): Promise<unknown[]> {
  const data = await getJson('/expansions');
  return Array.isArray(data) ? data : [];
}

export async function listGames(): Promise<unknown[]> {
  const data = await getJson('/games');
  return Array.isArray(data) ? data : [];
}

/**
 * Search marketplace listings. Filters are applied server-side where supported.
 * `condition_min` and `only_zero` are applied client-side after fetch.
 *
 * `only_zero` defaults to true: keep only listings whose seller is hub-enabled
 * (`user.can_sell_via_hub === true`), i.e. CardTrader Zero eligible. The user
 * has stated they can only buy CT0 listings, so this is the safe default for
 * everything in this codebase. Pass false explicitly to see the full market.
 */
export async function searchListings(opts: {
  blueprint_id: number;
  foil?: boolean | null;
  language?: string | null;
  condition_min?: string | null;
  only_zero?: boolean;
}): Promise<MarketplaceListing[]> {
  const q: Record<string, string | number | boolean | undefined> = { blueprint_id: opts.blueprint_id };
  if (opts.foil != null) q.foil = opts.foil;
  if (opts.language) q.language = opts.language;
  const raw = await getJson('/marketplace/products', q);
  let arr: MarketplaceListing[] = [];
  if (Array.isArray(raw)) {
    arr = raw as MarketplaceListing[];
  } else if (raw && typeof raw === 'object') {
    // CardTrader sometimes wraps response: { "<blueprint_id>": [...] }
    const obj = raw as Record<string, unknown>;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) arr = arr.concat(v as MarketplaceListing[]);
    }
  }
  // Filter on-vacation sellers and graded items by default (graded skews pricing)
  arr = arr.filter((l) => !l.on_vacation && !l.graded);
  const onlyZero = opts.only_zero !== false; // default true
  if (onlyZero) {
    arr = arr.filter((l) => l?.user?.can_sell_via_hub === true);
  }
  if (opts.condition_min) {
    arr = arr.filter((l) => meetsConditionMin(l?.properties_hash?.condition, opts.condition_min!));
  }
  return arr;
}

const CONDITION_ORDER = ['Poor', 'Played', 'Good', 'Excellent', 'Near Mint', 'Mint'];

function meetsConditionMin(cond: string | undefined, min: string): boolean {
  if (!cond) return false;
  const i = CONDITION_ORDER.indexOf(cond);
  const j = CONDITION_ORDER.indexOf(min);
  if (i === -1 || j === -1) return true; // unknown — don't filter out
  return i >= j;
}

export function listingPriceEur(l: MarketplaceListing): number | null {
  const cents = typeof l.price_cents === 'number' ? l.price_cents : l.price?.cents;
  if (typeof cents !== 'number') return null;
  const cur = (l.price?.currency || 'EUR').toUpperCase();
  if (cur !== 'EUR') return null; // skip non-EUR for now (CardTrader is mostly EUR)
  return cents / 100;
}

// ---------------------------------------------------------------------------
// Variant extraction — what makes two CardTrader listings "the same card"
// for pricing comparison. Two listings share a variant_key when ALL of these
// match: language, condition, foil, signed, 1st-edition flag, and any other
// property hash key that affects price. We canonicalize via sorted JSON.
// ---------------------------------------------------------------------------

const VARIANT_PROPERTY_KEYS = [
  'pokemon_language',
  'mtg_language',
  'condition',
  'signed',
  'altered',
  'first_edition',
  'extra', // CardTrader uses this for 1st ed, holo, reverse, etc. on some games
  'foil',  // sometimes in properties_hash rather than top-level
];

export interface VariantInfo {
  key: string;
  props: Record<string, unknown>;
}

export function extractVariant(listing: MarketplaceListing): VariantInfo {
  const props: Record<string, unknown> = {};
  const ph = (listing.properties_hash || {}) as Record<string, unknown>;
  for (const k of VARIANT_PROPERTY_KEYS) {
    if (ph[k] !== undefined) props[k] = ph[k];
  }
  // top-level foil (when CardTrader exposes it outside properties_hash)
  if ((listing as Record<string, unknown>).foil !== undefined && props.foil === undefined) {
    props.foil = (listing as Record<string, unknown>).foil;
  }
  // canonical key: sorted JSON of non-null values
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(props).sort()) {
    if (props[k] !== null && props[k] !== undefined && props[k] !== '') ordered[k] = props[k];
  }
  return { key: JSON.stringify(ordered), props: ordered };
}

export function summarizeListings(listings: MarketplaceListing[]): {
  min: number | null;
  median: number | null;
  count: number;
} {
  const prices = listings.map(listingPriceEur).filter((p): p is number => p != null).sort((a, b) => a - b);
  if (prices.length === 0) return { min: null, median: null, count: 0 };
  const min = prices[0];
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid];
  return { min, median, count: prices.length };
}
