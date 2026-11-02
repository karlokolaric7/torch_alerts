/**
 * Helpers for reading Torch token contracts, factory state, and quote tokens on-chain.
 */
import {
  Contract,
  ZeroAddress,
  decodeBytes32String,
  formatUnits,
  type Provider,
} from 'ethers';

const ERC20_STRING_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

// Some older tokens return bytes32 instead of string.
const ERC20_BYTES32_ABI = [
  'function name() view returns (bytes32)',
  'function symbol() view returns (bytes32)',
];

const TORCH_TOKEN_ABI = [
  'function BUY_TAX_BPS() view returns (uint256)',
  'function buyTaxBps() view returns (uint256)',
  'function sellTaxBps() view returns (uint256)',
  'function SNIPE_START_BPS() view returns (uint256)',
  'function SNIPE_DURATION() view returns (uint256)',
  'function LAUNCHED_AT() view returns (uint256)',
];

const TORCH_FACTORY_ABI = [
  'function isTorchToken(address token) view returns (bool)',
  'function launcherOf(address token) view returns (address)',
  'function quoteOf(address token) view returns (address)',
];

const MAX_LEN = 64;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/** Cache of quote token symbol + decimals by lowercase address. */
const quoteTokenCache = new Map<string, { symbol: string; decimals: number }>();

