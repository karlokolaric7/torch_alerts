/**
 * LaunchWatcher: follows the Torch factory contract and announces new tokens
 * with minimal detection-to-post latency.
 *
 * Fast-path architecture:
 *   1. Real-time WebSocket subscription (`WS_RPC_URL` / `ws(s)://`) when available,
 *      paired with single-RTT JSON-RPC batched HTTP polling (`eth_blockNumber` +
 *      `eth_getLogs(from..latest)` in one HTTP round-trip every 600ms).
 *   2. Zero redundant pre-checks (`hasCode` / `isTorchToken`) when matching the
 *      verified factory `TokenLaunched` topic0.
 *   3. Single-RTT batched on-chain enrichment (`batchStallTime: 2ms`) + 0ms
 *      in-memory cached ETH/USD spot price.
 *   4. Detailed millisecond timestamps logged at event reception, enrichment,
 *      and Telegram channel delivery.
 */
import { JsonRpcProvider, WebSocketProvider, ZeroAddress, type Log } from 'ethers';
import type { Config } from '../config';
import { logger, errorMessage } from '../logger';
import type { StateStore } from '../store/stateStore';
import type { UserFilterStore } from '../store/userFilterStore';
import type { Notifier, TokenGraduation, TokenLaunch, TrackedToken } from '../types';
import {
  SWAP_TOPIC,
  TOKEN_LAUNCHED_TOPIC,
  computePriceAndMarketCap,
  decodeSwapLog,
  extractCandidateAddresses,
} from './extract';
import {
  buildTokenLaunch,
  describeActiveFilters,
  evaluateLaunchFilters,
} from './launchDetails';
import { getCachedEthUsdPrice } from './price';
import { checkIsTorchToken, hasCode, isMissingStateError, withTimeout } from './token';

const MAX_BACKOFF_MS = 60_000;
const RPC_TIMEOUT_MS = 12_000;
/** Recreate the JsonRpcProvider after this many consecutive poll errors. */
const RECONNECT_AFTER_FAILURES = 2;
/** Bounded cache of addresses we've decided are NOT valid Torch launches. */
const MAX_REJECTED_CACHE = 10_000;

export interface WatcherStatus {
  running: boolean;
  startedAtMs: number;
  lastBlock: number | null;
  seenCount: number;
  trackedCount: number;
  graduatedCount: number;
  postedThisSession: number;
  lastLaunch: TokenLaunch | null;
  activeFiltersSummary: string;
}

export function createRpcProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchMaxCount: 25,
    batchStallTime: 2,
  });
}

export class LaunchWatcher {
  private running = false;
  private readonly startedAtMs = Date.now();
  private postedThisSession = 0;
  private lastLaunch: TokenLaunch | null = null;
  private wakeUp: (() => void) | null = null;
  private wsProvider: WebSocketProvider | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSwapBlock: number | null = null;
  private lastSwapCheckAtMs = 0;
  private readonly rejected = new Set<string>();
  private readonly blockTimeCache = new Map<number, number>();

  constructor(
    private provider: JsonRpcProvider,
    private readonly config: Config,
    private readonly store: StateStore,
    private readonly notifier: Notifier,
    private readonly userStore?: UserFilterStore,
  ) {}

  /** Returns a snapshot of watcher runtime status for Telegram `/status` command. */
  getStatus(): WatcherStatus {
    return {
      running: this.running,
      startedAtMs: this.startedAtMs,
      lastBlock: this.store.lastBlock,
      seenCount: this.store.seenCount,
      trackedCount: this.store.trackedTokenCount,
      graduatedCount: this.store.graduatedTokenCount,
      postedThisSession: this.postedThisSession,
      lastLaunch: this.lastLaunch,
      activeFiltersSummary: describeActiveFilters(this.config.filters),
    };
  }

