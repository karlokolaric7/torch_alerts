/**
 * Formats launch alerts as a single unified Telegram message (image card + HTML caption),
 * generates the share text for the X / Telegram share buttons, and builds the
 * inline keyboard buttons (Trade on Torch, Share on X, Share on TG, Explorer).
 */
import { DEFAULT_TRADE_URL_TEMPLATE } from '../config';
import type { TokenGraduation, TokenLaunch } from '../types';

export interface FormatOptions {
  explorerUrl?: string;
  tokenUrlTemplate?: string;
  /** Whether to attach a generated PNG launch card image (default true). */
  includeImageCard?: boolean;
  /** Optional public URL of the uploaded PNG launch card so X/TG shares embed the card. */
  cardImageUrl?: string | null;
}

export type FormatLaunchInput = Partial<TokenLaunch> &
  Pick<TokenLaunch, 'address' | 'name' | 'symbol' | 'timestamp' | 'blockNumber' | 'txHash'>;

/** Escapes text for Telegram's HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Computes the visible character length of a Telegram HTML string (excluding HTML tags). */
export function visibleHtmlLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').length;
}

function formatUtc(unixSeconds: number): string {
  // e.g. "2026-10-31 14:42:08 UTC"
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function formatNumber(n: number, maxDecimals = 2): string {
  if (!Number.isFinite(n)) return '0';
  const minThreshold = 10 ** -Math.max(3, maxDecimals);
  if (n > 0 && n < minThreshold) return `<${minThreshold.toFixed(Math.max(3, maxDecimals))}`;
  if (n >= 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
  const fixed = n.toFixed(maxDecimals);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (usd >= 100) {
    return `$${Math.round(usd).toLocaleString('en-US')}`;
  }
  return `$${usd.toFixed(2)}`;
}

/**
 * Formats Market Cap with USD ($) first and ETH/quote in parentheses next to it:
 * e.g. "~$5,670 (2.52 ETH)" or "~2.52 ETH" if USD price is unavailable.
 */
export function formatMarketCapDisplay(launch: FormatLaunchInput): string | null {
  if (launch.marketCapQuote === undefined || launch.marketCapQuote === null) {
    return null;
  }
  const quote = launch.quoteSymbol ?? 'ETH';
  const quotePart = `${formatNumber(launch.marketCapQuote, 2)} ${quote}`;
  if (launch.marketCapUsd !== undefined && launch.marketCapUsd !== null && launch.marketCapUsd > 0) {
    return `~${formatUsd(launch.marketCapUsd)} (${quotePart})`;
  }
  return `~${quotePart}`;
}

/** Formats a small per-token price without scientific notation (e.g. "0.0000236"). */
export function formatSmallPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1) return formatNumber(n, 4);
  if (n >= 0.0001) {
    return n.toFixed(6).replace(/\.?0+$/, '');
  }
  const fixed = n.toFixed(12);
  const match = fixed.match(/^0\.(0*)([1-9]\d*)$/);
  if (!match) return fixed.replace(/\.?0+$/, '');
  const leadingZeros = match[1];
  const sigDigits = match[2].slice(0, 3).replace(/0+$/, '');
  return `0.${leadingZeros}${sigDigits || match[2][0]}`;
}

/**
 * Formats a token price with USD ($) first and ETH/quote in parentheses:
 * e.g. "~$0.0000236 (0.0000000104 ETH)".
 */
export function formatTokenPriceDisplay(
  priceQuote: number,
  quoteSymbol = 'ETH',
  priceUsd?: number | null,
): string {
  const quotePart = `${formatSmallPrice(priceQuote)} ${quoteSymbol}`;
  if (priceUsd !== undefined && priceUsd !== null && priceUsd > 0) {
    return `~$${formatSmallPrice(priceUsd)} (${quotePart})`;
  }
  return `~${quotePart}`;
}