/** Strips control characters / whitespace noise and caps length. */
function sanitize(value: string): string | null {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN)}…` : cleaned;
}

/** Runs a promise with a hard timeout so a stalled RPC call can't hang the loop. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = DEFAULT_CALL_TIMEOUT_MS,
  label = 'RPC call',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function readText(
  provider: Provider,
  address: string,
  fn: 'name' | 'symbol',
): Promise<string | null> {
  try {
    const value: string = await withTimeout(
      new Contract(address, ERC20_STRING_ABI, provider)[fn](),
      DEFAULT_CALL_TIMEOUT_MS,
      `${fn}()`,
    );
    return sanitize(value);
  } catch {
    try {
      const raw: string = await withTimeout(
        new Contract(address, ERC20_BYTES32_ABI, provider)[fn](),
        DEFAULT_CALL_TIMEOUT_MS,
        `${fn}() bytes32`,
      );
      return sanitize(decodeBytes32String(raw));
    } catch {
      return null;
    }
  }
}

async function readBigInt(
  contract: Contract,
  fn: string,
): Promise<bigint | null> {
  try {
    const val = await withTimeout(contract[fn](), DEFAULT_CALL_TIMEOUT_MS, `${fn}()`);
    return BigInt(val);
  } catch {
    return null;
  }
}

export interface OnChainTokenDetails {
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: number | null;
  /** Base buy tax in basis points (e.g. 200 = 2.0%). */
  buyTaxBps: number | null;
  /** Base sell tax in basis points (e.g. 0 = 0%). */
  sellTaxBps: number | null;
  /** Anti-snipe initial buy tax in basis points (e.g. 8000 = 80%). */
  snipeStartBps: number | null;
  /** Anti-snipe duration in seconds (e.g. 30). */
  snipeDurationSec: number | null;
  /** On-chain LAUNCHED_AT timestamp if exposed by the token contract. */
  launchedAt: number | null;
}

/** Reads ERC-20 name and symbol. Missing values come back as null, never throws. */
export async function fetchTokenMetadata(
  provider: Provider,
  address: string,
): Promise<{ name: string | null; symbol: string | null }> {
  const [name, symbol] = await Promise.all([
    readText(provider, address, 'name'),
    readText(provider, address, 'symbol'),
  ]);
  return { name, symbol };
}

/**
 * Reads full ERC-20 + Torch tax/snipe parameters from the token contract.
 * Never throws; any unsupported getter resolves to null (or 18 for decimals).
 */
export async function fetchOnChainTokenDetails(
  provider: Provider,
  address: string,
): Promise<OnChainTokenDetails> {
  const erc20 = new Contract(address, ERC20_STRING_ABI, provider);
  const torch = new Contract(address, TORCH_TOKEN_ABI, provider);

  const [
    name,
    symbol,
    decimalsRaw,
    totalSupplyRaw,
    baseBuyTaxRaw,
    currentBuyTaxRaw,
    sellTaxRaw,
    snipeStartRaw,
    snipeDurationRaw,
    launchedAtRaw,
  ] = await Promise.all([
    readText(provider, address, 'name'),
    readText(provider, address, 'symbol'),
    readBigInt(erc20, 'decimals'),
    readBigInt(erc20, 'totalSupply'),
    readBigInt(torch, 'BUY_TAX_BPS'),
    readBigInt(torch, 'buyTaxBps'),
    readBigInt(torch, 'sellTaxBps'),
    readBigInt(torch, 'SNIPE_START_BPS'),
    readBigInt(torch, 'SNIPE_DURATION'),
    readBigInt(torch, 'LAUNCHED_AT'),
  ]);

  const decimals =
    decimalsRaw !== null && decimalsRaw >= 0n && decimalsRaw <= 36n ? Number(decimalsRaw) : 18;
  const totalSupply =
    totalSupplyRaw !== null ? Number(formatUnits(totalSupplyRaw, decimals)) : null;

  const buyTaxBps =
    baseBuyTaxRaw !== null
      ? Number(baseBuyTaxRaw)
      : currentBuyTaxRaw !== null
        ? Number(currentBuyTaxRaw)
        : null;

  return {
    name,
    symbol,
    decimals,
    totalSupply: totalSupply !== null && Number.isFinite(totalSupply) ? totalSupply : null,
    buyTaxBps,
    sellTaxBps: sellTaxRaw !== null ? Number(sellTaxRaw) : null,
    snipeStartBps: snipeStartRaw !== null ? Number(snipeStartRaw) : null,
    snipeDurationSec: snipeDurationRaw !== null ? Number(snipeDurationRaw) : null,
    launchedAt: launchedAtRaw !== null && launchedAtRaw > 0n ? Number(launchedAtRaw) : null,
  };
}

/**
 * Checks `factory.isTorchToken(address)` if the factory supports it.
 * Returns true/false when the call succeeds, or null if the call fails/reverts.
 */
export async function checkIsTorchToken(
  provider: Provider,
  factoryAddress: string,
  tokenAddress: string,
): Promise<boolean | null> {
  try {
    const factory = new Contract(factoryAddress, TORCH_FACTORY_ABI, provider);
    const ok: boolean = await withTimeout(
      factory.isTorchToken(tokenAddress),
      DEFAULT_CALL_TIMEOUT_MS,
      'factory.isTorchToken()',
    );
    return Boolean(ok);
  } catch {
    return null;
  }
}

/**
 * Resolves the symbol and decimals for a quote token address.
 * ZeroAddress is native ETH on Robinhood Chain.
 */
export async function fetchQuoteTokenInfo(
  provider: Provider,
  quoteAddress: string,
): Promise<{ symbol: string; decimals: number }> {
  if (!quoteAddress || quoteAddress === ZeroAddress) {
    return { symbol: 'ETH', decimals: 18 };
  }
  const key = quoteAddress.toLowerCase();
  const cached = quoteTokenCache.get(key);
  if (cached) return cached;

  const erc20 = new Contract(quoteAddress, ERC20_STRING_ABI, provider);
  const [symbol, decimalsRaw] = await Promise.all([
    readText(provider, quoteAddress, 'symbol'),
    readBigInt(erc20, 'decimals'),
  ]);
  const info = {
    symbol: symbol ?? 'QUOTE',
    decimals: decimalsRaw !== null && decimalsRaw >= 0n && decimalsRaw <= 36n ? Number(decimalsRaw) : 18,
  };
  if (quoteTokenCache.size > 200) quoteTokenCache.clear();
  quoteTokenCache.set(key, info);
  return info;
}

/** True if there is contract bytecode at `address` at the given block (default latest). */
export async function hasCode(
  provider: Provider,
  address: string,
  blockTag: number | 'latest' = 'latest',
): Promise<boolean> {
  const code = await withTimeout(
    provider.getCode(address, blockTag),
    DEFAULT_CALL_TIMEOUT_MS,
    `getCode(${address})`,
  );
  return code !== '0x';
}

/**
 * Heuristic for "the node no longer has state for that block" errors,
 * which happen on non-archive nodes when querying older blocks.
 */
export function isMissingStateError(err: unknown): boolean {
  // ethers wraps RPC errors ("could not coalesce error"), so check the inner
  // JSON-RPC error too, e.g. {"code":-32000,"message":"historical state 0x… is not available"}.
  const e = err as { message?: string; error?: { message?: string } };
  const msg = `${e?.message ?? err} ${e?.error?.message ?? ''}`.toLowerCase();
  return /missing trie node|historical state|state.*(not available|unavailable|pruned)|header not found|block not found/.test(
    msg,
  );
}
