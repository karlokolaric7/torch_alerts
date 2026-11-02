/**
 * Minimal leveled logger with ISO timestamps.
 * Kept dependency-free on purpose; swap for pino/winston later if needed.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVELS ? (raw as Level) : 'info';
}

const threshold = LEVELS[resolveLevel()];

function write(level: Level, msg: string, extra: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line, ...extra);
}

export const logger = {
  debug: (msg: string, ...extra: unknown[]) => write('debug', msg, extra),
  info: (msg: string, ...extra: unknown[]) => write('info', msg, extra),
  warn: (msg: string, ...extra: unknown[]) => write('warn', msg, extra),
  error: (msg: string, ...extra: unknown[]) => write('error', msg, extra),
};

/** Extracts a readable message from anything that was thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // ethers errors carry a useful `shortMessage`.
    const short = (err as { shortMessage?: string }).shortMessage;
    return short ?? err.message;
  }
  return String(err);
}

