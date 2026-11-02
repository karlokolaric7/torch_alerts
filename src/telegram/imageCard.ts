/**
 * Generates a clean, dark-themed 1200x675 PNG share card for each Torch launch
 * using `sharp` (SVG -> PNG). Designed to be fast (~20ms), mobile-readable,
 * and ready to share on X (Twitter) and Telegram.
 */
import sharp from 'sharp';
import {
  formatMarketCapDisplay,
  formatTokenPriceDisplay,
  type FormatLaunchInput,
} from './format';
import type { TokenGraduation } from '../types';

const WIDTH = 1200;
const HEIGHT = 675;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function formatNum(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return '0';
  if (n > 0 && n < 0.001) return '<0.001';
  if (n >= 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
  const fixed = n.toFixed(maxDecimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

function formatUtcShort(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * Builds the SVG markup for a Torch launch card.
 * Exported for unit testing as well as PNG rendering.
 */
export function buildLaunchCardSvg(launch: FormatLaunchInput): string {
  const rawTicker = launch.symbol ? `$${launch.symbol}` : '$TOKEN';
  const ticker = escapeXml(truncate(rawTicker, 14));
  const name = escapeXml(truncate(launch.name || 'Unknown Token', 32));
  const quote = escapeXml(launch.quoteSymbol ?? 'ETH');
  const pair = escapeXml(
    launch.symbol ? `${truncate(launch.symbol, 10)} / ${launch.quoteSymbol ?? 'ETH'}` : quote,
  );

  // Stat 1: Market Cap ($ first, ETH in parentheses) + Dev Buy subtitle
  const mcapDisplay = formatMarketCapDisplay(launch);
  const mcapValue = mcapDisplay ?? `New Pool (${quote})`;
  const mcapFontSize = mcapValue.length > 16 ? 31 : 36;

  let devBuySub = `Dev Buy: None (0 ${quote})`;
  if (launch.initialBuyQuote !== undefined && launch.initialBuyQuote !== null && launch.initialBuyQuote > 0) {
    const pct =
      launch.initialBuySupplyPct !== undefined &&
      launch.initialBuySupplyPct !== null &&
      launch.initialBuySupplyPct > 0
        ? ` (${formatNum(launch.initialBuySupplyPct, 1)}% supply)`
        : '';
    devBuySub = `Dev Buy: ${formatNum(launch.initialBuyQuote, 3)} ${quote}${pct}`;
  }

  // Stat 2: Buy / Sell Tax + LP Fee subtitle
  const buyTaxStr =
    launch.buyTaxPct !== undefined && launch.buyTaxPct !== null
      ? `${formatNum(launch.buyTaxPct, 2)}%`
      : '0%';
  const sellTaxStr =
    launch.sellTaxPct !== undefined && launch.sellTaxPct !== null
      ? `${formatNum(launch.sellTaxPct, 2)}%`
      : '0%';
  const taxValue = `${buyTaxStr} Buy / ${sellTaxStr} Sell`;
  const lpFeeSub =
    launch.lpFeePct !== undefined && launch.lpFeePct !== null
      ? `Pool LP Fee: ${formatNum(launch.lpFeePct, 2)}%`
      : 'Standard Torch Pool';

  // Stat 3: Anti-Snipe
  let snipeValue = 'None (0s)';
  let snipeSub = 'Immediate standard tax';
  if (launch.snipeDurationSec !== undefined && launch.snipeDurationSec !== null && launch.snipeDurationSec > 0) {
    const startPct =
      launch.snipeStartTaxPct !== undefined && launch.snipeStartTaxPct !== null
        ? `${formatNum(launch.snipeStartTaxPct, 0)}% → ${buyTaxStr}`
        : `${launch.snipeDurationSec}s Window`;
    snipeValue = startPct;
    snipeSub = `Decays over ${launch.snipeDurationSec}s after launch`;
  }

  // Stat 4: Security / Lock
  const suffix = escapeXml(launch.address.slice(-4));
  const addressFull = escapeXml(launch.address);
  const addressPrefix = escapeXml(launch.address.slice(0, -4));
  const timeStr = escapeXml(formatUtcShort(launch.timestamp));

  // Scale hero ticker font size if ticker is long
  const tickerFontSize = rawTicker.length > 9 ? 54 : 68;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#090D16"/>
      <stop offset="55%" stop-color="#0F172A"/>
      <stop offset="100%" stop-color="#131C31"/>
    </linearGradient>
    <radialGradient id="glowOrange" cx="88%" cy="12%" r="45%">
      <stop offset="0%" stop-color="#FF6B2B" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#FF6B2B" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowGreen" cx="12%" cy="88%" r="45%">
      <stop offset="0%" stop-color="#10B981" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#10B981" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="torchGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#FF5E1A"/>
      <stop offset="100%" stop-color="#FF9F1C"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#162038"/>
      <stop offset="100%" stop-color="#11182B"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowOrange)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowGreen)"/>

  <!-- Outer Frame -->
  <rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="24" fill="none" stroke="#26334D" stroke-width="2"/>

  <!-- Top Bar: Torch Brand + Chain Pill + Timestamp -->
  <rect x="56" y="52" width="248" height="42" rx="21" fill="url(#torchGrad)"/>
  <text x="180" y="79" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="bold" fill="#090D16" text-anchor="middle" letter-spacing="1">TORCH LAUNCHPAD</text>

  <rect x="318" y="52" width="218" height="42" rx="21" fill="#172542" stroke="#2D426B" stroke-width="1.5"/>
  <text x="427" y="79" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#38BDF8" text-anchor="middle" letter-spacing="0.8">ROBINHOOD CHAIN</text>

  <text x="1144" y="79" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#94A3B8" text-anchor="end">${timeStr}</text>

  <!-- Hero Section: Ticker, Name, Pair -->
  <text x="56" y="176" font-family="DejaVu Sans, sans-serif" font-size="${tickerFontSize}" font-weight="bold" fill="#FFFFFF">${ticker}</text>
  <text x="56" y="220" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="bold" fill="#CBD5E1">${name}</text>

  <rect x="930" y="132" width="214" height="52" rx="14" fill="#172542" stroke="#334E7D" stroke-width="1.5"/>
  <text x="1037" y="165" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#F8FAFC" text-anchor="middle">${pair}</text>

  <!-- 2x2 Key Stats Grid -->
  <!-- Box 1: Starting Market Cap -->
  <rect x="56" y="248" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#263554" stroke-width="1.5"/>
  <text x="84" y="284" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#94A3B8" letter-spacing="1">STARTING MARKET CAP</text>
  <text x="84" y="330" font-family="DejaVu Sans, sans-serif" font-size="${mcapFontSize}" font-weight="bold" fill="#38BDF8">${escapeXml(mcapValue)}</text>
  <text x="84" y="358" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">${escapeXml(devBuySub)}</text>

  <!-- Box 2: Buy / Sell Tax -->
  <rect x="616" y="248" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#263554" stroke-width="1.5"/>
  <text x="644" y="284" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#94A3B8" letter-spacing="1">TAX (BUY / SELL)</text>
  <text x="644" y="330" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#F8FAFC">${escapeXml(taxValue)}</text>
  <text x="644" y="358" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">${escapeXml(lpFeeSub)}</text>

  <!-- Box 3: Anti-Snipe Protection -->
  <rect x="56" y="394" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#263554" stroke-width="1.5"/>
  <text x="84" y="430" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#94A3B8" letter-spacing="1">ANTI-SNIPE PROTECTION</text>
  <text x="84" y="476" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#FBBF24">${escapeXml(snipeValue)}</text>
  <text x="84" y="504" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">${escapeXml(snipeSub)}</text>

  <!-- Box 4: Security & Lock -->
  <rect x="616" y="394" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#1E463B" stroke-width="1.5"/>
  <text x="644" y="430" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#6EE7B7" letter-spacing="1">POOL SECURITY</text>
  <text x="644" y="476" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#34D399">Liquidity Locked</text>
  <text x="644" y="504" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#A7F3D0">Verified Torch Vanity Contract (…${suffix})</text>

  <!-- Contract Address Bar + Trade on Torch Branding -->
  <rect x="56" y="546" width="760" height="72" rx="16" fill="#0B111E" stroke="#263554" stroke-width="1.5"/>
  <text x="80" y="574" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="bold" fill="#64748B" letter-spacing="1">CONTRACT ADDRESS</text>
  <text x="80" y="602" font-family="DejaVu Sans Mono, monospace" font-size="21" font-weight="bold" fill="#E2E8F0">${addressPrefix}<tspan fill="#FF9F1C">${suffix}</tspan></text>

  <rect x="836" y="546" width="308" height="72" rx="16" fill="url(#torchGrad)"/>
  <text x="990" y="579" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#090D16" text-anchor="middle" letter-spacing="0.5">TRADE ON TORCH</text>
  <text x="990" y="603" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="bold" fill="#1E293B" text-anchor="middle">app.torchpad.fun</text>

  <!-- Accessibility title -->
  <title>${escapeXml(rawTicker)} (${name}) - ${addressFull}</title>
</svg>`;
}

/**
 * Renders the launch card to a PNG buffer via `sharp`.
 * Uses fast PNG compression (level 2) to cut rendering latency in half (~50ms).
 */
export async function generateLaunchCardPng(launch: FormatLaunchInput): Promise<Buffer> {
  const svg = buildLaunchCardSvg(launch);
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 2 })
    .toBuffer();
}

/**
 * Builds a distinct gold/emerald SVG share card for a Torch token that reached
 * the "Launch Complete" / Graduated (~10x starting market cap) milestone.
 */
export function buildGraduatedCardSvg(grad: TokenGraduation): string {
  const rawTicker = grad.symbol ? `$${grad.symbol}` : '$TOKEN';
  const ticker = escapeXml(truncate(rawTicker, 14));
  const name = escapeXml(truncate(grad.name || 'Unknown Token', 32));
  const multipleStr = `${formatNum(grad.multiple, 1)}x`;
  const timeStr = escapeXml(formatUtcShort(grad.graduatedAt));

  const currentMcap =
    formatMarketCapDisplay({
      address: grad.address,
      name: grad.name,
      symbol: grad.symbol,
      quoteSymbol: grad.quoteSymbol,
      marketCapQuote: grad.currentMarketCapQuote,
      marketCapUsd: grad.currentMarketCapUsd,
      timestamp: grad.graduatedAt,
      blockNumber: grad.blockNumber,
      txHash: grad.txHash,
    }) ?? `${formatNum(grad.currentMarketCapQuote, 2)} ${grad.quoteSymbol}`;

  const initialMcap =
    formatMarketCapDisplay({
      address: grad.address,
      name: grad.name,
      symbol: grad.symbol,
      quoteSymbol: grad.quoteSymbol,
      marketCapQuote: grad.initialMarketCapQuote,
      marketCapUsd: grad.initialMarketCapUsd,
      timestamp: grad.launchedAt,
      blockNumber: grad.blockNumber,
      txHash: grad.txHash,
    }) ?? `${formatNum(grad.initialMarketCapQuote, 2)} ${grad.quoteSymbol}`;

  const currentPrice = formatTokenPriceDisplay(
    grad.currentPriceQuote,
    grad.quoteSymbol,
    grad.currentPriceUsd,
  );

  const mcapFontSize = currentMcap.length > 16 ? 31 : 36;
  const priceFontSize = currentPrice.length > 20 ? 27 : 32;
  const tickerFontSize = rawTicker.length > 9 ? 54 : 68;
  const suffix = escapeXml(grad.address.slice(-4));
  const addressPrefix = escapeXml(grad.address.slice(0, -4));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#090D16"/>
      <stop offset="55%" stop-color="#131A2E"/>
      <stop offset="100%" stop-color="#1A162B"/>
    </linearGradient>
    <radialGradient id="glowGold" cx="85%" cy="15%" r="50%">
      <stop offset="0%" stop-color="#F59E0B" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="#F59E0B" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowEmerald" cx="15%" cy="85%" r="48%">
      <stop offset="0%" stop-color="#10B981" stop-opacity="0.24"/>
      <stop offset="100%" stop-color="#10B981" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="goldPill" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#FBBF24"/>
    </linearGradient>
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#18223A"/>
      <stop offset="100%" stop-color="#11182B"/>
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bgGrad)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowGold)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glowEmerald)"/>

  <rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="24" fill="none" stroke="#F59E0B" stroke-opacity="0.55" stroke-width="2.5"/>

  <!-- Top Bar -->
  <rect x="56" y="52" width="290" height="42" rx="21" fill="url(#goldPill)"/>
  <text x="201" y="79" font-family="DejaVu Sans, sans-serif" font-size="18" font-weight="bold" fill="#090D16" text-anchor="middle" letter-spacing="1">LAUNCH COMPLETE · GRADUATED</text>

  <rect x="360" y="52" width="218" height="42" rx="21" fill="#172542" stroke="#2D426B" stroke-width="1.5"/>
  <text x="469" y="79" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#38BDF8" text-anchor="middle" letter-spacing="0.8">ROBINHOOD CHAIN</text>

  <text x="1144" y="79" font-family="DejaVu Sans, sans-serif" font-size="18" fill="#94A3B8" text-anchor="end">${timeStr}</text>

  <!-- Hero Section -->
  <text x="56" y="176" font-family="DejaVu Sans, sans-serif" font-size="${tickerFontSize}" font-weight="bold" fill="#FFFFFF">${ticker}</text>
  <text x="56" y="220" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="bold" fill="#FDE68A">${name}</text>

  <rect x="900" y="124" width="244" height="68" rx="18" fill="#2A1F0D" stroke="#F59E0B" stroke-width="2"/>
  <text x="1022" y="170" font-family="DejaVu Sans, sans-serif" font-size="36" font-weight="bold" fill="#FBBF24" text-anchor="middle">${escapeXml(multipleStr)} 🚀</text>

  <!-- 2x2 Stats Grid -->
  <!-- Box 1: Current Market Cap -->
  <rect x="56" y="248" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#3B301C" stroke-width="1.5"/>
  <text x="84" y="284" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#FBBF24" letter-spacing="1">CURRENT MARKET CAP</text>
  <text x="84" y="330" font-family="DejaVu Sans, sans-serif" font-size="${mcapFontSize}" font-weight="bold" fill="#FFFFFF">${escapeXml(currentMcap)}</text>
  <text x="84" y="358" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">Launch MCap: ${escapeXml(initialMcap)}</text>

  <!-- Box 2: Multiple from Launch -->
  <rect x="616" y="248" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#3B301C" stroke-width="1.5"/>
  <text x="644" y="284" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#FBBF24" letter-spacing="1">MULTIPLE FROM LAUNCH</text>
  <text x="644" y="330" font-family="DejaVu Sans, sans-serif" font-size="38" font-weight="bold" fill="#34D399">${escapeXml(multipleStr)} Gain</text>
  <text x="644" y="358" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#A7F3D0">Torch Launch Complete Milestone Reached</text>

  <!-- Box 3: Current Token Price -->
  <rect x="56" y="394" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#263554" stroke-width="1.5"/>
  <text x="84" y="430" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#94A3B8" letter-spacing="1">CURRENT TOKEN PRICE</text>
  <text x="84" y="476" font-family="DejaVu Sans, sans-serif" font-size="${priceFontSize}" font-weight="bold" fill="#38BDF8">${escapeXml(currentPrice)}</text>
  <text x="84" y="504" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#94A3B8">Live Uniswap v4 Pool Price</text>

  <!-- Box 4: Pool Status -->
  <rect x="616" y="394" width="528" height="128" rx="18" fill="url(#cardGrad)" stroke="#1E463B" stroke-width="1.5"/>
  <text x="644" y="430" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#6EE7B7" letter-spacing="1">GRADUATION STATUS</text>
  <text x="644" y="476" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#34D399">Graduated · Locked</text>
  <text x="644" y="504" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#A7F3D0">Verified Torch Vanity Contract (…${suffix})</text>

  <!-- Bottom Bar -->
  <rect x="56" y="546" width="760" height="72" rx="16" fill="#0B111E" stroke="#3B301C" stroke-width="1.5"/>
  <text x="80" y="574" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="bold" fill="#94A3B8" letter-spacing="1">CONTRACT ADDRESS</text>
  <text x="80" y="602" font-family="DejaVu Sans Mono, monospace" font-size="21" font-weight="bold" fill="#E2E8F0">${addressPrefix}<tspan fill="#FBBF24">${suffix}</tspan></text>

  <rect x="836" y="546" width="308" height="72" rx="16" fill="url(#goldPill)"/>
  <text x="990" y="579" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#090D16" text-anchor="middle" letter-spacing="0.5">TRADE ON TORCH</text>
  <text x="990" y="603" font-family="DejaVu Sans, sans-serif" font-size="15" font-weight="bold" fill="#1E293B" text-anchor="middle">app.torchpad.fun</text>
</svg>`;
}

/**
 * Renders the Graduated / Launch Complete card to a PNG buffer via `sharp`.
 */
export async function generateGraduatedCardPng(grad: TokenGraduation): Promise<Buffer> {
  const svg = buildGraduatedCardSvg(grad);
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 2 })
    .toBuffer();
}

