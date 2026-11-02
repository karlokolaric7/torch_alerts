/**
 * Stores per-user Telegram alert subscriptions and filter preferences.
 *
 * Kept in an in-memory Map<number, UserFilterPrefs> for instant lookup on each
 * launch, and persisted atomically to a JSON file (`./data/users.json`) so user
 * settings survive bot restarts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import type { TokenGraduation, TokenLaunch, UserFilterPrefs } from '../types';

interface PersistedUsers {
  version: 1;
  users: UserFilterPrefs[];
}

export const DEFAULT_GRADUATION_MULTIPLIER = 10;

export function createDefaultUserPrefs(chatId: number, username?: string): UserFilterPrefs {
  return {
    chatId,
    username,
    subscribed: true,
    minMarketCapEth: 0,
    maxBuyTaxPct: 100,
    requireAntiSnipe: false,
    minInitialBuyEth: 0,
    graduatedAlerts: true,
    minGraduatedMultiplier: DEFAULT_GRADUATION_MULTIPLIER,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Evaluates whether a `TokenLaunch` passes a specific user's personal filters.
 * Returns `null` if the user should receive the alert, or a short reason string
 * explaining why the launch was filtered out for this user.
 */
export function evaluateUserFilters(
  launch: TokenLaunch,
  prefs: UserFilterPrefs,
): string | null {
  if (!prefs.subscribed) {
    return 'user unsubscribed';
  }

  if (prefs.minMarketCapEth > 0) {
    if (launch.marketCapQuote === null || launch.marketCapQuote < prefs.minMarketCapEth) {
      return `mcap ${launch.marketCapQuote?.toFixed(2) ?? 'unknown'} ${launch.quoteSymbol} < min ${prefs.minMarketCapEth} ETH`;
    }
  }

  if (prefs.maxBuyTaxPct < 100 && launch.buyTaxPct !== null) {
    if (launch.buyTaxPct > prefs.maxBuyTaxPct) {
      return `buy tax ${launch.buyTaxPct}% > max ${prefs.maxBuyTaxPct}%`;
    }
  }

  if (prefs.requireAntiSnipe) {
    if (!launch.snipeDurationSec || launch.snipeDurationSec <= 0) {
      return 'anti-snipe is disabled on this token (requireAntiSnipe=on)';
    }
  }

  if (prefs.minInitialBuyEth > 0) {
    if (launch.initialBuyQuote === null || launch.initialBuyQuote < prefs.minInitialBuyEth) {
      return `dev buy ${launch.initialBuyQuote ?? 0} ${launch.quoteSymbol} < min ${prefs.minInitialBuyEth} ETH`;
    }
  }

  return null;
}

/**
 * Evaluates whether a `TokenGraduation` ("Launch Complete" ~10x milestone) passes
 * a specific user's personal graduation filter settings.
 * Returns `null` if the user should receive the graduated alert, or a short reason string.
 */
export function evaluateGraduatedUserFilters(
  graduation: Pick<TokenGraduation, 'multiple'>,
  prefs: UserFilterPrefs,
): string | null {
  if (!prefs.subscribed) {
    return 'user unsubscribed';
  }
  if (!prefs.graduatedAlerts) {
    return 'graduated alerts disabled (/graduated off)';
  }
  const minX = prefs.minGraduatedMultiplier > 0 ? prefs.minGraduatedMultiplier : DEFAULT_GRADUATION_MULTIPLIER;
  if (graduation.multiple < minX) {
    return `multiple ${graduation.multiple.toFixed(1)}x < min ${minX}x`;
  }
  return null;
}

