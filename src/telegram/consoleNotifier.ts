/**
 * Dry-run notifier: prints alerts to the console instead of posting to Telegram.
 * Enabled with DRY_RUN=true — handy for testing detection without a bot.
 */
import { logger } from '../logger';
import type { Notifier, TokenGraduation, TokenLaunch } from '../types';
import { formatGraduatedMessage, formatLaunchMessage, type FormatOptions } from './format';

export class ConsoleNotifier implements Notifier {
  constructor(private readonly formatOptions: FormatOptions = {}) {}

  async verify(): Promise<void> {
    logger.warn('DRY_RUN enabled: alerts will be printed, not posted to Telegram');
  }

  async postLaunch(launch: TokenLaunch): Promise<void> {
    // Strip HTML tags so the console output is readable.
    const text = formatLaunchMessage(launch, this.formatOptions).replace(/<[^>]+>/g, '');
    console.log(`\n────────── [DRY RUN] Telegram message ──────────\n${text}\n────────────────────────────────────────────────\n`);
  }

  async postGraduation(graduation: TokenGraduation): Promise<number[]> {
    const text = formatGraduatedMessage(graduation, this.formatOptions).replace(/<[^>]+>/g, '');
    console.log(`\n────────── [DRY RUN] Graduated alert ───────────\n${text}\n────────────────────────────────────────────────\n`);
    return [];
  }
}