  /**
   * Finds the most recent Torch launch on-chain (caching it in `lastLaunch`).
   * Used by the `/latest` and `/status` bot commands if no launch has occurred yet in this session.
   */
  async findLatestLaunchOnChain(lookbackBlocks = 150_000): Promise<TokenLaunch | null> {
    if (this.lastLaunch) return this.lastLaunch;
    const head = await withTimeout(this.provider.getBlockNumber(), RPC_TIMEOUT_MS, 'getBlockNumber');
    for (let to = head; to > head - lookbackBlocks && to > 0; to -= this.config.maxBlockRange) {
      const from = Math.max(0, to - this.config.maxBlockRange + 1);
      const logs = await withTimeout(
        this.provider.getLogs({
          address: this.config.factoryAddress,
          fromBlock: from,
          toBlock: to,
          topics: this.config.launchEventTopic ? [this.config.launchEventTopic] : undefined,
        }),
        RPC_TIMEOUT_MS,
        `getLogs(${from}..${to})`,
      );
      const log = logs.at(-1);
      if (!log) continue;
      const [address] = extractCandidateAddresses(log, this.config.tokenSuffix);
      if (!address) continue;
      const launch = await buildTokenLaunch(this.provider, address, log, (bn) =>
        this.getBlockTimestamp(bn),
      );
      this.lastLaunch = launch;
      return launch;
    }
    return null;
  }