/**
 * Warms up `sharp` and the SVG font rasterizer at startup so the first launch
 * does not pay any cold-initialization latency.
 */
export async function warmupImageCardRenderer(): Promise<void> {
  try {
    await generateLaunchCardPng({
      address: '0x0000000000000000000000000000000000001111',
      name: 'Warmup',
      symbol: 'WARM',
      timestamp: Math.floor(Date.now() / 1000),
      blockNumber: 1,
      txHash: '0x0',
    });
  } catch {
    // Ignore warmup errors.
  }
}

/**
 * Uploads the generated PNG launch card to a public image host (catbox.moe with
 * uguu.se fallback) so that "Share on TG" and "Share on X" links unfurl the
 * exact same card image when shared. Never throws; returns null on failure/timeout.
 */
export async function uploadLaunchCardImage(pngBuffer: Buffer): Promise<string | null> {
  const blob = new Blob([new Uint8Array(pngBuffer)], { type: 'image/png' });

  // 1. Primary: catbox.moe (returns direct https://files.catbox.moe/xxxx.png URL)
  try {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', blob, 'torch-launch.png');
    const res = await fetch('https://catbox.moe/user/api.php', {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const url = (await res.text()).trim();
      if (/^https:\/\/files\.catbox\.moe\/.+\.png$/i.test(url)) {
        return url;
      }
    }
  } catch {
    // Fall through to backup host.
  }

  // 2. Fallback: uguu.se
  try {
    const fd = new FormData();
    fd.append('files[]', blob, 'torch-launch.png');
    const res = await fetch('https://uguu.se/upload', {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const json = (await res.json()) as { files?: { url?: string }[] };
      const url = json.files?.[0]?.url?.trim();
      if (url && /^https:\/\//i.test(url)) {
        return url;
      }
    }
  } catch {
    // Ignore upload errors; alert still posts with local PNG buffer.
  }

  return null;
}

