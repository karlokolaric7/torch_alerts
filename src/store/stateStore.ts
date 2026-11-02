/**
 * JSON-file backed state used for deduplication, resume-after-restart, and
 * tracking launched Torch tokens for the ~10x "Launch Complete" / Graduated milestone.
 *
 * Persists:
 *  - lastBlock:     the last fully processed block
 *  - seen:          every token address already processed/posted (normalized lowercase)
 *  - seenTxs:       every launch transaction hash already processed/posted
 *  - trackedTokens: launched Torch tokens with their poolId, initial market cap,
 *                   latest price/MCap, and graduation status
 *
 * Writes are atomic (write temp file, then rename) so a crash mid-write
 * can't corrupt the state.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import type { TokenLaunch, TrackedToken } from '../types';

interface PersistedState {
  version: 1;
  lastBlock: number | null;
  seen: string[];
  seenTxs?: string[];
  trackedTokens?: TrackedToken[];
}

const MAX_PERSISTED_ITEMS = 25_000;
const MAX_TRACKED_TOKENS = 1_000;

export class StateStore {
  private readonly inFlight = new Set<string>();
  private readonly trackedByPool = new Map<string, TrackedToken>();
  private readonly trackedByAddress = new Map<string, TrackedToken>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveSeq = 0;

  private constructor(
    private readonly filePath: string,
    private _lastBlock: number | null,
    private readonly seen: Set<string>,
    private readonly seenTxs: Set<string>,
    trackedTokens: TrackedToken[] = [],
  ) {
    for (const t of trackedTokens) {
      if (t && t.poolId && t.address) {
        const normalized: TrackedToken = {
          ...t,
          poolId: t.poolId.toLowerCase(),
          notifiedUserIds: Array.isArray(t.notifiedUserIds) ? t.notifiedUserIds : [],
        };
        this.trackedByPool.set(normalized.poolId, normalized);
        this.trackedByAddress.set(normalized.address.toLowerCase(), normalized);
      }
    }
  }

  /** Loads state from disk, or starts empty if the file doesn't exist yet. */
  static async load(filePath: string): Promise<StateStore> {
    const resolved = path.resolve(filePath);
    try {
      const raw = await fs.readFile(resolved, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const seen = new Set((parsed.seen ?? []).map((a) => a.toLowerCase()));
      const seenTxs = new Set((parsed.seenTxs ?? []).map((t) => t.toLowerCase()));
      const tracked = Array.isArray(parsed.trackedTokens) ? parsed.trackedTokens : [];
      const lastBlock = typeof parsed.lastBlock === 'number' ? parsed.lastBlock : null;
      logger.info(
        `Loaded state: ${seen.size} seen tokens, ${seenTxs.size} seen txs, ${tracked.length} tracked for graduation, lastBlock=${lastBlock ?? 'none'}`,
      );
      return new StateStore(resolved, lastBlock, seen, seenTxs, tracked);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info(`No state file at ${resolved}, starting fresh`);
        return new StateStore(resolved, null, new Set(), new Set(), []);
      }
      // A corrupt state file is dangerous (could cause duplicate posts), so stop.
      throw new Error(`Failed to read state file ${resolved}: ${(err as Error).message}`);
    }
  }

  get lastBlock(): number | null {
    return this._lastBlock;
  }

  setLastBlock(block: number): void {
    this._lastBlock = block;
  }

  /** True if the token address (or optional txHash) was already seen or is currently in-flight. */
  hasSeen(address: string, txHash?: string): boolean {
    const addrKey = address.toLowerCase();
    if (this.seen.has(addrKey) || this.inFlight.has(addrKey)) return true;
    if (txHash && this.seenTxs.has(txHash.toLowerCase())) return true;
    return false;
  }

  /** Marks an address as currently being processed so duplicate logs in the same batch are skipped. */
  acquireInFlight(address: string): boolean {
    const key = address.toLowerCase();
    if (this.seen.has(key) || this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    return true;
  }

  releaseInFlight(address: string): void {
    this.inFlight.delete(address.toLowerCase());
  }

  markSeen(address: string, txHash?: string): void {
    const key = address.toLowerCase();
    this.inFlight.delete(key);
    this.seen.add(key);
    if (txHash) this.seenTxs.add(txHash.toLowerCase());
  }

  get seenCount(): number {
    return this.seen.size;
  }

  get trackedTokenCount(): number {
    return this.trackedByPool.size;
  }

  get graduatedTokenCount(): number {
    let count = 0;
    for (const t of this.trackedByPool.values()) {
      if (t.graduated) count++;
    }
    return count;
  }

  /**
   * Registers a newly launched Torch token so its pool swaps can be monitored
   * for the ~10x "Launch Complete" / Graduated milestone.
   */
  trackLaunch(launch: TokenLaunch): TrackedToken | null {
    if (!launch.poolId) return null;
    const poolKey = launch.poolId.toLowerCase();
    const addrKey = launch.address.toLowerCase();

    const existing = this.trackedByPool.get(poolKey) ?? this.trackedByAddress.get(addrKey);
    if (existing) {
      return existing;
    }

    const totalSupply =
      launch.totalSupply && launch.totalSupply > 0 ? launch.totalSupply : 1_000_000_000;
    const initialMcapQuote =
      launch.marketCapQuote && launch.marketCapQuote > 0 ? launch.marketCapQuote : 1.0;
    const initialPriceQuote = initialMcapQuote / totalSupply;

    const tracked: TrackedToken = {
      address: launch.address,
      poolId: poolKey,
      name: launch.name,
      symbol: launch.symbol,
      decimals: launch.decimals ?? 18,
      totalSupply,
      quoteToken: launch.quoteToken,
      quoteSymbol: launch.quoteSymbol ?? 'ETH',
      quoteDecimals: launch.quoteDecimals ?? 18,
      quoteIsCurrency0: launch.quoteIsCurrency0 ?? true,
      initialMarketCapQuote: initialMcapQuote,
      initialMarketCapUsd: launch.marketCapUsd ?? null,
      currentMarketCapQuote: initialMcapQuote,
      currentPriceQuote: initialPriceQuote,
      peakMultiple: 1.0,
      buyTaxPct: launch.buyTaxPct,
      sellTaxPct: launch.sellTaxPct,
      launchedAt: launch.timestamp,
      launchBlock: launch.blockNumber,
      launchTxHash: launch.txHash,
      graduated: false,
      notifiedUserIds: [],
    };

    if (this.trackedByPool.size >= MAX_TRACKED_TOKENS) {
      const oldestKey = this.trackedByPool.keys().next().value;
      if (oldestKey) {
        const old = this.trackedByPool.get(oldestKey);
        this.trackedByPool.delete(oldestKey);
        if (old) this.trackedByAddress.delete(old.address.toLowerCase());
      }
    }

    this.trackedByPool.set(poolKey, tracked);
    this.trackedByAddress.set(addrKey, tracked);
    return tracked;
  }

  getTrackedByPoolId(poolId: string): TrackedToken | undefined {
    return this.trackedByPool.get(poolId.toLowerCase());
  }

  getTrackedByAddress(address: string): TrackedToken | undefined {
    return this.trackedByAddress.get(address.toLowerCase());
  }

  getAllTrackedTokens(): TrackedToken[] {
    return [...this.trackedByPool.values()];
  }

  /**
   * Updates the latest price & market cap for a tracked token and returns the
   * updated record along with its current multiple (`currentMarketCapQuote / initialMarketCapQuote`).
   */
  updateTokenPrice(
    poolId: string,
    currentPriceQuote: number,
    currentMarketCapQuote: number,
  ): { token: TrackedToken; multiple: number } | null {
    const token = this.trackedByPool.get(poolId.toLowerCase());
    if (!token) return null;

    token.currentPriceQuote = currentPriceQuote;
    token.currentMarketCapQuote = currentMarketCapQuote;
    const baseMcap = token.initialMarketCapQuote > 0 ? token.initialMarketCapQuote : 1.0;
    const multiple = currentMarketCapQuote / baseMcap;
    if (multiple > token.peakMultiple) {
      token.peakMultiple = multiple;
    }
    return { token, multiple };
  }

  markGraduated(
    poolId: string,
    multiple: number,
    graduatedAt: number,
    txHash: string,
    notifiedUserIds: number[] = [],
  ): void {
    const token = this.trackedByPool.get(poolId.toLowerCase());
    if (!token) return;
    if (!token.graduated) {
      token.graduated = true;
      token.graduatedMultiple = multiple;
      token.graduatedAt = graduatedAt;
      token.graduatedTxHash = txHash;
    }
    if (notifiedUserIds.length > 0) {
      const merged = new Set([...token.notifiedUserIds, ...notifiedUserIds]);
      token.notifiedUserIds = [...merged];
    }
  }

  addGraduatedNotifiedUsers(poolId: string, userIds: number[]): void {
    const token = this.trackedByPool.get(poolId.toLowerCase());
    if (!token || userIds.length === 0) return;
    const merged = new Set([...token.notifiedUserIds, ...userIds]);
    token.notifiedUserIds = [...merged];
  }

  async save(): Promise<void> {
    const next = this.saveChain.then(() => this.writeToDisk());
    this.saveChain = next.catch(() => undefined);
    return next;
  }

  private async writeToDisk(): Promise<void> {
    const seenArr = [...this.seen];
    const seenTxsArr = [...this.seenTxs];
    const trackedArr = [...this.trackedByPool.values()].slice(-MAX_TRACKED_TOKENS);
    const state: PersistedState = {
      version: 1,
      lastBlock: this._lastBlock,
      seen: seenArr.slice(-MAX_PERSISTED_ITEMS),
      seenTxs: seenTxsArr.slice(-MAX_PERSISTED_ITEMS),
      trackedTokens: trackedArr,
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${++this.saveSeq}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
