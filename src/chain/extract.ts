/**
 * Event decoding for Torch factory launches and Uniswap v4 pool initialization/swaps,
 * plus ABI-agnostic fallback extraction of suffix-matching token addresses.
 */
import { Interface, ZeroAddress, getAddress } from 'ethers';

/** The parts of a log we care about (compatible with ethers' `Log`). */
export interface RawLog {
  address?: string;
  topics: readonly string[];
  data: string;
}

export const TOKEN_LAUNCHED_TOPIC =
  '0xea6baf14ec1f4c08d18114c1eea0e6a2a018eef994f9db19ea8a41526e49d28c';

export const SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

export const DEFAULT_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';

const TORCH_EVENT_IFACE = new Interface([
  'event TokenLaunched(address indexed token, address indexed launcher, bytes32 poolId, uint256 buyTaxBps, uint24 lpFee, uint256 snipeDuration, (uint16 a, uint16 b, uint16 c, uint16 d) feeSplit, string metadataURI, address quoteToken)',
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

/** Structured data decoded directly from a Torch `TokenLaunched` event log. */
export interface DecodedTokenLaunchedEvent {
  token: string;
  launcher: string;
  poolId: string;
  buyTaxBps: number;
  lpFee: number;
  snipeDurationSec: number;
  metadataUri: string | null;
  quoteToken: string;
}

/** Pool launch metrics extracted from the launch transaction receipt logs. */
export interface PoolLaunchMetrics {
  /** Matched Uniswap v4 poolId (lowercase 0x-hex), if found in logs. */
  poolId: string | null;
  /** Tick right after pool initialization (before any initial swap). */
  initialTick: number | null;
  /** Tick after the initial swap in the launch tx (or initialTick if no swap). */
  postLaunchTick: number | null;
  /** True if currency0 is the quote token and currency1 is the launched token. */
  quoteIsCurrency0: boolean;
  /** Raw quote currency amount spent in the launch tx initial buy (wei). */
  initialBuyQuoteRaw: bigint;
  /** Raw token amount bought in the launch tx initial buy (wei). */
  initialBuyTokensRaw: bigint;
}

/** Structured data decoded from a Uniswap v4 `Swap` event log. */
export interface DecodedSwapEvent {
  poolId: string;
  sender: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
}

/**
 * Decodes a `TokenLaunched` log if `log.topics[0]` matches `TOKEN_LAUNCHED_TOPIC`.
 * Returns null if the log is a different event or malformed.
 */
export function decodeTokenLaunchedLog(log: RawLog): DecodedTokenLaunchedEvent | null {
  if ((log.topics[0] ?? '').toLowerCase() !== TOKEN_LAUNCHED_TOPIC) return null;
  try {
    const parsed = TORCH_EVENT_IFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed) return null;

    const rawUri = String(parsed.args.metadataURI ?? '').trim();
    return {
      token: getAddress(parsed.args.token),
      launcher: getAddress(parsed.args.launcher),
      poolId: String(parsed.args.poolId),
      buyTaxBps: Number(parsed.args.buyTaxBps),
      lpFee: Number(parsed.args.lpFee),
      snipeDurationSec: Number(parsed.args.snipeDuration),
      metadataUri: rawUri || null,
      quoteToken: getAddress(parsed.args.quoteToken ?? ZeroAddress),
    };
  } catch {
    return null;
  }
}

/**
 * Inspects all logs from a launch transaction receipt to extract Uniswap v4
 * `Initialize` and `Swap` data for the newly created token pool.
 */
export function extractPoolLaunchMetrics(
  receiptLogs: readonly RawLog[],
  tokenAddress: string,
  poolId?: string,
): PoolLaunchMetrics {
  const tokenLower = tokenAddress.toLowerCase();
  const poolIdLower = poolId?.toLowerCase();

  let initialTick: number | null = null;
  let postLaunchTick: number | null = null;
  let quoteIsCurrency0 = true;
  let matchedPoolId = poolIdLower;
  let initialBuyQuoteRaw = 0n;
  let initialBuyTokensRaw = 0n;

  for (const log of receiptLogs) {
    try {
      const parsed = TORCH_EVENT_IFACE.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed) continue;

      if (parsed.name === 'Initialize') {
        const id = String(parsed.args.id).toLowerCase();
        const c0 = String(parsed.args.currency0).toLowerCase();
        const c1 = String(parsed.args.currency1).toLowerCase();
        if ((matchedPoolId && id === matchedPoolId) || c0 === tokenLower || c1 === tokenLower) {
          matchedPoolId = id;
          quoteIsCurrency0 = c1 === tokenLower;
          initialTick = Number(parsed.args.tick);
        }
      } else if (parsed.name === 'Swap') {
        const id = String(parsed.args.id).toLowerCase();
        if (matchedPoolId && id !== matchedPoolId) continue;

        const amount0 = BigInt(parsed.args.amount0);
        const amount1 = BigInt(parsed.args.amount1);
        postLaunchTick = Number(parsed.args.tick);

        // In Uniswap v4 PoolManager, negative delta is paid into the pool by the
        // swapper (quote input), and positive delta is received by the swapper (tokens out).
        const quoteDelta = quoteIsCurrency0 ? amount0 : amount1;
        const tokenDelta = quoteIsCurrency0 ? amount1 : amount0;
        if (quoteDelta < 0n) initialBuyQuoteRaw += -quoteDelta;
        if (tokenDelta > 0n) initialBuyTokensRaw += tokenDelta;
      }
    } catch {
      // Ignore unrelated logs from other contracts in the receipt.
    }
  }

  return {
    poolId: matchedPoolId ?? null,
    initialTick,
    postLaunchTick: postLaunchTick ?? initialTick,
    quoteIsCurrency0,
    initialBuyQuoteRaw,
    initialBuyTokensRaw,
  };
}

