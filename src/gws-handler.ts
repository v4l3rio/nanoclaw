/**
 * Google Workspace Handler: processes GWS write requests from the container agent.
 * Sends Telegram approval, then executes the Google API call via `gws` CLI on the host.
 * Credentials are managed by gws (encrypted in OS keyring) — never enter the container.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// --- Types ---

type GwsOperation =
  | 'send_email'
  | 'create_event'
  | 'create_document'
  | 'update_sheet';

interface PendingGwsRequest {
  requestId: string;
  operation: GwsOperation;
  params: Record<string, unknown>;
  chatJid: string;
  groupFolder: string;
  timestamp: string;
}

// --- State ---

const pendingRequests = new Map<string, PendingGwsRequest>();
const IPC_BASE = path.join(DATA_DIR, 'ipc');
const AUDIT_LOG = path.join(DATA_DIR, 'gws-audit.jsonl');
const GWS_BIN = process.env.GWS_BIN || '/opt/homebrew/bin/gws';

// Always CC/share/invite this address on every GWS operation
const OWNER_EMAIL = process.env.GWS_OWNER_EMAIL || 'diziovale@gmail.com';

// --- Audit ---

function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    fs.appendFileSync(
      AUDIT_LOG,
      JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n',
    );
  } catch {
    // best-effort
  }
}

// --- Public API ---

export function getPendingGwsRequest(
  requestId: string,
): PendingGwsRequest | undefined {
  return pendingRequests.get(requestId);
}

export function getLatestPendingGwsRequest(): PendingGwsRequest | undefined {
  let latest: PendingGwsRequest | undefined;
  for (const req of pendingRequests.values()) {
    if (!latest || req.timestamp > latest.timestamp) latest = req;
  }
  return latest;
}

export async function handleGwsRequest(
  data: {
    requestId: string;
    operation: GwsOperation;
    params: Record<string, unknown>;
    chatJid: string;
    groupFolder: string;
    timestamp: string;
  },
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  pendingRequests.set(data.requestId, data);

  const summary = formatApprovalMessage(data.operation, data.params);
  await sendMessage(
    data.chatJid,
    `📋 *Google Workspace request*\n\n${summary}\n\nReply /approve or /deny`,
  );

  audit({
    event: 'request',
    requestId: data.requestId,
    operation: data.operation,
    params: sanitizeForAudit(data.params),
    groupFolder: data.groupFolder,
  });

  logger.info(
    { requestId: data.requestId, operation: data.operation },
    'GWS approval requested',
  );
}

export async function approveGwsRequest(
  requestId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const req = pendingRequests.get(requestId);
  if (!req) {
    logger.warn({ requestId }, 'GWS approve called for unknown request');
    return;
  }
  pendingRequests.delete(requestId);

  await sendMessage(req.chatJid, '✅ Approved. Executing Google Workspace operation...');

  const responsePath = path.join(
    IPC_BASE,
    req.groupFolder,
    'gws',
    `response-${requestId}.json`,
  );

  try {
    const result = await executeGwsOperation(req.operation, req.params);

    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ status: 'approved', result }));

    const truncated = result.length > 800 ? result.slice(0, 800) + '...' : result;
    await sendMessage(req.chatJid, `✅ Done.\n\n${truncated}`);

    audit({ event: 'approved', requestId, operation: req.operation, result: result.slice(0, 500) });
    logger.info({ requestId, operation: req.operation }, 'GWS operation completed');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, JSON.stringify({ status: 'error', error: errorMsg }));

    await sendMessage(req.chatJid, `❌ GWS operation failed: ${errorMsg}`);
    audit({ event: 'error', requestId, operation: req.operation, error: errorMsg });
    logger.error({ requestId, err }, 'GWS operation failed');
  }
}

export async function denyGwsRequest(
  requestId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const req = pendingRequests.get(requestId);
  if (!req) {
    logger.warn({ requestId }, 'GWS deny called for unknown request');
    return;
  }
  pendingRequests.delete(requestId);

  const responsePath = path.join(
    IPC_BASE,
    req.groupFolder,
    'gws',
    `response-${requestId}.json`,
  );

  fs.mkdirSync(path.dirname(responsePath), { recursive: true });
  fs.writeFileSync(responsePath, JSON.stringify({ status: 'denied' }));

  await sendMessage(req.chatJid, '🚫 GWS operation denied.');
  audit({ event: 'denied', requestId, operation: req.operation });
  logger.info({ requestId }, 'GWS operation denied');
}

// --- Approval message formatting ---

function formatApprovalMessage(
  operation: GwsOperation,
  params: Record<string, unknown>,
): string {
  switch (operation) {
    case 'send_email': {
      const body = String(params.body || '');
      return (
        `*Send Email*\n` +
        `To: ${params.to}\n` +
        (params.cc ? `Cc: ${params.cc}\n` : '') +
        `Subject: ${params.subject}\n` +
        `Body: ${body.slice(0, 200)}${body.length > 200 ? '...' : ''}`
      );
    }
    case 'create_event':
      return (
        `*Create Calendar Event*\n` +
        `Title: ${params.title}\n` +
        `When: ${params.start} — ${params.end}\n` +
        (params.attendees ? `Attendees: ${params.attendees}\n` : '') +
        (params.location ? `Location: ${params.location}\n` : '') +
        (params.description
          ? `Description: ${String(params.description).slice(0, 150)}`
          : '')
      );
    case 'create_document':
      return (
        `*Create ${params.type}*\n` +
        `Title: ${params.title}\n` +
        (params.share_with ? `Share with: ${params.share_with}` : '')
      );
    case 'update_sheet':
      return (
        `*Update Spreadsheet*\n` +
        `ID: ${params.spreadsheet_id}\n` +
        `Range: ${params.range}\n` +
        `Values: ${JSON.stringify(params.values).slice(0, 200)}`
      );
    default:
      return `*${operation}*\n${JSON.stringify(params).slice(0, 300)}`;
  }
}

function sanitizeForAudit(params: Record<string, unknown>): Record<string, unknown> {
  // Truncate large fields for audit log
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    result[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
  }
  return result;
}

// --- gws CLI execution ---

function runGws(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GWS_BIN,
      args,
      {
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

async function executeGwsOperation(
  operation: GwsOperation,
  params: Record<string, unknown>,
): Promise<string> {
  switch (operation) {
    case 'send_email':
      return sendEmail(params);
    case 'create_event':
      return createEvent(params);
    case 'create_document':
      return createDocument(params);
    case 'update_sheet':
      return updateSheet(params);
    default:
      throw new Error(`Unknown GWS operation: ${operation}`);
  }
}

async function sendEmail(params: Record<string, unknown>): Promise<string> {
  const to = String(params.to || '');
  const subject = String(params.subject || '');
  const body = String(params.body || '');

  // Always CC the owner; merge with any explicit cc param
  const existingCc = params.cc ? String(params.cc) : '';
  const ccParts = [existingCc, OWNER_EMAIL].filter(Boolean);
  const cc = [...new Set(ccParts)].join(', ');

  const headers = [
    `To: ${to}`,
    `Cc: ${cc}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ]
    .filter(Boolean)
    .join('\r\n');

  const raw = Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64url');

  const result = await runGws([
    'gmail', 'users', 'messages', 'send',
    '--params', JSON.stringify({ userId: 'me' }),
    '--json', JSON.stringify({ raw }),
  ]);

  const parsed = JSON.parse(result);
  return `Email sent (ID: ${parsed.id})`;
}

async function createEvent(params: Record<string, unknown>): Promise<string> {
  const explicitAttendees = params.attendees
    ? String(params.attendees).split(',').map((e) => e.trim())
    : [];
  // Always invite the owner
  const allAttendees = [...new Set([...explicitAttendees, OWNER_EMAIL])];
  const attendeeList = allAttendees.map((email) => ({ email }));

  const body = {
    summary: String(params.title || ''),
    description: params.description ? String(params.description) : undefined,
    location: params.location ? String(params.location) : undefined,
    start: { dateTime: String(params.start), timeZone: 'Europe/Rome' },
    end: { dateTime: String(params.end), timeZone: 'Europe/Rome' },
    attendees: attendeeList,
  };

  const result = await runGws([
    'calendar', 'events', 'insert',
    '--params', JSON.stringify({ calendarId: 'primary', sendUpdates: 'all' }),
    '--json', JSON.stringify(body),
  ]);

  const parsed = JSON.parse(result);
  return `Event created: \`${parsed.htmlLink}\``;
}

async function createDocument(params: Record<string, unknown>): Promise<string> {
  const title = String(params.title || 'Untitled');
  const type = String(params.type || 'document');

  const mimeTypes: Record<string, string> = {
    document: 'application/vnd.google-apps.document',
    sheet: 'application/vnd.google-apps.spreadsheet',
    slide: 'application/vnd.google-apps.presentation',
  };

  const result = await runGws([
    'drive', 'files', 'create',
    '--json', JSON.stringify({ name: title, mimeType: mimeTypes[type] || mimeTypes.document }),
    '--params', JSON.stringify({ fields: 'id,webViewLink' }),
  ]);

  const parsed = JSON.parse(result);

  // Always share with owner + any explicit share_with
  const explicitShare = params.share_with
    ? String(params.share_with).split(',').map((e) => e.trim())
    : [];
  const shareList = [...new Set([...explicitShare, OWNER_EMAIL])];
  for (const email of shareList) {
    await runGws([
      'drive', 'permissions', 'create',
      '--params', JSON.stringify({ fileId: parsed.id, sendNotificationEmail: 'true' }),
      '--json', JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
    ]);
  }

  // Insert content if document
  if (params.content && type === 'document') {
    await runGws([
      'docs', 'documents', 'batchUpdate',
      '--params', JSON.stringify({ documentId: parsed.id }),
      '--json', JSON.stringify({
        requests: [{ insertText: { location: { index: 1 }, text: String(params.content) } }],
      }),
    ]);
  }

  return `${type} created: \`${parsed.webViewLink}\``;
}

async function updateSheet(params: Record<string, unknown>): Promise<string> {
  const result = await runGws([
    'sheets', 'spreadsheets', 'values', 'update',
    '--params', JSON.stringify({
      spreadsheetId: String(params.spreadsheet_id),
      range: String(params.range),
      valueInputOption: 'USER_ENTERED',
    }),
    '--json', JSON.stringify({ values: params.values }),
  ]);

  const parsed = JSON.parse(result);
  return `Sheet updated: ${parsed.updatedCells} cells`;
}
