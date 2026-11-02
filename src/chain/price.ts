/**
 * Fetches and caches the live ETH/USD spot price from public APIs
 * (Coinbase -> Binance -> CoinGecko) so Market Cap can be displayed in USD ($).
 *
 * Keeps the price warm in the background so `buildTokenLaunch` never blocks
 * on external HTTP price feeds during a real-time launch.
 */

const CACHE_TTL_MS = 45_000;
const FETCH_TIMEOUT_MS = 2_500;

let cachedPrice: number | null = null;
let cachedAt = 0;
let inFlightRefresh: Promise<number | null> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function tryCoinbase(): Promise<number | null> {
  const res = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { amount?: string } };
  const n = Number(json.data?.amount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function tryBinance(): Promise<number | null> {
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { price?: string };
  const n = Number(json.price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function tryCoinGecko(): Promise<number | null> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { ethereum?: { usd?: number } };
  const n = Number(json.ethereum?.usd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function refreshNow(): Promise<number | null> {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      for (const provider of [tryCoinbase, tryBinance, tryCoinGecko]) {
        try {
          const price = await provider();
          if (price !== null) {
            cachedPrice = price;
            cachedAt = Date.now();
            return price;
          }
        } catch {
          // Try next endpoint.
        }
      }
      return cachedPrice;
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

/**
 * Returns the cached ETH/USD spot price synchronously in 0ms.
 * If the cache is stale, triggers a non-blocking background refresh.
 */
export function getCachedEthUsdPrice(): number | null {
  if (Date.now() - cachedAt >= CACHE_TTL_MS) {
    void refreshNow();
  }
  return cachedPrice;
}

/**
 * Warms up the ETH/USD cache immediately and starts a background timer
 * so live launches always read the price in 0ms from memory.
 */
export async function startEthPriceRefresher(): Promise<void> {
  await refreshNow();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshNow();
    }, CACHE_TTL_MS);
    refreshTimer.unref?.();
  }
}

export function stopEthPriceRefresher(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Returns the live ETH/USD price. If a cached price already exists (even if
 * slightly stale), returns it immediately in 0ms while refreshing in the background.
 */
export async function fetchEthUsdPrice(): Promise<number | null> {
  if (cachedPrice !== null) {
    if (Date.now() - cachedAt >= CACHE_TTL_MS) {
      void refreshNow();
    }
    return cachedPrice;
  }
  return refreshNow();
}