  /** Runs the polling loop until stop() is called. */
  async start(): Promise<void> {
    await this.initStartBlock();
    this.lastSwapBlock = this.store.lastBlock;
    this.running = true;

    const mode = this.config.launchEventTopic
      ? `strict (topic0=${this.config.launchEventTopic})`
      : 'ABI-agnostic (any factory event)';
    logger.info(
      `Watching factory ${this.config.factoryAddress} from block ${this.store.lastBlock! + 1}, ` +
        `suffix "${this.config.tokenSuffix}", pollInterval=${this.config.pollIntervalMs}ms, mode: ${mode}`,
    );
    logger.info(`Active launch filters: ${describeActiveFilters(this.config.filters)}`);
    if (this.config.enableGraduationAlerts) {
      logger.info(
        `Graduation ("Launch Complete") tracker active: threshold=${this.config.graduationMultiplier}x, ` +
          `poolManager=${this.config.poolManagerAddress}, trackedTokens=${this.store.trackedTokenCount}`,
      );
      if (this.store.trackedTokenCount === 0) {
        void this.seedRecentTokensForGraduation().catch((err) =>
          logger.warn(`Graduation backfill seed warning: ${errorMessage(err)}`),
        );
      }
    }

    if (this.config.wsRpcUrl) {
      this.startWebSocketSubscription(this.config.wsRpcUrl);
    }

    let consecutiveFailures = 0;
    while (this.running) {
      let delay = this.config.pollIntervalMs;
      try {
        await this.poll();
        if (consecutiveFailures > 0) {
          logger.info(`RPC poll recovered after ${consecutiveFailures} failure(s)`);
        }
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        delay = Math.min(this.config.pollIntervalMs * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
        logger.error(
          `Poll failed (${consecutiveFailures} in a row): ${errorMessage(err)}. Retrying in ${delay}ms`,
        );

        if (consecutiveFailures >= RECONNECT_AFTER_FAILURES) {
          await this.reconnectProvider();
        }
      }
      await this.sleep(delay);
    }
    logger.info('Watcher stopped');
  }

  stop(): void {
    this.running = false;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.wakeUp?.();
  }

  destroyProvider(): void {
    try {
      this.provider.destroy();
    } catch {
      // Ignore cleanup errors on shutdown.
    }
    try {
      void this.wsProvider?.destroy();
      this.wsProvider = null;
    } catch {
      // Ignore WS cleanup errors on shutdown.
    }
  }

  /**
   * Starts a real-time WebSocket subscription (`eth_subscribe("logs", ...)`) when
   * `WS_RPC_URL` is configured, automatically reconnecting if the socket drops.
   */
  private startWebSocketSubscription(wsUrl: string): void {
    if (!this.running) return;
    try {
      logger.info(`Connecting WebSocket event subscription to ${wsUrl}...`);
      const ws = new WebSocketProvider(wsUrl, undefined, { staticNetwork: true });
      this.wsProvider = ws;

      const filter = {
        address: this.config.factoryAddress,
        topics: this.config.launchEventTopic ? [this.config.launchEventTopic] : undefined,
      };

      void ws
        .on(filter, (log: Log) => {
          void this.processLogs([log], 'ws').catch((err) =>
            logger.warn(`WebSocket log processing error: ${errorMessage(err)}`),
          );
        })
        .then(() => logger.info('WebSocket real-time TokenLaunched subscription active'))
        .catch((err) => {
          logger.warn(`WebSocket subscription error: ${errorMessage(err)}`);
          this.scheduleWsReconnect(wsUrl);
        });

      const rawSocket = (ws as unknown as { websocket?: { on?: (ev: string, fn: () => void) => void } }).websocket;
      rawSocket?.on?.('close', () => {
        if (!this.running) return;
        logger.warn('WebSocket connection closed; scheduling reconnect...');
        this.scheduleWsReconnect(wsUrl);
      });
      rawSocket?.on?.('error', () => {
        // Handled by close/catch
      });
    } catch (err) {
      logger.warn(`Failed to initialize WebSocket provider (${errorMessage(err)}); using fast HTTP polling`);
      this.scheduleWsReconnect(wsUrl);
    }
  }

  private scheduleWsReconnect(wsUrl: string): void {
    if (!this.running || this.wsReconnectTimer) return;
    try {
      void this.wsProvider?.destroy();
    } catch {
      // Ignore
    }
    this.wsProvider = null;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      this.startWebSocketSubscription(wsUrl);
    }, 5_000);
    this.wsReconnectTimer.unref?.();
  }

  /** Recreates the underlying JsonRpcProvider if the connection dropped or stalled. */
  private async reconnectProvider(): Promise<void> {
    logger.warn('Reconnecting to RPC endpoint...');
    try {
      this.provider.destroy();
    } catch {
      // Ignore errors destroying the old provider.
    }
    this.provider = createRpcProvider(this.config.rpcUrl);
    try {
      const head = await withTimeout(this.provider.getBlockNumber(), RPC_TIMEOUT_MS, 'getBlockNumber');
      logger.info(`Reconnected to RPC cleanly (current head=${head})`);
    } catch (err) {
      logger.warn(`RPC reconnect probe failed: ${errorMessage(err)}`);
    }
  }

  /** Decides where to start on first run (no saved lastBlock). */
  private async initStartBlock(): Promise<void> {
    if (this.store.lastBlock !== null) return;

    if (this.config.startBlock !== undefined) {
      this.store.setLastBlock(this.config.startBlock - 1);
    } else {
      // No backfill by default: only announce launches from now on.
      const head = await withTimeout(this.provider.getBlockNumber(), RPC_TIMEOUT_MS, 'getBlockNumber');
      this.store.setLastBlock(head);
    }
    await this.store.save();
  }

  /**
   * One polling pass.
   * Fast path (confirmations === 0): batches `eth_blockNumber` + `eth_getLogs(from..latest)`
   * into a SINGLE HTTP round-trip (~170ms) so new launches are detected in 1 RTT instead of 2.
   * Fallback path: chunked block-range scan when catching up across a large block gap.
   */
  private async poll(): Promise<void> {
    let from = this.store.lastBlock! + 1;

    if (this.config.confirmations === 0) {
      try {
        const [latest, logs] = await withTimeout(
          Promise.all([
            this.provider.getBlockNumber(),
            this.provider.getLogs({
              address: this.config.factoryAddress,
              fromBlock: from,
              toBlock: 'latest',
              topics: this.config.launchEventTopic ? [this.config.launchEventTopic] : undefined,
            }),
          ]),
          RPC_TIMEOUT_MS,
          `pollBatch(${from}..latest)`,
        );

        const maxLogBlock = logs.reduce((m, l) => Math.max(m, l.blockNumber), latest);
        const effectiveHead = Math.max(latest, maxLogBlock);

        if (effectiveHead >= from) {
          if (logs.length > 0) {
            await this.processLogs(logs, 'poll');
          }
          if (this.config.enableGraduationAlerts) {
            await this.maybeCheckSwapGraduations(effectiveHead);
          }
          this.store.setLastBlock(effectiveHead);
          await this.store.save();
        }
        return;
      } catch (err) {
        // If the gap was larger than the RPC's maxBlockRange, fall through to chunked polling.
        if (!/block range|too many results|response size|limit exceeded/i.test(errorMessage(err))) {
          throw err;
        }
      }
    }

    const latest = await withTimeout(this.provider.getBlockNumber(), RPC_TIMEOUT_MS, 'getBlockNumber');
    const head = latest - this.config.confirmations;
    let chunkSize = this.config.maxBlockRange;

    while (this.running && from <= head) {
      const to = Math.min(head, from + chunkSize - 1);
      try {
        await this.processRange(from, to);
      } catch (err) {
        // If the RPC complains that the block range is too wide, halve it and retry.
        if (chunkSize > 50 && /block range|too many results|response size|limit exceeded/i.test(errorMessage(err))) {
          chunkSize = Math.max(50, Math.floor(chunkSize / 2));
          logger.warn(`Reducing eth_getLogs block range to ${chunkSize} blocks and retrying`);
          continue;
        }
        throw err;
      }

      this.store.setLastBlock(to);
      await this.store.save();
      from = to + 1;
    }
  }

  private async processRange(fromBlock: number, toBlock: number): Promise<void> {
    const logs = await withTimeout(
      this.provider.getLogs({
        address: this.config.factoryAddress,
        fromBlock,
        toBlock,
        topics: this.config.launchEventTopic ? [this.config.launchEventTopic] : undefined,
      }),
      RPC_TIMEOUT_MS,
      `getLogs(${fromBlock}..${toBlock})`,
    );
    logger.debug(`Blocks ${fromBlock}-${toBlock}: ${logs.length} factory logs`);
    if (logs.length > 0) {
      await this.processLogs(logs, 'poll');
    }
  }

  private async processLogs(logs: Log[], source: 'poll' | 'ws' = 'poll'): Promise<void> {
    // Process in chain order so alerts go out in launch order.
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

    for (const log of logs) {
      if (log.removed) continue; // reorged out

      for (const address of extractCandidateAddresses(log, this.config.tokenSuffix)) {
        const lower = address.toLowerCase();
        if (this.store.hasSeen(address, log.transactionHash) || this.rejected.has(lower)) {
          continue;
        }
        if (!this.store.acquireInFlight(address)) {
          continue;
        }

        const eventReceivedAtMs = Date.now();
        logger.info(
          `[EVENT-RECEIVED] token=${address} tx=${log.transactionHash} block=${log.blockNumber} ` +
            `source=${source} receivedAt=${new Date(eventReceivedAtMs).toISOString()}`,
        );

        try {
          const launch = await this.verifyAndBuildLaunch(address, log, eventReceivedAtMs);
          if (!launch) {
            this.reject(lower);
            this.store.releaseInFlight(address);
            continue;
          }

          this.lastLaunch = launch;
          this.store.trackLaunch(launch);

          const filterReason = evaluateLaunchFilters(launch, this.config.filters);
          if (filterReason) {
            logger.info(
              `[FILTERED] $${launch.symbol ?? '?'} (${launch.name ?? '?'}) CA=${address}: ${filterReason}`,
            );
            this.store.markSeen(address, log.transactionHash);
            await this.store.save();
            continue;
          }

          await this.notifier.postLaunch(launch);
          this.postedThisSession++;
          this.store.markSeen(address, log.transactionHash);
          await this.store.save(); // persist immediately to avoid duplicates on crash
        } catch (err) {
          this.store.releaseInFlight(address);
          throw err;
        }
      }
    }
  }

  /**
   * Verifies the candidate is a genuinely new Torch token and gathers its details.
   * When matched via the strict `TokenLaunched` topic0 from the factory contract,
   * skips redundant `hasCode` / `isTorchToken` round-trips to save ~400ms.
   */
  private async verifyAndBuildLaunch(
    address: string,
    log: Log,
    eventReceivedAtMs: number,
  ): Promise<TokenLaunch | null> {
    const isStrictTokenLaunchedEvent =
      Boolean(this.config.launchEventTopic) ||
      log.topics[0]?.toLowerCase() === TOKEN_LAUNCHED_TOPIC;

    if (!isStrictTokenLaunchedEvent) {
      // 1. Must be a deployed contract (filters out EOAs/numbers that happen to end in 1111).
      if (!(await hasCode(this.provider, address))) {
        logger.debug(`Skip ${address}: no contract code`);
        return null;
      }

      // 2. Ask the factory directly if it recognizes this token (when supported).
      const isTorch = await checkIsTorchToken(this.provider, this.config.factoryAddress, address);
      if (isTorch === false) {
        logger.debug(`Skip ${address}: factory.isTorchToken() returned false`);
        return null;
      }

      // 3. Verify the contract did not exist one block earlier.
      if (this.config.verifyFreshDeploy) {
        if (!(await this.isFreshDeploy(address, log.blockNumber))) {
          logger.debug(`Skip ${address}: existed before block ${log.blockNumber} (not a new launch)`);
          return null;
        }
      }
    }

    const launch = await buildTokenLaunch(
      this.provider,
      address,
      log,
      (bn) => this.getBlockTimestamp(bn),
      eventReceivedAtMs,
    );

    const enrichMs = (launch.enrichedAtMs ?? Date.now()) - eventReceivedAtMs;
    const chainLagMs = eventReceivedAtMs - launch.timestamp * 1000;
    logger.info(
      `[DETECTED] $${launch.symbol ?? '?'} (${launch.name ?? '?'}) CA=${address} ` +
        `mcap=${launch.marketCapQuote?.toFixed(2) ?? '?'} ${launch.quoteSymbol} ` +
        `devBuy=${launch.initialBuyQuote ?? 0} ${launch.quoteSymbol} ` +
        `tax=${launch.buyTaxPct ?? '?'}% @ block ${log.blockNumber} | ` +
        `enrichMs=${enrichMs}ms chainToDetectMs=${chainLagMs}ms`,
    );
    return launch;
  }

  /**
   * Periodically checks Uniswap v4 `Swap` events on `PoolManager` for tracked Torch tokens
   * to detect when any token crosses the ~10x "Launch Complete" / Graduated milestone.
   */
  private async maybeCheckSwapGraduations(currentHead: number): Promise<void> {
    if (this.store.trackedTokenCount === 0) {
      this.lastSwapBlock = currentHead;
      return;
    }

    const now = Date.now();
    if (now - this.lastSwapCheckAtMs < this.config.graduationCheckIntervalMs) {
      return;
    }
    this.lastSwapCheckAtMs = now;

    const fromBlock = (this.lastSwapBlock ?? currentHead) + 1;
    if (fromBlock > currentHead) return;

    const maxSpan = this.config.maxBlockRange;
    const startBlock = Math.max(fromBlock, currentHead - maxSpan + 1);

    try {
      const trackedTokens = this.store.getAllTrackedTokens();
      const poolIds = trackedTokens.map((t) => t.poolId);
      // When tracking <= 50 pools, pass the poolIds array as topic1 filter so the RPC
      // only returns Swap logs for our tracked Torch tokens.
      const topicsFilter: (string | string[])[] =
        poolIds.length <= 50 ? [SWAP_TOPIC, poolIds] : [SWAP_TOPIC];

      const swapLogs = await withTimeout(
        this.provider.getLogs({
          address: this.config.poolManagerAddress,
          fromBlock: startBlock,
          toBlock: currentHead,
          topics: topicsFilter,
        }),
        RPC_TIMEOUT_MS,
        `getSwapLogs(${startBlock}..${currentHead})`,
      );

      this.lastSwapBlock = currentHead;
      if (swapLogs.length === 0) return;

      await this.processSwapLogs(swapLogs);
    } catch (err) {
      logger.debug(`Swap graduation check warning: ${errorMessage(err)}`);
    }
  }

  /**
   * Evaluates a batch of Uniswap v4 `Swap` logs against tracked Torch tokens,
   * updating their current price & market cap and firing Graduated alerts when
   * the ~10x (or user `/setminx`) threshold is reached.
   */
  public async processSwapLogs(swapLogs: Log[]): Promise<void> {
    for (const log of swapLogs) {
      if (log.removed) continue;
      const poolId = (log.topics[1] ?? '').toLowerCase();
      if (!poolId) continue;

      const tracked = this.store.getTrackedByPoolId(poolId);
      if (!tracked) continue;

      const swap = decodeSwapLog(log);
      if (!swap) continue;

      const metrics = computePriceAndMarketCap(
        swap.tick,
        tracked.quoteIsCurrency0,
        tracked.totalSupply,
        tracked.decimals,
        tracked.quoteDecimals,
        swap.sqrtPriceX96,
      );
      if (!metrics) continue;

      const updated = this.store.updateTokenPrice(
        poolId,
        metrics.priceQuote,
        metrics.marketCapQuote,
      );
      if (!updated) continue;

      const { token, multiple } = updated;
      const crossesGlobalGraduation =
        !token.graduated && multiple >= this.config.graduationMultiplier;

      // Also check if any subscribed user has a custom /setminx threshold that is now satisfied
      const alreadyNotified = new Set(token.notifiedUserIds);
      const hasUnnotifiedMatchingUser =
        (token.graduated || crossesGlobalGraduation || multiple >= 1.1) &&
        (this.userStore?.getSubscribedUsers() ?? []).some(
          (u) =>
            u.graduatedAlerts &&
            !alreadyNotified.has(u.chatId) &&
            multiple >= (u.minGraduatedMultiplier || this.config.graduationMultiplier),
        );

      if (!crossesGlobalGraduation && !hasUnnotifiedMatchingUser) {
        continue;
      }

      const ethUsd = token.quoteToken === ZeroAddress ? getCachedEthUsdPrice() : null;
      const currentMarketCapUsd = ethUsd !== null ? metrics.marketCapQuote * ethUsd : null;
      const currentPriceUsd = ethUsd !== null ? metrics.priceQuote * ethUsd : null;
      const initialMarketCapUsd =
        token.initialMarketCapUsd ?? (ethUsd !== null ? token.initialMarketCapQuote * ethUsd : null);
      const graduatedAt = Math.floor(Date.now() / 1000);

      if (crossesGlobalGraduation) {
        logger.info(
          `[GRADUATED] $${token.symbol ?? '?'} (${token.name ?? '?'}) CA=${token.address} ` +
            `reached ${multiple.toFixed(2)}x ("Launch Complete" >= ${this.config.graduationMultiplier}x)! ` +
            `MCap: ${token.initialMarketCapQuote.toFixed(2)} -> ${metrics.marketCapQuote.toFixed(2)} ${token.quoteSymbol} ` +
            `price=${metrics.priceQuote.toExponential(4)} ${token.quoteSymbol} @ block ${log.blockNumber} tx=${log.transactionHash}`,
        );
      }

      const graduation: TokenGraduation = {
        address: token.address,
        poolId: token.poolId,
        name: token.name,
        symbol: token.symbol,
        quoteToken: token.quoteToken,
        quoteSymbol: token.quoteSymbol,
        initialMarketCapQuote: token.initialMarketCapQuote,
        initialMarketCapUsd,
        currentMarketCapQuote: metrics.marketCapQuote,
        currentMarketCapUsd,
        currentPriceQuote: metrics.priceQuote,
        currentPriceUsd,
        multiple,
        buyTaxPct: token.buyTaxPct,
        sellTaxPct: token.sellTaxPct,
        launchedAt: token.launchedAt,
        graduatedAt,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        isFirstChannelGraduation: crossesGlobalGraduation,
        alreadyNotifiedUserIds: alreadyNotified,
        detectedAtMs: Date.now(),
      };

      const notifiedUsers = (await this.notifier.postGraduation?.(graduation)) ?? [];
      if (crossesGlobalGraduation) {
        this.store.markGraduated(
          poolId,
          multiple,
          graduatedAt,
          log.transactionHash,
          notifiedUsers,
        );
      } else if (notifiedUsers.length > 0) {
        this.store.addGraduatedNotifiedUsers(poolId, notifiedUsers);
      }
      await this.store.save();
    }
  }

  /**
   * One-time startup backfill that seeds recently launched Torch tokens (last ~350k blocks)
   * into `StateStore.trackedTokens` so tokens launched before the bot started are also
   * monitored for the ~10x "Launch Complete" milestone.
   */
  private async seedRecentTokensForGraduation(lookbackBlocks = 350_000): Promise<void> {
    if (!this.config.launchEventTopic) return;
    const head = this.store.lastBlock ?? (await this.provider.getBlockNumber());
    const minBlock = Math.max(0, head - lookbackBlocks);
    const step = 10_000;
    let seeded = 0;

    for (let from = minBlock; from <= head && this.running; from += step) {
      const to = Math.min(head, from + step - 1);
      try {
        const logs = await withTimeout(
          this.provider.getLogs({
            address: this.config.factoryAddress,
            fromBlock: from,
            toBlock: to,
            topics: [this.config.launchEventTopic],
          }),
          RPC_TIMEOUT_MS,
          `seedGraduations(${from}..${to})`,
        );
        for (const log of logs) {
          const [address] = extractCandidateAddresses(log, this.config.tokenSuffix);
          if (!address || this.store.getTrackedByAddress(address)) continue;
          const launch = await buildTokenLaunch(this.provider, address, log);
          const tracked: TrackedToken | null = this.store.trackLaunch(launch);
          if (tracked) seeded++;
        }
      } catch {
        // Ignore non-fatal seed chunk errors
      }
    }

    if (seeded > 0) {
      await this.store.save();
      logger.info(
        `Seeded ${seeded} recent Torch token(s) into graduation tracker (total tracked=${this.store.trackedTokenCount})`,
      );
    }
  }

  /**
   * True if the address had no code in the previous block, i.e. it was created
   * in this block. Protects against announcing old tokens that merely show up
   * in other factory events (trades, migrations, ...).
   */
  private async isFreshDeploy(address: string, blockNumber: number): Promise<boolean> {
    try {
      return !(await hasCode(this.provider, address, blockNumber - 1));
    } catch (err) {
      if (isMissingStateError(err)) {
        // Non-archive node pruned that state (e.g. catching up after long downtime).
        logger.warn(`Cannot verify fresh deploy of ${address} (state pruned); assuming new`);
        return true;
      }
      throw err;
    }
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const cached = this.blockTimeCache.get(blockNumber);
    if (cached !== undefined) return cached;

    const block = await withTimeout(
      this.provider.getBlock(blockNumber),
      RPC_TIMEOUT_MS,
      `getBlock(${blockNumber})`,
    );
    const ts = block?.timestamp ?? Math.floor(Date.now() / 1000);

    if (this.blockTimeCache.size > 1000) this.blockTimeCache.clear();
    this.blockTimeCache.set(blockNumber, ts);
    return ts;
  }

  private reject(addressLower: string): void {
    if (this.rejected.size >= MAX_REJECTED_CACHE) this.rejected.clear();
    this.rejected.add(addressLower);
  }

  /** Interruptible sleep so shutdown is immediate. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
