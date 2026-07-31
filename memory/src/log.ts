import { LOG_LEVEL } from './config.js';

/** Home Assistant's log levels, quietest first. */
const LEVELS = ['fatal', 'error', 'warning', 'notice', 'info', 'debug', 'trace'] as const;
type Level = (typeof LEVELS)[number];

const DEFAULT_LEVEL: Level = 'info';

function thresholdFor(name: string): number {
  const index = LEVELS.indexOf(name.toLowerCase() as Level);
  return index === -1 ? LEVELS.indexOf(DEFAULT_LEVEL) : index;
}

const threshold = thresholdFor(LOG_LEVEL);

function enabled(level: Level): boolean {
  return threshold >= LEVELS.indexOf(level);
}

/**
 * Tool-call logging. Never logs raw fact content (SPEC §8 Always) — only
 * lengths/counts, so logs stay useful for debugging without leaking memory.
 */
export function logToolCall(
  tool: string,
  detail: Record<string, string | number | boolean | undefined>,
): void {
  if (!enabled('info')) {
    return;
  }

  const parts = Object.entries(detail)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[tool] ${tool} ${parts.join(' ')}`);
}

export function logError(tool: string, error: unknown): void {
  if (!enabled('error')) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[tool] ${tool} error: ${message}`);
}
