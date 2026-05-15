/**
 * Self health check MCP tool.
 *
 * Runs a battery of read-only diagnostics across every system the container
 * agent depends on, so the agent (or the user) can verify the install is
 * healthy after an upgrade. No external API calls — checks reachability and
 * configuration only.
 *
 * Categories:
 *   - system        runtime version + container.json config
 *   - db            inbound/outbound session DBs (integrity, expected tables)
 *   - filesystem    workspace mounts (agent, outbox, heartbeat, conversations)
 *   - destinations  configured outbound destinations
 *   - mcp           own MCP server + externally-configured MCP servers
 *   - onecli        HTTPS_PROXY env var + TCP reachability to gateway
 *   - cli           ncl CLI reachability (host responds via DB transport)
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { getAllDestinations } from '../destinations.js';
import { loadConfig } from '../config.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const STARTUP_TEMPLATE = '🔍 Avvio diagnostico completo — controllo runtime, DB, workspace, destinazioni, MCP, OneCLI e CLI. Un momento...';

type Status = 'pass' | 'warn' | 'fail' | 'info';

interface Check {
  category: string;
  name: string;
  status: Status;
  detail: string;
}

const ALL_CATEGORIES = ['system', 'db', 'filesystem', 'destinations', 'mcp', 'onecli', 'cli'] as const;
type Category = (typeof ALL_CATEGORIES)[number];

const INBOUND_DB_PATH = '/workspace/inbound.db';
const OUTBOUND_DB_PATH = '/workspace/outbound.db';
const HEARTBEAT_PATH = '/workspace/.heartbeat';
const AGENT_DIR = '/workspace/agent';
const OUTBOX_DIR = '/workspace/outbox';
const CONTAINER_JSON = '/workspace/agent/container.json';

function check(category: Category, name: string, status: Status, detail: string): Check {
  return { category, name, status, detail };
}

// ---------------------------------------------------------------------------
// Category: system
// ---------------------------------------------------------------------------

function checkSystem(): Check[] {
  const out: Check[] = [];
  const bunVer = typeof Bun !== 'undefined' ? Bun.version : null;
  out.push(check('system', 'bun runtime', bunVer ? 'pass' : 'fail', bunVer ? `Bun ${bunVer}` : 'Bun runtime not detected'));
  out.push(check('system', 'node version', 'info', process.version));

  try {
    const cfg = loadConfig();
    out.push(
      check(
        'system',
        'container.json loaded',
        cfg.agentGroupId ? 'pass' : 'warn',
        `provider=${cfg.provider} model=${cfg.model ?? '(default)'} group="${cfg.groupName}" id=${cfg.agentGroupId || '(empty)'}`,
      ),
    );
  } catch (e) {
    out.push(check('system', 'container.json loaded', 'fail', e instanceof Error ? e.message : String(e)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category: db
// ---------------------------------------------------------------------------

function tableNames(db: Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
}

function checkDbs(): Check[] {
  const out: Check[] = [];

  // inbound.db
  if (!fs.existsSync(INBOUND_DB_PATH)) {
    out.push(check('db', 'inbound.db exists', 'fail', `Missing at ${INBOUND_DB_PATH}`));
  } else {
    try {
      const db = new Database(INBOUND_DB_PATH, { readonly: true });
      try {
        const tables = new Set(tableNames(db));
        const required = ['messages_in', 'destinations', 'delivered'];
        const missing = required.filter((t) => !tables.has(t));
        if (missing.length) {
          out.push(check('db', 'inbound.db schema', 'fail', `Missing tables: ${missing.join(', ')}`));
        } else {
          out.push(check('db', 'inbound.db schema', 'pass', `${tables.size} tables, required present`));
        }
        const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        out.push(
          check('db', 'inbound.db integrity', integrity === 'ok' ? 'pass' : 'fail', integrity),
        );
        const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
        out.push(
          check(
            'db',
            'inbound.db journal_mode',
            journal.toLowerCase() === 'delete' ? 'pass' : 'warn',
            `${journal} (must be DELETE for cross-mount visibility)`,
          ),
        );
        const pendCount = (db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE status='pending'").get() as { c: number }).c;
        out.push(check('db', 'inbound pending messages', 'info', `${pendCount} pending`));
      } finally {
        db.close();
      }
    } catch (e) {
      out.push(check('db', 'inbound.db open', 'fail', e instanceof Error ? e.message : String(e)));
    }
  }

  // outbound.db
  if (!fs.existsSync(OUTBOUND_DB_PATH)) {
    out.push(check('db', 'outbound.db exists', 'fail', `Missing at ${OUTBOUND_DB_PATH}`));
  } else {
    try {
      const db = new Database(OUTBOUND_DB_PATH, { readonly: true });
      try {
        const tables = new Set(tableNames(db));
        const required = ['messages_out', 'processing_ack'];
        const missing = required.filter((t) => !tables.has(t));
        if (missing.length) {
          out.push(check('db', 'outbound.db schema', 'fail', `Missing tables: ${missing.join(', ')}`));
        } else {
          out.push(check('db', 'outbound.db schema', 'pass', `${tables.size} tables, required present`));
        }
        const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        out.push(
          check('db', 'outbound.db integrity', integrity === 'ok' ? 'pass' : 'fail', integrity),
        );
        const outCount = (db.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
        out.push(check('db', 'outbound messages total', 'info', `${outCount} rows`));
      } finally {
        db.close();
      }
    } catch (e) {
      out.push(check('db', 'outbound.db open', 'fail', e instanceof Error ? e.message : String(e)));
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Category: filesystem
// ---------------------------------------------------------------------------

function probeWritable(dir: string): { ok: boolean; reason?: string } {
  try {
    if (!fs.existsSync(dir)) return { ok: false, reason: 'missing' };
    const probe = path.join(dir, `.healthcheck-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function checkFilesystem(): Check[] {
  const out: Check[] = [];

  const agentProbe = probeWritable(AGENT_DIR);
  out.push(
    check('filesystem', '/workspace/agent writable', agentProbe.ok ? 'pass' : 'fail', agentProbe.ok ? AGENT_DIR : `${AGENT_DIR}: ${agentProbe.reason}`),
  );

  const outboxProbe = probeWritable(OUTBOX_DIR);
  out.push(
    check('filesystem', '/workspace/outbox writable', outboxProbe.ok ? 'pass' : 'fail', outboxProbe.ok ? OUTBOX_DIR : `${OUTBOX_DIR}: ${outboxProbe.reason}`),
  );

  // heartbeat — should already exist or be touchable
  try {
    const now = new Date();
    fs.utimesSync(HEARTBEAT_PATH, now, now);
    const stat = fs.statSync(HEARTBEAT_PATH);
    out.push(check('filesystem', 'heartbeat file', 'pass', `${HEARTBEAT_PATH} mtime=${stat.mtime.toISOString()}`));
  } catch (e) {
    out.push(check('filesystem', 'heartbeat file', 'warn', e instanceof Error ? e.message : String(e)));
  }

  // container.json
  if (fs.existsSync(CONTAINER_JSON)) {
    try {
      JSON.parse(fs.readFileSync(CONTAINER_JSON, 'utf8'));
      out.push(check('filesystem', 'container.json readable', 'pass', CONTAINER_JSON));
    } catch (e) {
      out.push(check('filesystem', 'container.json readable', 'fail', `parse error: ${e instanceof Error ? e.message : String(e)}`));
    }
  } else {
    out.push(check('filesystem', 'container.json readable', 'fail', `Missing at ${CONTAINER_JSON}`));
  }

  // workspace inventory (informational)
  const conversationsDir = path.join(AGENT_DIR, 'conversations');
  if (fs.existsSync(conversationsDir)) {
    const count = fs.readdirSync(conversationsDir).length;
    out.push(check('filesystem', 'conversations folder', 'info', `${count} entries`));
  }
  const claudeLocal = path.join(AGENT_DIR, 'CLAUDE.local.md');
  out.push(check('filesystem', 'CLAUDE.local.md present', fs.existsSync(claudeLocal) ? 'pass' : 'info', claudeLocal));

  return out;
}

// ---------------------------------------------------------------------------
// Category: destinations
// ---------------------------------------------------------------------------

function checkDestinations(): Check[] {
  const out: Check[] = [];
  try {
    const dests = getAllDestinations();
    if (dests.length === 0) {
      out.push(check('destinations', 'configured destinations', 'warn', 'None — agent cannot send messages'));
    } else {
      out.push(
        check(
          'destinations',
          'configured destinations',
          'pass',
          `${dests.length} → ${dests.map((d) => `${d.name}[${d.type}]`).join(', ')}`,
        ),
      );
    }
  } catch (e) {
    out.push(check('destinations', 'destinations read', 'fail', e instanceof Error ? e.message : String(e)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category: mcp
// ---------------------------------------------------------------------------

function checkMcp(): Check[] {
  const out: Check[] = [];
  // If this handler is running, the built-in MCP server is up by definition.
  out.push(check('mcp', 'built-in MCP server', 'pass', 'this tool is responding'));

  try {
    const cfg = loadConfig();
    const servers = cfg.mcpServers || {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      out.push(check('mcp', 'external MCP servers', 'info', 'None configured'));
    } else {
      for (const name of names) {
        const s = servers[name];
        out.push(check('mcp', `mcp:${name}`, 'info', `${s.command} ${(s.args || []).join(' ')}`.trim()));
      }
    }
  } catch (e) {
    out.push(check('mcp', 'external MCP servers', 'fail', e instanceof Error ? e.message : String(e)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category: onecli
// ---------------------------------------------------------------------------

function parseProxyHost(url: string): { host: string; port: number } | null {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

async function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      finish(true, `connected ${host}:${port}`);
    });
    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      finish(false, err.message);
    });
  });
}

async function checkOneCli(): Promise<Check[]> {
  const out: Check[] = [];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) {
    out.push(
      check(
        'onecli',
        'HTTPS_PROXY env var',
        'warn',
        'Not set — credentialed API calls would bypass the OneCLI gateway',
      ),
    );
    return out;
  }
  out.push(check('onecli', 'HTTPS_PROXY env var', 'pass', proxy));

  const parsed = parseProxyHost(proxy);
  if (!parsed) {
    out.push(check('onecli', 'gateway reachability', 'fail', `Cannot parse HTTPS_PROXY: ${proxy}`));
    return out;
  }
  const probe = await tcpProbe(parsed.host, parsed.port);
  out.push(check('onecli', 'gateway reachability', probe.ok ? 'pass' : 'fail', probe.detail));

  const caBundle = process.env.NODE_EXTRA_CA_CERTS;
  if (caBundle) {
    out.push(
      check('onecli', 'CA bundle', fs.existsSync(caBundle) ? 'pass' : 'fail', `NODE_EXTRA_CA_CERTS=${caBundle}`),
    );
  } else {
    out.push(check('onecli', 'CA bundle', 'info', 'NODE_EXTRA_CA_CERTS not set'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Category: cli (ncl)
// ---------------------------------------------------------------------------

async function checkNcl(): Promise<Check[]> {
  const out: Check[] = [];
  try {
    const proc = Bun.spawn(['ncl', 'help'], { stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 5000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (exitCode === 0) {
      out.push(check('cli', 'ncl help', 'pass', 'exit 0'));
    } else {
      const stderr = await new Response(proc.stderr).text();
      out.push(check('cli', 'ncl help', 'fail', `exit ${exitCode}: ${stderr.slice(0, 200)}`));
    }
  } catch (e) {
    out.push(check('cli', 'ncl help', 'fail', e instanceof Error ? e.message : String(e)));
  }

  // Round-trip via DB transport — `ncl groups list` exercises the host dispatcher.
  try {
    const proc = Bun.spawn(['ncl', 'groups', 'list'], { stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 8000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);
    if (exitCode === 0) {
      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.trim().split('\n').filter(Boolean).length;
      out.push(check('cli', 'ncl groups list (host round-trip)', 'pass', `${lines} line(s) returned`));
    } else {
      const stderr = await new Response(proc.stderr).text();
      out.push(check('cli', 'ncl groups list (host round-trip)', 'warn', `exit ${exitCode}: ${stderr.slice(0, 200)}`));
    }
  } catch (e) {
    out.push(check('cli', 'ncl groups list (host round-trip)', 'fail', e instanceof Error ? e.message : String(e)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function symbolFor(s: Status): string {
  return s === 'pass' ? '✓' : s === 'fail' ? '✗' : s === 'warn' ? '!' : '·';
}

function render(results: Check[], verbose: boolean): string {
  const lines: string[] = [];
  const byCat = new Map<string, Check[]>();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }

  for (const [cat, items] of byCat) {
    lines.push(`\n## ${cat}`);
    for (const r of items) {
      if (!verbose && r.status === 'info') continue;
      lines.push(`  ${symbolFor(r.status)} [${r.status}] ${r.name} — ${r.detail}`);
    }
  }

  const totals = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const r of results) totals[r.status]++;
  const headline =
    totals.fail > 0
      ? `UNHEALTHY — ${totals.fail} failure(s), ${totals.warn} warning(s)`
      : totals.warn > 0
        ? `OK with warnings — ${totals.warn} warning(s)`
        : `HEALTHY — ${totals.pass} check(s) passed`;
  lines.unshift(`# Health check: ${headline}`);
  lines.push(
    `\nSummary: ${totals.pass} pass, ${totals.warn} warn, ${totals.fail} fail, ${totals.info} info` +
      (verbose ? '' : ' (info hidden — pass verbose=true to see all)'),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const selfHealthCheck: McpToolDefinition = {
  tool: {
    name: 'self_health_check',
    description:
      'Run a full diagnostic on this agent: session DBs, workspace mounts, destinations, MCP servers, OneCLI gateway, and ncl CLI round-trip. Read-only — makes no external API calls. Use it after an upgrade, when something feels broken, or when the user asks "are you healthy?".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string', enum: [...ALL_CATEGORIES] },
          description: `Optional subset to run. Default: all. Available: ${ALL_CATEGORIES.join(', ')}`,
        },
        verbose: {
          type: 'boolean',
          description: 'Include informational rows (versions, counts, paths). Default false.',
        },
      },
    },
  },
  async handler(args) {
    const verbose = args.verbose === true;
    const requested = Array.isArray(args.categories) && args.categories.length > 0
      ? (args.categories as string[]).filter((c): c is Category => (ALL_CATEGORIES as readonly string[]).includes(c))
      : [...ALL_CATEGORIES];

    // Fire-and-forget startup notification — the report arrives later as the
    // tool result. Sent via the session's current routing so it lands in the
    // same thread. Best-effort: silently skipped if routing isn't available
    // (e.g. agent-shared sessions with no bound thread).
    try {
      const session = getSessionRouting();
      if (session.channel_type && session.platform_id) {
        writeMessageOut({
          id: `msg-hc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          in_reply_to: getCurrentInReplyTo(),
          kind: 'chat',
          platform_id: session.platform_id,
          channel_type: session.channel_type,
          thread_id: session.thread_id,
          content: JSON.stringify({ text: STARTUP_TEMPLATE }),
        });
      }
    } catch {
      // intentional swallow — startup notice is non-critical
    }

    const results: Check[] = [];
    for (const cat of requested) {
      try {
        if (cat === 'system') results.push(...checkSystem());
        else if (cat === 'db') results.push(...checkDbs());
        else if (cat === 'filesystem') results.push(...checkFilesystem());
        else if (cat === 'destinations') results.push(...checkDestinations());
        else if (cat === 'mcp') results.push(...checkMcp());
        else if (cat === 'onecli') results.push(...(await checkOneCli()));
        else if (cat === 'cli') results.push(...(await checkNcl()));
      } catch (e) {
        results.push(check(cat as Category, `${cat} (uncaught)`, 'fail', e instanceof Error ? e.message : String(e)));
      }
    }

    return { content: [{ type: 'text' as const, text: render(results, verbose) }] };
  },
};

registerTools([selfHealthCheck]);
