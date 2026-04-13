/**
 * Self-Modify: handles claude_code_request IPC from the container agent.
 * Sends Telegram approval, then runs Claude Code CLI on the project.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface PendingRequest {
  requestId: string;
  prompt: string;
  summary: string;
  chatJid: string;
  groupFolder: string;
  timestamp: string;
}

const pendingRequests = new Map<string, PendingRequest>();

const CLAUDE_CODE_IPC_DIR = path.join(DATA_DIR, 'ipc');

export function getPendingRequest(
  requestId: string,
): PendingRequest | undefined {
  return pendingRequests.get(requestId);
}

export function getLatestPendingRequest(): PendingRequest | undefined {
  // Return the most recent pending request (for /approve without ID)
  let latest: PendingRequest | undefined;
  for (const req of pendingRequests.values()) {
    if (!latest || req.timestamp > latest.timestamp) latest = req;
  }
  return latest;
}

/**
 * Called by the IPC watcher when a claude_code_request file is detected.
 * Stores the request and sends a Telegram approval message.
 */
export async function handleClaudeCodeRequest(
  data: {
    requestId: string;
    prompt: string;
    summary: string;
    chatJid: string;
    groupFolder: string;
    timestamp: string;
  },
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const { requestId, prompt, summary, chatJid, groupFolder } = data;

  pendingRequests.set(requestId, data);

  const approvalMsg =
    `🔧 *Self-modify request*\n\n` +
    `*Summary:* ${summary}\n\n` +
    `*Prompt:*\n\`\`\`\n${prompt.length > 500 ? prompt.slice(0, 500) + '...' : prompt}\n\`\`\`\n\n` +
    `Reply /approve or /deny`;

  await sendMessage(chatJid, approvalMsg);

  logger.info(
    { requestId, groupFolder, summary },
    'Self-modify approval requested',
  );
}

/**
 * Called when the user approves a request. Runs Claude Code and writes the response.
 */
export async function approveRequest(
  requestId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const req = pendingRequests.get(requestId);
  if (!req) {
    logger.warn({ requestId }, 'Approve called for unknown request');
    return;
  }
  pendingRequests.delete(requestId);

  await sendMessage(req.chatJid, '✅ Approved. Running Claude Code...');

  const projectRoot = process.cwd();
  const responsePath = path.join(
    CLAUDE_CODE_IPC_DIR,
    req.groupFolder,
    'claude-code',
    `response-${requestId}.json`,
  );

  try {
    const result = await runClaudeCode(req.prompt, projectRoot);

    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({ status: 'approved', result }),
    );

    const truncated =
      result.length > 1000 ? result.slice(0, 1000) + '...' : result;
    await sendMessage(
      req.chatJid,
      `✅ Modification complete.\n\n\`\`\`\n${truncated}\n\`\`\``,
    );

    logger.info({ requestId }, 'Self-modify completed');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(
      responsePath,
      JSON.stringify({ status: 'error', error: errorMsg }),
    );

    await sendMessage(req.chatJid, `❌ Modification failed: ${errorMsg}`);
    logger.error({ requestId, err }, 'Self-modify failed');
  }
}

/**
 * Called when the user denies a request.
 */
export async function denyRequest(
  requestId: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  const req = pendingRequests.get(requestId);
  if (!req) {
    logger.warn({ requestId }, 'Deny called for unknown request');
    return;
  }
  pendingRequests.delete(requestId);

  const responsePath = path.join(
    CLAUDE_CODE_IPC_DIR,
    req.groupFolder,
    'claude-code',
    `response-${requestId}.json`,
  );

  fs.mkdirSync(path.dirname(responsePath), { recursive: true });
  fs.writeFileSync(responsePath, JSON.stringify({ status: 'denied' }));

  await sendMessage(req.chatJid, '🚫 Modification denied.');
  logger.info({ requestId }, 'Self-modify denied');
}

function runClaudeCode(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', '--output-format', 'text', prompt],
      {
        cwd,
        timeout: 4 * 60 * 1000, // 4 min (leaves 1 min buffer for the agent's 5 min timeout)
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}
