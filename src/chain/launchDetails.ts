/**
 * Builds an enriched `TokenLaunch` by combining decoded `TokenLaunched` log fields,
 * on-chain token contract getters, quote token metadata, and Uniswap v4 pool
 * initialization/swap events from the launch transaction receipt.
 *
 * Also evaluates configurable trader filters (market cap range, buy tax range,
 * initial buy range, and ETH quote pair).
 */
import { ZeroAddress, formatUnits, type Log, type Provider } from 'ethers';
import type { LaunchFilters, TokenLaunch } from '../types';
import {
  computeMarketCapFromTick,
  decodeTokenLaunchedLog,
  extractPoolLaunchMetrics,
  type RawLog,
} from './extract';
import {
  fetchOnChainTokenDetails,
  fetchQuoteTokenInfo,
  withTimeout,
} from './token';
import { fetchEthUsdPrice } from './price';

const DEFAULT_TOTAL_SUPPLY = 1_000_000_000;

/**
 * Gathers all on-chain and event details for a newly launched Torch token.
 */
export async function buildTokenLaunch(
  provider: Provider,
  address: string,
  log: Log | (RawLog & { blockNumber: number; transactionHash: string }),
  getBlockTimestamp?: (blockNumber: number) => Promise<number>,
  detectedAtMs?: number,
): Promise<TokenLaunch> {
  const startMs = detectedAtMs ?? Date.now();
  const decodedEvent = decodeTokenLaunchedLog(log);
  const quoteAddress = decodedEvent?.quoteToken ?? ZeroAddress;

  const [tokenDetails, quoteInfo, receipt, ethUsdPrice] = await Promise.all([
    fetchOnChainTokenDetails(provider, address),
    fetchQuoteTokenInfo(provider, quoteAddress),
    withTimeout(
      provider.getTransactionReceipt(log.transactionHash),
      6_000,
      'getTransactionReceipt()',
    ).catch(() => null),
    quoteAddress === ZeroAddress ? fetchEthUsdPrice() : Promise.resolve(null),
  ]);

  // Timestamp: prefer on-chain LAUNCHED_AT() if available, otherwise block timestamp.
  let timestamp = tokenDetails.launchedAt;
  if (!timestamp) {
    if (getBlockTimestamp) {
      timestamp = await getBlockTimestamp(log.blockNumber);
    } else {
      const block = await withTimeout(
        provider.getBlock(log.blockNumber),
        6_000,
        'getBlock()',
      ).catch(() => null);
      timestamp = block?.timestamp ?? Math.floor(Date.now() / 1000);
    }
  }

  const totalSupply = tokenDetails.totalSupply ?? DEFAULT_TOTAL_SUPPLY;
  const buyTaxBps = tokenDetails.buyTaxBps ?? decodedEvent?.buyTaxBps ?? null;
  const sellTaxBps = tokenDetails.sellTaxBps;
  const snipeStartBps = tokenDetails.snipeStartBps;
  const snipeDurationSec = tokenDetails.snipeDurationSec ?? decodedEvent?.snipeDurationSec ?? null;
  const lpFeeBps = decodedEvent?.lpFee ?? null;

  let marketCapQuote: number | null = null;
  let initialBuyQuote: number | null = null;
  let initialBuySupplyPct: number | null = null;
  let poolId: string | null = decodedEvent?.poolId ? decodedEvent.poolId.toLowerCase() : null;
  let quoteIsCurrency0 = quoteAddress === ZeroAddress;

  if (receipt) {
    const poolMetrics = extractPoolLaunchMetrics(
      receipt.logs,
      address,
      decodedEvent?.poolId,
    );
    if (poolMetrics.poolId) poolId = poolMetrics.poolId.toLowerCase();
    quoteIsCurrency0 = poolMetrics.quoteIsCurrency0;
    initialBuyQuote = Number(formatUnits(poolMetrics.initialBuyQuoteRaw, quoteInfo.decimals));
    const tokensBought = Number(formatUnits(poolMetrics.initialBuyTokensRaw, tokenDetails.decimals));
    initialBuySupplyPct = totalSupply > 0 ? (tokensBought / totalSupply) * 100 : 0;

    if (poolMetrics.postLaunchTick !== null) {
      marketCapQuote = computeMarketCapFromTick(
        poolMetrics.postLaunchTick,
        poolMetrics.quoteIsCurrency0,
        totalSupply,
        tokenDetails.decimals,
        quoteInfo.decimals,
      );
    }
  }

  const marketCapUsd =
    marketCapQuote !== null && ethUsdPrice !== null ? marketCapQuote * ethUsdPrice : null;

  return {
    address,
    name: tokenDetails.name,
    symbol: tokenDetails.symbol,
    decimals: tokenDetails.decimals,
    totalSupply: tokenDetails.totalSupply,
    creator: decodedEvent?.launcher ?? (receipt?.from ? String(receipt.from) : null),
    quoteToken: quoteAddress,
    quoteSymbol: quoteInfo.symbol,
    quoteDecimals: quoteInfo.decimals,
    quoteIsCurrency0,
    poolId,
    buyTaxPct: buyTaxBps !== null ? buyTaxBps / 100 : null,
    sellTaxPct: sellTaxBps !== null ? sellTaxBps / 100 : null,
    snipeStartTaxPct: snipeStartBps !== null ? snipeStartBps / 100 : null,
    snipeDurationSec,
    lpFeePct: lpFeeBps !== null ? lpFeeBps / 10_000 : null,
    marketCapQuote,
    marketCapUsd,
    initialBuyQuote,
    initialBuySupplyPct,
    metadataUri: decodedEvent?.metadataUri ?? null,
    timestamp,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    detectedAtMs: startMs,
    enrichedAtMs: Date.now(),
  };
}

