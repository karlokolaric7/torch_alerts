/**
 * Loads and validates configuration from environment variables (.env via dotenv).
 * Fails fast with a clear message if anything required is missing or malformed.
 */
import 'dotenv/config';
import { getAddress, isHexString } from 'ethers';
import { DEFAULT_POOL_MANAGER } from './chain/extract';
import type { LaunchFilters } from './types';

export interface Config {
  rpcUrl: string;
  /** Optional WebSocket RPC URL (ws:// or wss://) for real-time log subscriptions. */
  wsRpcUrl?: string;
  factoryAddress: string;
  /** Uniswap v4 PoolManager address used to monitor Swaps for ~10x graduation. */
  poolManagerAddress: string;
  /** Enable "Launch Complete" / Graduated (~10x) monitoring and alerts (default true). */
  enableGraduationAlerts: boolean;
  /** Multiple of initial launch market cap that marks a token as Graduated (default 10). */
  graduationMultiplier: number;
  /** How often (ms) to check Swap logs for tracked token graduations (default 2400ms). */
  graduationCheckIntervalMs: number;
  telegramBotToken: string;
  telegramChannelId: string;
  /** Whether to post alerts to the public TELEGRAM_CHANNEL_ID (default true). */
  postToChannel: boolean;
  /**
   * When true (default), posts the text alert to the public channel immediately
   * after detection and sends the generated PNG launch card as a non-blocking follow-up.
   */
  fastChannelTextFirst: boolean;
  /** Path to persist per-user Telegram filter preferences. */
  userFiltersFile: string;
  /** Lowercase hex suffix that identifies real Torch tokens (e.g. "1111"). */
  tokenSuffix: string;
  /** Optional topic0 of the factory's launch event. Enables strict mode. */
  launchEventTopic?: string;
  verifyFreshDeploy: boolean;
  pollIntervalMs: number;
  maxBlockRange: number;
  confirmations: number;
  startBlock?: number;
  explorerUrl?: string;
  tokenUrlTemplate: string;
  /** Include a generated PNG launch card image with each Telegram alert. */
  includeImageCard: boolean;
  /** Include a copy-pasteable share text card in each alert message. */
  includeShareCard: boolean;
  /** Enable interactive Telegram bot commands (/status, /latest, /filters, /help). */
  enableBotCommands: boolean;
  stateFile: string;
  /** Log alerts to the console instead of posting to Telegram. */
  dryRun: boolean;
  /** Trader filters applied before alerting. */
  filters: LaunchFilters;
}

export const DEFAULT_FACTORY = '0x7891eA889899928aFE637e4Cca8106188427776a';
export const DEFAULT_LAUNCH_TOPIC =
  '0xea6baf14ec1f4c08d18114c1eea0e6a2a018eef994f9db19ea8a41526e49d28c';
export const DEFAULT_TRADE_URL_TEMPLATE = 'https://app.torchpad.fun/trade/robinhood/{address}';

export class ConfigError extends Error {}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new ConfigError(`Missing required env var ${name} (see .env.example)`);
  return value;
}

function integer(name: string, fallback: number, min = 0): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`Env var ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function number(name: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`Env var ${name} must be a number in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`Env var ${name} must be a boolean, got "${raw}"`);
}

/** Config needed only for reading the chain (used by the inspect script too). */
export function loadChainConfig(): Pick<
  Config,
  'rpcUrl' | 'wsRpcUrl' | 'factoryAddress' | 'tokenSuffix' | 'launchEventTopic' | 'maxBlockRange'
> {
  const rpcUrl = required('RPC_URL');
  if (!/^(https?|wss?):\/\//i.test(rpcUrl)) {
    throw new ConfigError('RPC_URL must be an http(s) or ws(s) URL');
  }

  const rawWsUrl = optional('WS_RPC_URL') ?? (/^wss?:\/\//i.test(rpcUrl) ? rpcUrl : undefined);
  if (rawWsUrl && !/^wss?:\/\//i.test(rawWsUrl)) {
    throw new ConfigError('WS_RPC_URL must be a ws:// or wss:// URL');
  }

  let factoryAddress: string;
  try {
    factoryAddress = getAddress(optional('FACTORY_ADDRESS') ?? DEFAULT_FACTORY);
  } catch {
    throw new ConfigError('FACTORY_ADDRESS is not a valid address');
  }

  const tokenSuffix = (optional('TOKEN_SUFFIX') ?? '1111').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{1,40}$/.test(tokenSuffix)) {
    throw new ConfigError('TOKEN_SUFFIX must be a hex string');
  }

  // Default to the verified TokenLaunched topic unless explicitly cleared.
  const rawTopic = process.env.LAUNCH_EVENT_TOPIC;
  const launchEventTopic =
    rawTopic === undefined
      ? DEFAULT_LAUNCH_TOPIC
      : rawTopic.trim()
        ? rawTopic.trim().toLowerCase()
        : undefined;
  if (launchEventTopic && !isHexString(launchEventTopic, 32)) {
    throw new ConfigError('LAUNCH_EVENT_TOPIC must be a 32-byte hex string (0x + 64 hex chars)');
  }

  return {
    rpcUrl,
    wsRpcUrl: rawWsUrl,
    factoryAddress,
    tokenSuffix,
    launchEventTopic,
    maxBlockRange: integer('MAX_BLOCK_RANGE', 2000, 1),
  };
}