/** Formats a user's filter preferences into a human-readable summary. */
export function describeUserFilters(prefs: UserFilterPrefs): string {
  const parts: string[] = [];
  if (prefs.minMarketCapEth > 0) parts.push(`Min MCap >= ${prefs.minMarketCapEth} ETH`);
  if (prefs.maxBuyTaxPct < 100) parts.push(`Max Buy Tax <= ${prefs.maxBuyTaxPct}%`);
  if (prefs.requireAntiSnipe) parts.push('Anti-Snipe Required');
  if (prefs.minInitialBuyEth > 0) parts.push(`Min Dev Buy >= ${prefs.minInitialBuyEth} ETH`);
  if (!prefs.graduatedAlerts) {
    parts.push('Graduated Alerts: Off');
  } else if (
    prefs.minGraduatedMultiplier &&
    prefs.minGraduatedMultiplier !== DEFAULT_GRADUATION_MULTIPLIER
  ) {
    parts.push(`Graduated >= ${prefs.minGraduatedMultiplier}x`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Default (receiving all launches & >=10x graduations)';
}

export class UserFilterStore {
  private constructor(
    private readonly filePath: string,
    private readonly users: Map<number, UserFilterPrefs>,
  ) {}

  static async load(filePath: string): Promise<UserFilterStore> {
    const resolved = path.resolve(filePath);
    try {
      const raw = await fs.readFile(resolved, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedUsers>;
      const map = new Map<number, UserFilterPrefs>();
      for (const u of parsed.users ?? []) {
        if (typeof u.chatId === 'number') {
          map.set(u.chatId, {
            ...createDefaultUserPrefs(u.chatId, u.username),
            ...u,
          });
        }
      }
      logger.info(
        `Loaded user filter store: ${map.size} user(s) (${[...map.values()].filter((u) => u.subscribed).length} subscribed)`,
      );
      return new UserFilterStore(resolved, map);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info(`No user filter file at ${resolved}, starting with empty user store`);
        return new UserFilterStore(resolved, new Map());
      }
      logger.warn(`Failed to parse user filter file ${resolved}, starting empty: ${(err as Error).message}`);
      return new UserFilterStore(resolved, new Map());
    }
  }

  get(chatId: number): UserFilterPrefs | undefined {
    return this.users.get(chatId);
  }

  /** Gets existing preferences for `chatId` or creates & saves default subscribed prefs. */
  async getOrCreate(chatId: number, username?: string): Promise<UserFilterPrefs> {
    const existing = this.users.get(chatId);
    if (existing) {
      if (username && existing.username !== username) {
        existing.username = username;
        await this.save();
      }
      return existing;
    }
    const created = createDefaultUserPrefs(chatId, username);
    this.users.set(chatId, created);
    await this.save();
    logger.info(`[USER-NEW] Registered subscriber chatId=${chatId} (${username ?? 'anonymous'})`);
    return created;
  }

  /** Updates specific filter fields for `chatId` (auto-subscribing the user unless `subscribed` is explicitly passed). */
  async update(
    chatId: number,
    patch: Partial<Omit<UserFilterPrefs, 'chatId' | 'updatedAt'>>,
    username?: string,
  ): Promise<UserFilterPrefs> {
    const base = this.users.get(chatId) ?? createDefaultUserPrefs(chatId, username);
    const updated: UserFilterPrefs = {
      ...base,
      ...(username ? { username } : {}),
      subscribed: true,
      ...patch,
      chatId,
      updatedAt: new Date().toISOString(),
    };
    this.users.set(chatId, updated);
    await this.save();
    return updated;
  }

  /** Resets a user's filters back to defaults (receive all launches). */
  async reset(chatId: number, username?: string): Promise<UserFilterPrefs> {
    const fresh = createDefaultUserPrefs(chatId, username ?? this.users.get(chatId)?.username);
    this.users.set(chatId, fresh);
    await this.save();
    return fresh;
  }

  getSubscribedUsers(): UserFilterPrefs[] {
    return [...this.users.values()].filter((u) => u.subscribed);
  }

  get subscriberCount(): number {
    return this.getSubscribedUsers().length;
  }

  async save(): Promise<void> {
    const data: PersistedUsers = {
      version: 1,
      users: [...this.users.values()],
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