/**
 * Decodes a Uniswap v4 `Swap` event log if `log.topics[0]` matches `SWAP_TOPIC`.
 */
export function decodeSwapLog(log: RawLog): DecodedSwapEvent | null {
  if ((log.topics[0] ?? '').toLowerCase() !== SWAP_TOPIC) return null;
  try {
    const parsed = TORCH_EVENT_IFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed || parsed.name !== 'Swap') return null;
    return {
      poolId: String(parsed.args.id).toLowerCase(),
      sender: getAddress(parsed.args.sender),
      amount0: BigInt(parsed.args.amount0),
      amount1: BigInt(parsed.args.amount1),
      sqrtPriceX96: BigInt(parsed.args.sqrtPriceX96),
      liquidity: BigInt(parsed.args.liquidity),
      tick: Number(parsed.args.tick),
      fee: Number(parsed.args.fee),
    };
  } catch {
    return null;
  }
}

/**
 * Computes both the per-token price and total market cap (in quote currency units)
 * from a Uniswap v4 `tick` (and optional `sqrtPriceX96` for sub-tick precision).
 */
export function computePriceAndMarketCap(
  tick: number,
  quoteIsCurrency0: boolean,
  totalSupplyTokens: number,
  tokenDecimals = 18,
  quoteDecimals = 18,
  sqrtPriceX96?: bigint,
): { priceQuote: number; marketCapQuote: number } | null {
  if (!Number.isFinite(tick) || totalSupplyTokens <= 0) return null;
  const decimalAdjustment = 10 ** (tokenDecimals - quoteDecimals);

  let rawPriceInQuote = 0;
  if (sqrtPriceX96 !== undefined && sqrtPriceX96 > 0n) {
    const sqrtRatio = Number(sqrtPriceX96) / 2 ** 96;
    const rawRatio = sqrtRatio * sqrtRatio; // currency1 / currency0
    if (Number.isFinite(rawRatio) && rawRatio > 0) {
      rawPriceInQuote = quoteIsCurrency0 ? 1 / rawRatio : rawRatio;
    }
  }

  if (!Number.isFinite(rawPriceInQuote) || rawPriceInQuote <= 0) {
    const exponent = quoteIsCurrency0 ? -tick : tick;
    rawPriceInQuote = Math.pow(1.0001, exponent);
  }

  const priceQuote = rawPriceInQuote * decimalAdjustment;
  const marketCapQuote = priceQuote * totalSupplyTokens;
  if (!Number.isFinite(priceQuote) || !Number.isFinite(marketCapQuote) || marketCapQuote <= 0) {
    return null;
  }
  return { priceQuote, marketCapQuote };
}

/**
 * Computes the token price in quote currency units from a Uniswap v4 tick,
 * and multiplies by totalSupply to get the market cap in quote currency units.
 */
export function computeMarketCapFromTick(
  tick: number,
  quoteIsCurrency0: boolean,
  totalSupplyTokens: number,
  tokenDecimals = 18,
  quoteDecimals = 18,
): number | null {
  return (
    computePriceAndMarketCap(
      tick,
      quoteIsCurrency0,
      totalSupplyTokens,
      tokenDecimals,
      quoteDecimals,
    )?.marketCapQuote ?? null
  );
}

/**
 * Interprets a 32-byte word as an ABI-encoded address.
 * Returns the lowercase address, or null if the word can't be an address.
 */
export function wordToAddress(word: string): string | null {
  const hex = word.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 64) return null;

  // ABI-encoded addresses are left-padded with 12 zero bytes.
  if (!/^0{24}$/.test(hex.slice(0, 24))) return null;

  const body = hex.slice(24);
  // Reject small values (amounts, ids, flags...) that merely look like padded
  // addresses: require the upper 12 bytes of the address itself to be non-zero.
  if (/^0{24}$/.test(body.slice(0, 24))) return null;

  return `0x${body}`;
}

/**
 * Returns the unique, checksummed addresses in a log whose hex ends with `suffix`.
 * @param suffix lowercase hex suffix without 0x, e.g. "1111"
 */
export function extractCandidateAddresses(log: RawLog, suffix: string): string[] {
  const decoded = decodeTokenLaunchedLog(log);
  if (decoded) {
    return decoded.token.toLowerCase().endsWith(suffix) ? [decoded.token] : [];
  }

  const words: string[] = log.topics.slice(1);

  const data = log.data.toLowerCase().replace(/^0x/, '');
  for (let i = 0; i + 64 <= data.length; i += 64) {
    words.push(data.slice(i, i + 64));
  }

  const found = new Set<string>();
  for (const word of words) {
    const addr = wordToAddress(word);
    if (addr && addr.endsWith(suffix)) found.add(getAddress(addr));
  }
  return [...found];
}
