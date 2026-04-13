/**
 * Model routing for NanoClaw agents.
 *
 * Selects the most cost-effective Claude model for each request:
 * - Haiku  : scheduled tasks, heartbeats, short/simple messages
 * - Sonnet : default for interactive requests (coding, analysis, conversation)
 * - Opus   : explicitly requested or detected very high complexity
 *
 * Fixed rule: scheduled tasks (isScheduledTask=true) always use Haiku.
 * This reduces token consumption for background automation significantly.
 */

export const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
} as const;

export type ModelTier = keyof typeof MODELS;

// Keywords that suggest Opus-level complexity
const OPUS_PATTERNS =
  /\b(architett|archit[ae]ct|refactor completo|full refactor|from scratch|da zero|riprogett|riprogett|redesign|design system|migrazi[oi]ne complessa|complex migration)\b/i;

// Keywords that suggest active coding/analysis — keep on Sonnet at minimum
const SONNET_FLOOR_PATTERNS =
  /\b(crea|scrivi|analizza|debug|implementa|progetta|review|create|write|analyze|implement|design|fix|bug|error|codice|code|refactor|test|deploy|database|api|server|script|function|class|module)\b/i;

/**
 * Select the appropriate Claude model for a given request.
 *
 * @param opts.isScheduledTask - true for cron/heartbeat tasks → always Haiku
 * @param opts.prompt - the user message or task prompt
 */
export function selectModel(opts: {
  isScheduledTask?: boolean;
  prompt: string;
}): string {
  // ── Fixed rule ──────────────────────────────────────────────────────────────
  // Scheduled tasks and heartbeats always use Haiku regardless of content.
  if (opts.isScheduledTask) return MODELS.haiku;

  const prompt = opts.prompt.trim();

  // ── Explicit override ────────────────────────────────────────────────────────
  // User can request a specific model by mentioning it in the message.
  if (/\b(usa|use|with)\s+opus\b/i.test(prompt)) return MODELS.opus;
  if (/\b(usa|use|with)\s+haiku\b/i.test(prompt)) return MODELS.haiku;
  if (/\b(usa|use|with)\s+sonnet\b/i.test(prompt)) return MODELS.sonnet;

  // ── Complexity routing ───────────────────────────────────────────────────────
  // High complexity → Opus
  if (OPUS_PATTERNS.test(prompt)) return MODELS.opus;

  // Short + no active-task keywords → Haiku (simple Q&A, status checks, greetings)
  if (prompt.length < 120 && !SONNET_FLOOR_PATTERNS.test(prompt)) {
    return MODELS.haiku;
  }

  // Default: Sonnet handles most interactive requests well
  return MODELS.sonnet;
}