function shortAddress(addr: string): string {
  return addr.length >= 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Resolves the direct Trade on Torch URL for a token address. */
export function resolveTradeUrl(address: string, tokenUrlTemplate?: string): string {
  const rawTemplate = tokenUrlTemplate || DEFAULT_TRADE_URL_TEMPLATE;
  const normalized = rawTemplate.replace(
    'https://app.torchpad.fun/trade/{address}',
    DEFAULT_TRADE_URL_TEMPLATE,
  );
  return normalized.replace(/\{address\}/g, address);
}

/**
 * Generates the share text used by the "Share on X" and "Share on TG" buttons.
 * Includes the same stats as the alert card plus the public card image URL if available.
 */
export function formatShareCard(launch: FormatLaunchInput, opts: FormatOptions = {}): string {
  const ticker = launch.symbol ? `$${launch.symbol}` : '$???';
  const namePart = launch.name ? ` (${launch.name})` : '';
  const quote = launch.quoteSymbol ?? 'ETH';
  const tradeUrl = resolveTradeUrl(launch.address, opts.tokenUrlTemplate);
  const mcapStr = formatMarketCapDisplay(launch);

  const stats: string[] = [];
  if (mcapStr) {
    stats.push(`MCap: ${mcapStr}`);
  }
  if (launch.buyTaxPct !== undefined && launch.buyTaxPct !== null) {
    const sellStr =
      launch.sellTaxPct !== undefined && launch.sellTaxPct !== null
        ? `/${formatNumber(launch.sellTaxPct, 2)}%`
        : '';
    stats.push(`Tax: ${formatNumber(launch.buyTaxPct, 2)}%${sellStr}`);
  }
  if (launch.initialBuyQuote !== undefined && launch.initialBuyQuote !== null && launch.initialBuyQuote > 0) {
    stats.push(`Dev Buy: ${formatNumber(launch.initialBuyQuote, 3)} ${quote}`);
  }
  if (launch.snipeDurationSec !== undefined && launch.snipeDurationSec !== null && launch.snipeDurationSec > 0) {
    const startPct =
      launch.snipeStartTaxPct !== undefined && launch.snipeStartTaxPct !== null
        ? `${formatNumber(launch.snipeStartTaxPct, 0)}%→${formatNumber(launch.buyTaxPct ?? 0, 2)}% `
        : '';
    stats.push(`Anti-Snipe: ${startPct}(${launch.snipeDurationSec}s)`);
  }

  const suffix = launch.address.slice(-4);
  const lines = [
    `🔥 ${ticker}${namePart} — New Torch Launch (Robinhood Chain)`,
  ];
  if (stats.length > 0) {
    lines.push(`📊 ${stats.join(' | ')}`);
  }
  lines.push(`🔒 Liquidity Locked · Verified Torch (…${suffix})`);
  lines.push(`📋 CA: ${launch.address}`);
  lines.push(`🚀 Trade: ${tradeUrl}`);
  if (opts.cardImageUrl) {
    lines.push(`🖼 Card: ${opts.cardImageUrl}`);
  }
  return lines.join('\n');
}

/**
 * Formats the primary Telegram HTML alert caption.
 * Designed to fit cleanly inside the `sendPhoto` caption (< 1024 visible chars)
 * so the image card and the alert text are always sent as ONE single message.
 */
export function formatLaunchMessage(
  launch: FormatLaunchInput,
  opts: FormatOptions = {},
): string {
  const name = launch.name ? escapeHtml(launch.name) : '<i>Unknown</i>';
  const rawTicker = launch.symbol ? `$${escapeHtml(launch.symbol)}` : '$???';
  const quote = escapeHtml(launch.quoteSymbol ?? 'ETH');
  const pairLabel = launch.symbol ? `${escapeHtml(launch.symbol)}/${quote}` : quote;
  const tradeUrl = resolveTradeUrl(launch.address, opts.tokenUrlTemplate);
  const mcapStr = formatMarketCapDisplay(launch);

  const lines: string[] = [
    `🔥 <b>NEW TORCH LAUNCH — ${rawTicker}</b>`,
    `🪙 <b>${name}</b> (<b>${rawTicker}</b>)  ·  <b>Pair:</b> ${pairLabel}`,
    '',
    '📋 <b>CA (Tap to Copy):</b>',
    `<code>${escapeHtml(launch.address)}</code>`,
    '',
    '🚀 <b>Trade on Torch:</b>',
    `<a href="${escapeHtml(tradeUrl)}">${escapeHtml(tradeUrl)}</a>`,
    '',
  ];

  // Market Cap ($ first, ETH in parentheses next to it) + Initial Dev Buy
  if (mcapStr) {
    lines.push(`📊 <b>MCap:</b> ${escapeHtml(mcapStr)}`);
  }

  if (launch.initialBuyQuote !== undefined && launch.initialBuyQuote !== null) {
    if (launch.initialBuyQuote > 0) {
      const pctSuffix =
        launch.initialBuySupplyPct !== undefined &&
        launch.initialBuySupplyPct !== null &&
        launch.initialBuySupplyPct > 0
          ? ` (${escapeHtml(formatNumber(launch.initialBuySupplyPct, 2))}% supply)`
          : '';
      lines.push(
        `💰 <b>Dev Buy:</b> ${escapeHtml(formatNumber(launch.initialBuyQuote, 5))} ${quote}${pctSuffix}`,
      );
    } else {
      lines.push(`💰 <b>Dev Buy:</b> None (0 ${quote})`);
    }
  }

  // Buy / Sell Tax + LP Fee line
  const taxParts: string[] = [];
  if (launch.buyTaxPct !== undefined && launch.buyTaxPct !== null) {
    const sellStr =
      launch.sellTaxPct !== undefined && launch.sellTaxPct !== null
        ? ` / ${escapeHtml(formatNumber(launch.sellTaxPct, 2))}% Sell`
        : '';
    taxParts.push(`<b>Tax:</b> ${escapeHtml(formatNumber(launch.buyTaxPct, 2))}% Buy${sellStr}`);
  }
  if (launch.lpFeePct !== undefined && launch.lpFeePct !== null) {
    taxParts.push(`<b>LP Fee:</b> ${escapeHtml(formatNumber(launch.lpFeePct, 2))}%`);
  }
  if (taxParts.length > 0) {
    lines.push(`🏷 ${taxParts.join('  ·  ')}`);
  }

  // Anti-snipe protection line
  if (launch.snipeDurationSec !== undefined && launch.snipeDurationSec !== null && launch.snipeDurationSec > 0) {
    const startStr =
      launch.snipeStartTaxPct !== undefined && launch.snipeStartTaxPct !== null
        ? `${escapeHtml(formatNumber(launch.snipeStartTaxPct, 0))}% → ${escapeHtml(formatNumber(launch.buyTaxPct ?? 0, 2))}% over `
        : '';
    lines.push(`🛡 <b>Anti-Snipe:</b> ${startStr}${launch.snipeDurationSec}s`);
  }

  // Creator + Timestamp
  if (launch.creator) {
    const shortCreator = escapeHtml(shortAddress(launch.creator));
    const creatorDisplay = opts.explorerUrl
      ? `<a href="${opts.explorerUrl}/address/${launch.creator}">${shortCreator}</a>`
      : `<code>${shortCreator}</code>`;
    lines.push(`👤 <b>Creator:</b> ${creatorDisplay}`);
  }
  lines.push(`🕒 <b>Time:</b> ${formatUtc(launch.timestamp)}`);

  // Liquidity lock + vanity verification note
  const suffix = launch.address.slice(-4);
  lines.push('', `🔒 <i>Liquidity locked · Verified Torch token (…${escapeHtml(suffix)})</i>`);

  // Action links row in message text
  const links: string[] = [`<a href="${escapeHtml(tradeUrl)}">🔥 <b>Trade on Torch</b></a>`];
  if (opts.explorerUrl) {
    links.push(`<a href="${opts.explorerUrl}/token/${launch.address}">🔍 Token</a>`);
    links.push(`<a href="${opts.explorerUrl}/tx/${launch.txHash}">🧾 Tx</a>`);
  }
  lines.push('', links.join('  |  '));

  return lines.join('\n');
}

/**
 * Builds Telegram inline keyboard buttons for 1-click trading on Torch
 * and 1-click sharing to X (Twitter) or other Telegram chats (embedding the launch card).
 */
export function buildLaunchInlineKeyboard(
  launch: FormatLaunchInput,
  opts: FormatOptions = {},
): { text: string; url: string }[][] {
  const ticker = launch.symbol ? `$${launch.symbol}` : 'Token';
  const tradeUrl = resolveTradeUrl(launch.address, opts.tokenUrlTemplate);
  const shareText = formatShareCard(launch, opts);

  const xShareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;

  // For Telegram's t.me/share/url, `url` is placed at the top and unfurled for its
  // image preview! Passing `opts.cardImageUrl` as `url` makes Telegram display the
  // exact same PNG launch card at the top of the shared message, while `text`
  // carries the full launch details and clickable Trade on Torch link.
  const tgPrimaryUrl = opts.cardImageUrl || tradeUrl;
  const tgBodyText = opts.cardImageUrl
    ? shareText.replace(/\n🖼 Card: .+$/, '')
    : shareText.replace(/\n🚀 Trade: .+$/, '');
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(tgPrimaryUrl)}&text=${encodeURIComponent(tgBodyText)}`;

  const rows: { text: string; url: string }[][] = [
    [{ text: `🔥 Trade ${ticker} on Torch`, url: tradeUrl }],
    [
      { text: '🐦 Share on X', url: xShareUrl },
      { text: '📲 Share on TG', url: tgShareUrl },
    ],
  ];

  if (opts.explorerUrl) {
    rows.push([
      { text: '🔍 Token Explorer', url: `${opts.explorerUrl}/token/${launch.address}` },
      { text: '🧾 Launch Tx', url: `${opts.explorerUrl}/tx/${launch.txHash}` },
    ]);
  }

  return rows;
}

/**
 * Generates the share text for a "Launch Complete" / Graduated (~10x) token alert.
 */
export function formatGraduatedShareCard(
  grad: TokenGraduation,
  opts: FormatOptions = {},
): string {
  const ticker = grad.symbol ? `$${grad.symbol}` : '$???';
  const namePart = grad.name ? ` (${grad.name})` : '';
  const multipleStr = `${formatNumber(grad.multiple, 1)}x`;
  const tradeUrl = resolveTradeUrl(grad.address, opts.tokenUrlTemplate);
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
    }) ?? `${formatNumber(grad.currentMarketCapQuote, 2)} ${grad.quoteSymbol}`;
  const currentPrice = formatTokenPriceDisplay(
    grad.currentPriceQuote,
    grad.quoteSymbol,
    grad.currentPriceUsd,
  );

  const lines = [
    `🎓 ${ticker}${namePart} — LAUNCH COMPLETE (${multipleStr} Graduated on Torch!)`,
    `📈 Multiple: ${multipleStr} | MCap: ${currentMcap} | Price: ${currentPrice}`,
    `📋 CA: ${grad.address}`,
    `🚀 Trade: ${tradeUrl}`,
  ];
  if (opts.cardImageUrl) {
    lines.push(`🖼 Card: ${opts.cardImageUrl}`);
  }
  return lines.join('\n');
}

/**
 * Formats the Telegram HTML alert message when a Torch token reaches the
 * "Launch Complete" / Graduated (~10x starting market cap) milestone.
 */
export function formatGraduatedMessage(
  grad: TokenGraduation,
  opts: FormatOptions = {},
): string {
  const name = grad.name ? escapeHtml(grad.name) : '<i>Unknown</i>';
  const rawTicker = grad.symbol ? `$${escapeHtml(grad.symbol)}` : '$???';
  const multipleStr = escapeHtml(formatNumber(grad.multiple, 1));
  const tradeUrl = resolveTradeUrl(grad.address, opts.tokenUrlTemplate);

  const initialMcapStr =
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
    }) ?? `${formatNumber(grad.initialMarketCapQuote, 2)} ${grad.quoteSymbol}`;

  const currentMcapStr =
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
    }) ?? `${formatNumber(grad.currentMarketCapQuote, 2)} ${grad.quoteSymbol}`;

  const currentPriceStr = formatTokenPriceDisplay(
    grad.currentPriceQuote,
    grad.quoteSymbol,
    grad.currentPriceUsd,
  );

  const lines: string[] = [
    `🎓 <b>TORCH LAUNCH COMPLETE — ${rawTicker} GRADUATED!</b> 🚀`,
    `🏆 <b>${name}</b> (<b>${rawTicker}</b>)  ·  <b>${multipleStr}x from Launch!</b>`,
    '',
    '📋 <b>CA (Tap to Copy):</b>',
    `<code>${escapeHtml(grad.address)}</code>`,
    '',
    '🚀 <b>Trade on Torch:</b>',
    `<a href="${escapeHtml(tradeUrl)}">${escapeHtml(tradeUrl)}</a>`,
    '',
    `📈 <b>Multiple:</b> <b>${multipleStr}x</b> (from ${escapeHtml(initialMcapStr)} launch)`,
    `💎 <b>Current MCap:</b> ${escapeHtml(currentMcapStr)}`,
    `💵 <b>Current Price:</b> ${escapeHtml(currentPriceStr)}`,
    `🕒 <b>Graduated At:</b> ${formatUtc(grad.graduatedAt)}`,
    '',
    `🎓 <i>Launch Complete milestone reached · Verified Torch token (…${escapeHtml(grad.address.slice(-4))})</i>`,
  ];

  const links: string[] = [`<a href="${escapeHtml(tradeUrl)}">🔥 <b>Trade on Torch</b></a>`];
  if (opts.explorerUrl) {
    links.push(`<a href="${opts.explorerUrl}/token/${grad.address}">🔍 Token</a>`);
    links.push(`<a href="${opts.explorerUrl}/tx/${grad.txHash}">🧾 Tx</a>`);
  }
  lines.push('', links.join('  |  '));

  return lines.join('\n');
}

/**
 * Builds inline keyboard buttons for a Graduated / Launch Complete alert.
 */
export function buildGraduatedInlineKeyboard(
  grad: TokenGraduation,
  opts: FormatOptions = {},
): { text: string; url: string }[][] {
  const ticker = grad.symbol ? `$${grad.symbol}` : 'Token';
  const tradeUrl = resolveTradeUrl(grad.address, opts.tokenUrlTemplate);
  const shareText = formatGraduatedShareCard(grad, opts);

  const xShareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
  const tgPrimaryUrl = opts.cardImageUrl || tradeUrl;
  const tgBodyText = opts.cardImageUrl
    ? shareText.replace(/\n🖼 Card: .+$/, '')
    : shareText.replace(/\n🚀 Trade: .+$/, '');
  const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(tgPrimaryUrl)}&text=${encodeURIComponent(tgBodyText)}`;

  const rows: { text: string; url: string }[][] = [
    [{ text: `🔥 Trade ${ticker} on Torch`, url: tradeUrl }],
    [
      { text: '🐦 Share on X', url: xShareUrl },
      { text: '📲 Share on TG', url: tgShareUrl },
    ],
  ];

  if (opts.explorerUrl) {
    rows.push([
      { text: '🔍 Token Explorer', url: `${opts.explorerUrl}/token/${grad.address}` },
      { text: '🧾 Graduating Tx', url: `${opts.explorerUrl}/tx/${grad.txHash}` },
    ]);
  }

  return rows;
}