export function loadConfig(): Config {
  const chain = loadChainConfig();
  const startBlockRaw = optional('START_BLOCK');
  const dryRun = boolean('DRY_RUN', false);
  const postToChannel = boolean('POST_TO_CHANNEL', true);

  // Support buy tax filters in either percentage (MIN_BUY_TAX_PCT / MAX_BUY_TAX_PCT)
  // or basis points (MIN_BUY_TAX_BPS / MAX_BUY_TAX_BPS).
  const minBuyTaxBps = integer('MIN_BUY_TAX_BPS', 0, 0);
  const maxBuyTaxBps = integer('MAX_BUY_TAX_BPS', 10000, 0);
  const minBuyTaxPct = number('MIN_BUY_TAX_PCT', minBuyTaxBps / 100, 0, 100);
  const maxBuyTaxPct = number('MAX_BUY_TAX_PCT', maxBuyTaxBps / 100, 0, 100);
  if (minBuyTaxPct > maxBuyTaxPct) {
    throw new ConfigError(
      `MIN_BUY_TAX_PCT (${minBuyTaxPct}) cannot be greater than MAX_BUY_TAX_PCT (${maxBuyTaxPct})`,
    );
  }

  const minMarketCapEth = number('MIN_MARKET_CAP_ETH', 0, 0);
  const maxMarketCapEth = number('MAX_MARKET_CAP_ETH', 0, 0);
  if (maxMarketCapEth > 0 && minMarketCapEth > maxMarketCapEth) {
    throw new ConfigError(
      `MIN_MARKET_CAP_ETH (${minMarketCapEth}) cannot be greater than MAX_MARKET_CAP_ETH (${maxMarketCapEth})`,
    );
  }

  let poolManagerAddress: string;
  try {
    poolManagerAddress = getAddress(optional('POOL_MANAGER_ADDRESS') ?? DEFAULT_POOL_MANAGER);
  } catch {
    throw new ConfigError('POOL_MANAGER_ADDRESS is not a valid address');
  }

  return {
    ...chain,
    poolManagerAddress,
    enableGraduationAlerts: boolean('ENABLE_GRADUATION_ALERTS', true),
    graduationMultiplier: number('GRADUATION_MULTIPLIER', 10, 1.1, 10000),
    graduationCheckIntervalMs: integer('GRADUATION_CHECK_INTERVAL_MS', 2400, 500),
    dryRun,
    postToChannel,
    fastChannelTextFirst: boolean('FAST_CHANNEL_TEXT_FIRST', true),
    userFiltersFile: optional('USER_FILTERS_FILE') ?? './data/users.json',
    // Telegram credentials are only needed when actually posting.
    telegramBotToken: dryRun ? optional('TELEGRAM_BOT_TOKEN') ?? '' : required('TELEGRAM_BOT_TOKEN'),
    telegramChannelId:
      dryRun || !postToChannel
        ? optional('TELEGRAM_CHANNEL_ID') ?? ''
        : required('TELEGRAM_CHANNEL_ID'),
    verifyFreshDeploy: boolean('VERIFY_FRESH_DEPLOY', true),
    pollIntervalMs: integer('POLL_INTERVAL_MS', 600, 200),
    confirmations: integer('CONFIRMATIONS', 0, 0),
    startBlock: startBlockRaw === undefined ? undefined : integer('START_BLOCK', 0, 0),
    explorerUrl: optional('EXPLORER_URL')?.replace(/\/+$/, ''),
    tokenUrlTemplate: optional('TOKEN_URL_TEMPLATE') ?? DEFAULT_TRADE_URL_TEMPLATE,
    includeImageCard: boolean('INCLUDE_IMAGE_CARD', true),
    includeShareCard: boolean('INCLUDE_SHARE_CARD', true),
    enableBotCommands: boolean('ENABLE_BOT_COMMANDS', true),
    stateFile: optional('STATE_FILE') ?? './data/state.json',
    filters: {
      minMarketCapEth,
      maxMarketCapEth,
      minBuyTaxPct,
      maxBuyTaxPct,
      minInitialBuyEth: number('MIN_INITIAL_BUY_ETH', 0, 0),
      maxInitialBuyPct: number('MAX_INITIAL_BUY_PCT', 100, 0, 100),
      onlyEthPairs: boolean('ONLY_ETH_PAIRS', false),
    },
  };
}