/**
 * Checks whether a launch satisfies the configured trader filters.
 * Returns `null` if it passes, or a short reason string if it should be skipped.
 */
export function evaluateLaunchFilters(
  launch: TokenLaunch,
  filters: LaunchFilters,
): string | null {
  if (filters.onlyEthPairs && launch.quoteToken !== ZeroAddress) {
    return `quote token is ${launch.quoteSymbol} (ONLY_ETH_PAIRS=true)`;
  }

  if (filters.minBuyTaxPct > 0) {
    if (launch.buyTaxPct === null || launch.buyTaxPct < filters.minBuyTaxPct) {
      return `buy tax ${launch.buyTaxPct ?? 'unknown'}% < MIN_BUY_TAX_PCT (${filters.minBuyTaxPct}%)`;
    }
  }

  if (filters.maxBuyTaxPct < 100 && launch.buyTaxPct !== null) {
    if (launch.buyTaxPct > filters.maxBuyTaxPct) {
      return `buy tax ${launch.buyTaxPct}% > MAX_BUY_TAX_PCT (${filters.maxBuyTaxPct}%)`;
    }
  }

  if (filters.minMarketCapEth > 0) {
    if (launch.marketCapQuote === null || launch.marketCapQuote < filters.minMarketCapEth) {
      return `market cap ${launch.marketCapQuote?.toFixed(3) ?? 'unknown'} ${launch.quoteSymbol} < MIN_MARKET_CAP_ETH (${filters.minMarketCapEth})`;
    }
  }

  if (filters.maxMarketCapEth > 0 && launch.marketCapQuote !== null) {
    if (launch.marketCapQuote > filters.maxMarketCapEth) {
      return `market cap ${launch.marketCapQuote.toFixed(3)} ${launch.quoteSymbol} > MAX_MARKET_CAP_ETH (${filters.maxMarketCapEth})`;
    }
  }

  if (filters.minInitialBuyEth > 0) {
    if (launch.initialBuyQuote === null || launch.initialBuyQuote < filters.minInitialBuyEth) {
      return `initial buy ${launch.initialBuyQuote ?? 0} ${launch.quoteSymbol} < MIN_INITIAL_BUY_ETH (${filters.minInitialBuyEth})`;
    }
  }

  if (filters.maxInitialBuyPct < 100 && launch.initialBuySupplyPct !== null) {
    if (launch.initialBuySupplyPct > filters.maxInitialBuyPct) {
      return `initial buy ${launch.initialBuySupplyPct.toFixed(2)}% supply > MAX_INITIAL_BUY_PCT (${filters.maxInitialBuyPct}%)`;
    }
  }

  return null;
}

/** Human-readable summary of active filters for startup logs. */
export function describeActiveFilters(filters: LaunchFilters): string {
  const active: string[] = [];
  if (filters.minMarketCapEth > 0) active.push(`minMCap=${filters.minMarketCapEth}`);
  if (filters.maxMarketCapEth > 0) active.push(`maxMCap=${filters.maxMarketCapEth}`);
  if (filters.minBuyTaxPct > 0 || filters.maxBuyTaxPct < 100) {
    active.push(`buyTax=${filters.minBuyTaxPct}%..${filters.maxBuyTaxPct}%`);
  }
  if (filters.minInitialBuyEth > 0) active.push(`minDevBuy=${filters.minInitialBuyEth}`);
  if (filters.maxInitialBuyPct < 100) active.push(`maxDevBuy=${filters.maxInitialBuyPct}%`);
  if (filters.onlyEthPairs) active.push('onlyEthPairs=true');
  return active.length > 0 ? active.join(', ') : 'none (all valid Torch launches)';
}
