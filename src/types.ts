/** Shared domain types. */

/** Enriched details for a newly detected Torch token launch. */
export interface TokenLaunch {
  /** Checksummed token address (ends in the Torch suffix, e.g. ...1111). */
  address: string;
  /** ERC-20 name(), or null if it could not be read. */
  name: string | null;
  /** ERC-20 symbol(), or null if it could not be read. */
  symbol: string | null;
  /** Token decimals (default 18). */
  decimals: number;
  /** Total supply in human-readable token units (e.g. 1_000_000_000). */
  totalSupply: number | null;
  /** Creator / launcher address (checksummed), if known. */
  creator: string | null;
  /** Quote token address (0x000...0000 for native ETH). */
  quoteToken: string;
  /** Quote currency symbol (e.g. "ETH", "TORCH", "NVDA"). */
  quoteSymbol: string;
  /** Base buy tax percentage (e.g. 2 for 2%, from 200 bps). */
  buyTaxPct: number | null;
  /** Base sell tax percentage (e.g. 0 for 0%). */
  sellTaxPct: number | null;
  /** Anti-snipe starting tax percentage (e.g. 80 for 80%). */
  snipeStartTaxPct: number | null;
  /** Anti-snipe duration in seconds (e.g. 30). */
  snipeDurationSec: number | null;
  /** Pool LP fee percentage (e.g. 0.3 for 3000 = 0.30%). */
  lpFeePct: number | null;
  /** Starting market cap right after launch tx (in quote currency units, e.g. ETH). */
  marketCapQuote: number | null;
  /** Starting market cap converted to USD ($), if available. */
  marketCapUsd?: number | null;
  /** Initial creator buy amount in quote currency units (e.g. 0.05 ETH). */
  initialBuyQuote: number | null;
  /** Percentage of total supply bought in the launch transaction (0-100). */
  initialBuySupplyPct: number | null;
  /** Metadata URI (IPFS) emitted in TokenLaunched, if present. */
  metadataUri: string | null;
  /** Uniswap v4 bytes32 poolId emitted in TokenLaunched, used to track price & graduation. */
  poolId?: string | null;
  /** True if currency0 in the Uniswap v4 pool is the quote token (default true for ETH). */
  quoteIsCurrency0?: boolean;
  /** Decimals of the quote token (default 18 for ETH). */
  quoteDecimals?: number;
  /** Unix timestamp (seconds) of the launch. */
  timestamp: number;
  blockNumber: number;
  txHash: string;
  /** Wall-clock ms (Date.now()) when the bot received the on-chain launch event. */
  detectedAtMs?: number;
  /** Wall-clock ms (Date.now()) when on-chain enrichment finished. */
  enrichedAtMs?: number;
}

/** Persisted state for a launched Torch token being monitored for the ~10x "Launch Complete" milestone. */
export interface TrackedToken {
  address: string;
  poolId: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: number;
  quoteToken: string;
  quoteSymbol: string;
  quoteDecimals: number;
  quoteIsCurrency0: boolean;
  /** Initial starting market cap at launch (in quote currency, e.g. 1.0 ETH). */
  initialMarketCapQuote: number;
  /** Initial starting market cap in USD ($), if known. */
  initialMarketCapUsd: number | null;
  /** Latest observed market cap in quote currency units. */
  currentMarketCapQuote: number;
  /** Latest observed token price in quote currency units. */
  currentPriceQuote: number;
  /** Highest multiple (currentMarketCapQuote / initialMarketCapQuote) observed so far. */
  peakMultiple: number;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  launchedAt: number;
  launchBlock: number;
  launchTxHash: string;
  /** True once the token has crossed the global graduation threshold (~10x) and posted to channel. */
  graduated: boolean;
  graduatedAt?: number;
  graduatedMultiple?: number;
  graduatedTxHash?: string;
  /** User chatIds who have already received a graduated DM alert for this token. */
  notifiedUserIds: number[];
}

/** Enriched details for a Torch token that reached the "Launch Complete" / Graduated (~10x) milestone. */
export interface TokenGraduation {
  address: string;
  poolId: string;
  name: string | null;
  symbol: string | null;
  quoteToken: string;
  quoteSymbol: string;
  /** Initial launch market cap in quote currency units (e.g. 1.0 ETH). */
  initialMarketCapQuote: number;
  /** Initial launch market cap in USD ($), if available. */
  initialMarketCapUsd: number | null;
  /** Current market cap at graduation in quote currency units (e.g. 10.4 ETH). */
  currentMarketCapQuote: number;
  /** Current market cap at graduation in USD ($), if available. */
  currentMarketCapUsd: number | null;
  /** Current price per token in quote currency units (e.g. 0.0000000104 ETH). */
  currentPriceQuote: number;
  /** Current price per token in USD ($), if available (e.g. $0.0000236). */
  currentPriceUsd: number | null;
  /** Exact multiple from initial launch market cap (e.g. 10.4 for 10.4x). */
  multiple: number;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  launchedAt: number;
  graduatedAt: number;
  blockNumber: number;
  txHash: string;
  /** True when the token first crosses the global graduation threshold (triggers channel post). */
  isFirstChannelGraduation: boolean;
  /** User chatIds that were already notified for this token at a lower threshold. */
  alreadyNotifiedUserIds: Set<number>;
  detectedAtMs?: number;
}

/** Global channel launch filters configured via .env. */
export interface LaunchFilters {
  /** Minimum starting market cap in quote currency units (0 = disabled). */
  minMarketCapEth: number;
  /** Maximum starting market cap in quote currency units (0 = disabled). */
  maxMarketCapEth: number;
  /** Minimum base buy tax percentage, e.g. 1 for 1% (0 = disabled). */
  minBuyTaxPct: number;
  /** Maximum base buy tax percentage, e.g. 5 for 5% (100 = disabled). */
  maxBuyTaxPct: number;
  /** Minimum initial dev/creator buy in quote currency units (0 = disabled). */
  minInitialBuyEth: number;
  /** Maximum % of total supply bought in the launch tx (100 = disabled). */
  maxInitialBuyPct: number;
  /** Only alert on tokens paired against native ETH (false = allow all quote tokens). */
  onlyEthPairs: boolean;
}

/** Per-user filter preferences configured via Telegram commands. */
export interface UserFilterPrefs {
  /** Telegram private chat / user ID. */
  chatId: number;
  /** Optional Telegram @username or first name for readable logs. */
  username?: string;
  /** Whether the user is subscribed to DM launch alerts. */
  subscribed: boolean;
  /** Minimum starting market cap in ETH (0 = no minimum, receive all). */
  minMarketCapEth: number;
  /** Maximum buy tax percentage (100 = no limit, receive all). */
  maxBuyTaxPct: number;
  /** Only alert on launches with anti-snipe enabled (snipeDurationSec > 0). */
  requireAntiSnipe: boolean;
  /** Minimum initial creator/dev buy in ETH (0 = no minimum). */
  minInitialBuyEth: number;
  /** Whether to receive "Launch Complete" / Graduated (~10x) alerts (default true). */
  graduatedAlerts: boolean;
  /** Minimum multiple from initial launch market cap for graduated alerts (default 10 for 10x). */
  minGraduatedMultiplier: number;
  /** ISO timestamp when preferences were last updated. */
  updatedAt: string;
}

/** Something that can announce launches and graduations (Telegram, or console in dry-run mode). */
export interface Notifier {
  verify(): Promise<void>;
  postLaunch(launch: TokenLaunch): Promise<void>;
  postGraduation?(graduation: TokenGraduation): Promise<number[]>;
}
