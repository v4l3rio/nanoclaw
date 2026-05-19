/**
 * Pokemon watcher MCP tools.
 *
 * Lets the agent manage a personal watchlist of CardTrader cards stored
 * in a local SQLite at /workspace/agent/pokemon-watcher.db. Pairs with
 * the cardtrader_* tools (used for blueprint lookup) and with the
 * scheduled task script `watchlist-monitor.ts`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';
import {
  addWatchEntry,
  createBargainScan,
  getBargainScan,
  latestBargainScan,
  listBargainCandidates,
  listWatch,
  markCandidatesNotified,
  median30dFor,
  recentHistory,
  removeWatchEntry,
  setPaused,
} from '../cardtrader-watcher/db.js';

function fmtPrice(p: number | null | undefined): string {
  return p == null ? '—' : `€${p.toFixed(2)}`;
}

const watchlistAdd: McpToolDefinition = {
  tool: {
    name: 'pokemon_watchlist_add',
    description:
      'Add a CardTrader card to the watchlist. Lookup the blueprint_id first via the cardtrader_* tools (typically: list_games → list_expansions → list_blueprints → confirm with the user). Use `target_price_eur` if the user wants an absolute price alert, otherwise rely on the default drop_pct (vs median 30d).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        blueprint_id: { type: 'number', description: 'Required. CardTrader blueprint id.' },
        name: { type: 'string', description: 'Required. Human-readable card name.' },
        expansion: { type: 'string', description: 'Set/expansion name (for display).' },
        game: { type: 'string', description: 'Game name (e.g. "Pokemon"). Optional.' },
        language: { type: 'string', description: 'Filter — language code (e.g. "en", "it", "jp"). Omit for any language.' },
        foil: { type: 'boolean', description: 'Filter — true=foil only, false=non-foil only. Omit for any.' },
        condition_min: {
          type: 'string',
          enum: ['Poor', 'Played', 'Good', 'Excellent', 'Near Mint', 'Mint'],
          description: 'Minimum acceptable condition. Default: no constraint.',
        },
        target_price_eur: { type: 'number', description: 'Optional. Alert if min listing <= this price.' },
        drop_pct: {
          type: 'number',
          description: 'Default 15. Alert if min listing is this % below the 30-day median (after warm-up of 3 samples).',
        },
        notes: { type: 'string', description: 'Free-form note (e.g. why you want it).' },
      },
      required: ['blueprint_id', 'name'],
    },
  },
  async handler(args) {
    addWatchEntry({
      blueprint_id: args.blueprint_id as number,
      name: args.name as string,
      expansion: (args.expansion as string) || null,
      game: (args.game as string) || null,
      language: (args.language as string) || null,
      foil: typeof args.foil === 'boolean' ? (args.foil ? 1 : 0) : null,
      condition_min: (args.condition_min as string) || null,
      target_price_eur: typeof args.target_price_eur === 'number' ? (args.target_price_eur as number) : null,
      drop_pct: typeof args.drop_pct === 'number' ? (args.drop_pct as number) : 15,
      notes: (args.notes as string) || null,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `✓ Added blueprint_id=${args.blueprint_id} (${args.name}) to the watchlist.`,
        },
      ],
    };
  },
};

const watchlistRemove: McpToolDefinition = {
  tool: {
    name: 'pokemon_watchlist_remove',
    description: 'Remove a card from the watchlist by blueprint_id. Also deletes its price history.',
    inputSchema: {
      type: 'object' as const,
      properties: { blueprint_id: { type: 'number', description: 'Required.' } },
      required: ['blueprint_id'],
    },
  },
  async handler(args) {
    const ok = removeWatchEntry(args.blueprint_id as number);
    return {
      content: [{ type: 'text' as const, text: ok ? '✓ Removed.' : 'Not found.' }],
    };
  },
};

const watchlistPause: McpToolDefinition = {
  tool: {
    name: 'pokemon_watchlist_pause',
    description: 'Pause or resume monitoring for a card. Paused cards keep their history but the scheduled task skips them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        blueprint_id: { type: 'number', description: 'Required.' },
        paused: { type: 'boolean', description: 'true = pause, false = resume.' },
      },
      required: ['blueprint_id', 'paused'],
    },
  },
  async handler(args) {
    const ok = setPaused(args.blueprint_id as number, args.paused as boolean);
    return { content: [{ type: 'text' as const, text: ok ? '✓ Updated.' : 'Not found.' }] };
  },
};

const watchlistList: McpToolDefinition = {
  tool: {
    name: 'pokemon_watchlist_list',
    description:
      'Show the current watchlist with last known price and 30-day median for each card. Use this when the user asks "what am I watching?" or before suggesting changes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const rows = listWatch(true);
    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'Watchlist empty.' }] };
    }
    const lines = ['# Watchlist', ''];
    for (const r of rows) {
      const med = median30dFor(r.blueprint_id);
      const recent = recentHistory(r.blueprint_id, 1)[0];
      const filters: string[] = [];
      if (r.language) filters.push(`lang=${r.language}`);
      if (r.foil != null) filters.push(`foil=${r.foil ? 'yes' : 'no'}`);
      if (r.condition_min) filters.push(`cond≥${r.condition_min}`);
      const rule = r.target_price_eur != null ? `target ${fmtPrice(r.target_price_eur)}` : `drop ${r.drop_pct}%`;
      lines.push(
        `- **${r.name}**${r.expansion ? ` (${r.expansion})` : ''} — bp=${r.blueprint_id}${r.paused ? ' [paused]' : ''}`,
      );
      lines.push(
        `  last=${fmtPrice(recent?.min_price_eur)} · median30d=${fmtPrice(med)} · ${rule}${filters.length ? ' · ' + filters.join(', ') : ''}`,
      );
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

const watchlistHistory: McpToolDefinition = {
  tool: {
    name: 'pokemon_watchlist_history',
    description:
      'Return the recent price samples for a single watched card. Use to investigate a drop notification or to inspect trend.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        blueprint_id: { type: 'number', description: 'Required.' },
        limit: { type: 'number', description: 'Default 20.' },
      },
      required: ['blueprint_id'],
    },
  },
  async handler(args) {
    const rows = recentHistory(args.blueprint_id as number, (args.limit as number) || 20);
    if (rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No history yet for this blueprint.' }] };
    }
    const lines = [`# History bp=${args.blueprint_id} (most recent first)`, ''];
    for (const r of rows) {
      lines.push(`- ${r.ts} · min=${fmtPrice(r.min_price_eur)} · median=${fmtPrice(r.median_eur)} · n=${r.listings_count}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

// ---------------------------------------------------------------------------
// Bargain hunter — async background scans
// ---------------------------------------------------------------------------

const BARGAIN_SCRIPT = '/app/src/cardtrader-watcher/bargain-hunter.ts';
const BARGAIN_LOG_DIR = '/workspace/agent/logs';

const bargainStart: McpToolDefinition = {
  tool: {
    name: 'pokemon_bargain_scan_start',
    description:
      'Kick off a bargain hunter scan in the background. Iterates the given CardTrader expansions, snapshots CT0 min prices per (blueprint, variant), and flags variants whose price dropped >= threshold_pct vs the same variant in the most recent previous completed scan. Returns immediately with scan_id — use pokemon_bargain_scan_status to poll, and pokemon_bargain_scan_results when status=completed. Heavy: 5-15 minutes for a 5-set vintage premium pass.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expansion_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Required. CardTrader expansion ids to scan (lookup via cardtrader_list_expansions).',
        },
        threshold_pct: {
          type: 'number',
          description: 'Default 20. Flag a variant when (prev_min - curr_min) / prev_min >= this %.',
        },
      },
      required: ['expansion_ids'],
    },
  },
  async handler(args) {
    const expIds = Array.isArray(args.expansion_ids) ? (args.expansion_ids as number[]).filter((n) => Number.isFinite(n)) : [];
    if (expIds.length === 0) {
      return { content: [{ type: 'text' as const, text: 'expansion_ids required (non-empty array of numbers).' }] };
    }
    const threshold = typeof args.threshold_pct === 'number' ? (args.threshold_pct as number) : 20;
    const scanId = randomUUID();
    if (!fs.existsSync(BARGAIN_LOG_DIR)) fs.mkdirSync(BARGAIN_LOG_DIR, { recursive: true });
    const logPath = path.join(BARGAIN_LOG_DIR, `bargain-${scanId}.log`);

    // Register the scan row up-front so the agent can see status immediately.
    createBargainScan(scanId, expIds, threshold, logPath);

    // Detached spawn so the child outlives this MCP call (and the agent's
    // poll-loop cycle). stdio piped to log files; child unrefed.
    const out = fs.openSync(logPath, 'a');
    const child = spawn(
      'bun',
      [
        BARGAIN_SCRIPT,
        '--scan-id', scanId,
        '--expansion-ids', expIds.join(','),
        '--threshold-pct', String(threshold),
        '--log-path', logPath,
      ],
      { detached: true, stdio: ['ignore', out, out] },
    );
    child.unref();

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `✓ Bargain scan started.\n\n` +
            `scan_id: ${scanId}\n` +
            `expansions: ${expIds.length}\n` +
            `threshold: ${threshold}%\n` +
            `log: ${logPath}\n\n` +
            `Use pokemon_bargain_scan_status to check progress, then pokemon_bargain_scan_results when status=completed.`,
        },
      ],
    };
  },
};

const bargainStatus: McpToolDefinition = {
  tool: {
    name: 'pokemon_bargain_scan_status',
    description:
      'Check the status of a bargain scan. Omit scan_id to inspect the most recent scan. Returns status (running/completed/failed/aborted), progress (X/Y blueprints), retries/errors so far, and candidate count.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scan_id: { type: 'string', description: 'Optional. Defaults to most recent scan.' },
      },
    },
  },
  async handler(args) {
    const scan = args.scan_id ? getBargainScan(args.scan_id as string) : latestBargainScan();
    if (!scan) return { content: [{ type: 'text' as const, text: 'No bargain scan found.' }] };
    const pct = scan.total_blueprints
      ? Math.round((scan.done_blueprints / scan.total_blueprints) * 100)
      : 0;
    const lines = [
      `# Bargain scan ${scan.scan_id}`,
      `status: **${scan.status}**`,
      `started: ${scan.started_at}${scan.finished_at ? `\nfinished: ${scan.finished_at}` : ''}`,
      `expansions: ${scan.expansion_ids}`,
      `threshold: ${scan.threshold_pct}%`,
      `progress: ${scan.done_blueprints}/${scan.total_blueprints ?? '?'} (${pct}%)`,
      `API: retries=${scan.api_retries} errors=${scan.api_errors}`,
      `candidates: ${scan.candidates_count}`,
    ];
    if (scan.last_error) lines.push(`last_error: ${scan.last_error}`);
    if (scan.log_path) lines.push(`log: ${scan.log_path}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

const bargainResults: McpToolDefinition = {
  tool: {
    name: 'pokemon_bargain_scan_results',
    description:
      'Return the candidate list for a completed (or in-progress) bargain scan, sorted by drop_pct desc. Each candidate has the prev/curr price, the variant properties (1st ed, language, condition, foil, signed), and a sample seller. Omit scan_id for the most recent scan. Use mark_notified=true after surfacing the candidates to the user so they aren\'t shown twice.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scan_id: { type: 'string', description: 'Optional. Defaults to most recent scan.' },
        only_unnotified: { type: 'boolean', description: 'Default true. Skip candidates already marked notified.' },
        mark_notified: {
          type: 'boolean',
          description: 'Default false. If true, marks all candidates in this scan as notified after returning them.',
        },
        limit: { type: 'number', description: 'Default 50.' },
      },
    },
  },
  async handler(args) {
    const scan = args.scan_id ? getBargainScan(args.scan_id as string) : latestBargainScan();
    if (!scan) return { content: [{ type: 'text' as const, text: 'No bargain scan found.' }] };
    const onlyUnnotified = args.only_unnotified !== false;
    const limit = typeof args.limit === 'number' ? (args.limit as number) : 50;
    let cands = listBargainCandidates(scan.scan_id);
    if (onlyUnnotified) cands = cands.filter((c) => !c.notified);
    cands = cands.slice(0, limit);

    if (cands.length === 0) {
      return {
        content: [{ type: 'text' as const, text: `No candidates${onlyUnnotified ? ' (unnotified)' : ''} for scan ${scan.scan_id}.` }],
      };
    }

    const lines = [`# Bargain candidates (scan ${scan.scan_id}, status=${scan.status})`, ''];
    for (const c of cands) {
      const props = (() => {
        try {
          return JSON.parse(c.variant_props) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const propStr = Object.entries(props)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '(no variant props)';
      lines.push(
        `- **${c.name ?? `bp=${c.blueprint_id}`}** ${c.expansion_name ? `(${c.expansion_name})` : ''}`,
      );
      lines.push(
        `  €${c.prev_min_eur.toFixed(2)} → **€${c.curr_min_eur.toFixed(2)}** (-${c.drop_pct.toFixed(1)}%) · ${propStr} · seller=${c.sample_seller ?? '?'}`,
      );
      lines.push(`  bp=${c.blueprint_id} · https://www.cardtrader.com/cards/${c.blueprint_id}`);
    }

    if (args.mark_notified === true) {
      markCandidatesNotified(scan.scan_id);
      lines.push('');
      lines.push('(marked as notified)');
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

registerTools([
  watchlistAdd,
  watchlistRemove,
  watchlistPause,
  watchlistList,
  watchlistHistory,
  bargainStart,
  bargainStatus,
  bargainResults,
]);
