import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, ZeroAddress } from 'ethers';
import {
  SWAP_TOPIC,
  TOKEN_LAUNCHED_TOPIC,
  computeMarketCapFromTick,
  computePriceAndMarketCap,
  decodeSwapLog,
  decodeTokenLaunchedLog,
  extractCandidateAddresses,
  wordToAddress,
} from '../src/chain/extract';
import { evaluateLaunchFilters } from '../src/chain/launchDetails';
import {
  buildGraduatedInlineKeyboard,
  buildLaunchInlineKeyboard,
  escapeHtml,
  formatGraduatedMessage,
  formatLaunchMessage,
  formatShareCard,
} from '../src/telegram/format';
import {
  buildGraduatedCardSvg,
  buildLaunchCardSvg,
  generateGraduatedCardPng,
  generateLaunchCardPng,
} from '../src/telegram/imageCard';
import {
  UserFilterStore,
  createDefaultUserPrefs,
  describeUserFilters,
  evaluateGraduatedUserFilters,
  evaluateUserFilters,
} from '../src/store/userFilterStore';
import { StateStore } from '../src/store/stateStore';
import type { LaunchFilters, TokenGraduation, TokenLaunch } from '../src/types';

const pad = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const TOKEN = '0xAbCdEf0123456789aBcDeF0123456789abCD1111';
const CREATOR = '0x00F7524FB07e2707503Ba1C2Bb8bc4d6C5872AeE';
const OTHER = '0x1234567890123456789012345678901234567890';

test('wordToAddress decodes padded addresses and rejects non-addresses', () => {
  assert.equal(wordToAddress(pad(TOKEN)), TOKEN.toLowerCase());
  assert.equal(wordToAddress(pad('0x1111')), null, 'small integers are not addresses');
  assert.equal(wordToAddress('0x' + 'f'.repeat(64)), null, 'no zero padding');
  assert.equal(wordToAddress('0x1234'), null, 'wrong length');
});

test('extractCandidateAddresses finds suffix addresses in topics and data', () => {
  const log = {
    topics: [pad(TOKEN) /* topic0 is ignored */, pad(OTHER), pad(TOKEN)],
    data: pad(OTHER) + pad(TOKEN).slice(2) + pad('0x1111').slice(2),
  };
  const found = extractCandidateAddresses(log, '1111');
  assert.equal(found.length, 1, 'deduplicated, non-matching addresses ignored');
  assert.equal(found[0].toLowerCase(), TOKEN.toLowerCase());
});

test('extractCandidateAddresses ignores topic0', () => {
  const log = { topics: [pad(TOKEN)], data: '0x' };
  assert.deepEqual(extractCandidateAddresses(log, '1111'), []);
});

test('decodeTokenLaunchedLog decodes real Torch TokenLaunched event structure', () => {
  const coder = AbiCoder.defaultAbiCoder();
  const data = coder.encode(
    ['bytes32', 'uint256', 'uint24', 'uint256', 'tuple(uint16,uint16,uint16,uint16)', 'string', 'address'],
    [
      '0x2792178ef01fb8d7e8103047629890822ca87ea878a79e73d7deb543cfdb4bd3',
      200n,
      3000n,
      30n,
      [10000, 0, 0, 0],
      'https://ipfs.io/ipfs/QmTest',
      ZeroAddress,
    ],
  );
  const log = {
    topics: [TOKEN_LAUNCHED_TOPIC, pad(TOKEN), pad(CREATOR)],
    data,
  };
  const decoded = decodeTokenLaunchedLog(log);
  assert.ok(decoded);
  assert.equal(decoded.token.toLowerCase(), TOKEN.toLowerCase());
  assert.equal(decoded.launcher.toLowerCase(), CREATOR.toLowerCase());
  assert.equal(decoded.buyTaxBps, 200);
  assert.equal(decoded.lpFee, 3000);
  assert.equal(decoded.snipeDurationSec, 30);
  assert.equal(decoded.metadataUri, 'https://ipfs.io/ipfs/QmTest');
  assert.equal(decoded.quoteToken, ZeroAddress);
});

test('computeMarketCapFromTick computes 1.0 ETH mcap at standard Torch tick 207240', () => {
  const mcap = computeMarketCapFromTick(207240, true, 1_000_000_000, 18, 18);
  assert.ok(mcap !== null);
  assert.ok(Math.abs(mcap - 1.0) < 0.01, `expected ~1.0 ETH, got ${mcap}`);
});

test('evaluateLaunchFilters enforces market cap and buy tax range thresholds', () => {
  const sampleLaunch: TokenLaunch = {
    address: TOKEN,
    name: 'Orpo',
    symbol: 'ORPO',
    decimals: 18,
    totalSupply: 1_000_000_000,
    creator: CREATOR,
    quoteToken: ZeroAddress,
    quoteSymbol: 'ETH',
    buyTaxPct: 2,
    sellTaxPct: 0,
    snipeStartTaxPct: 80,
    snipeDurationSec: 30,
    lpFeePct: 0.3,
    marketCapQuote: 1.16,
    initialBuyQuote: 0.05,
    initialBuySupplyPct: 4.63,
    metadataUri: null,
    timestamp: 1793460063,
    blockNumber: 102651849,
    txHash: '0xabc',
  };

  const permissive: LaunchFilters = {
    minMarketCapEth: 0,
    maxMarketCapEth: 0,
    minBuyTaxPct: 0,
    maxBuyTaxPct: 100,
    minInitialBuyEth: 0,
    maxInitialBuyPct: 100,
    onlyEthPairs: false,
  };
  assert.equal(evaluateLaunchFilters(sampleLaunch, permissive), null);

  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, minMarketCapEth: 2.0 }) ?? '',
    /MIN_MARKET_CAP_ETH/,
  );
  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, maxMarketCapEth: 1.0 }) ?? '',
    /MAX_MARKET_CAP_ETH/,
  );
  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, minBuyTaxPct: 3.0 }) ?? '',
    /MIN_BUY_TAX_PCT/,
  );
  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, maxBuyTaxPct: 1.0 }) ?? '',
    /MAX_BUY_TAX_PCT/,
  );
  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, minInitialBuyEth: 0.1 }) ?? '',
    /MIN_INITIAL_BUY_ETH/,
  );
  assert.match(
    evaluateLaunchFilters(sampleLaunch, { ...permissive, maxInitialBuyPct: 3.0 }) ?? '',
    /MAX_INITIAL_BUY_PCT/,
  );
});

test('formatLaunchMessage, formatShareCard, and buildLaunchInlineKeyboard include shareable text and buttons', () => {
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
  const input = {
    address: TOKEN,
    name: 'Evil <script>',
    symbol: 'EVL',
    quoteSymbol: 'ETH',
    buyTaxPct: 2,
    sellTaxPct: 0,
    snipeStartTaxPct: 80,
    snipeDurationSec: 30,
    lpFeePct: 0.3,
    marketCapQuote: 1.16,
    marketCapUsd: 2610,
    initialBuyQuote: 0.05,
    initialBuySupplyPct: 4.63,
    creator: CREATOR,
    timestamp: 0,
    blockNumber: 1,
    txHash: '0xabc',
  };

  const shareCard = formatShareCard(input);
  assert.match(shareCard, /🔥 \$EVL \(Evil <script>\) — New Torch Launch/);
  assert.match(shareCard, /MCap: ~\$2,610 \(1\.16 ETH\) \| Tax: 2%\/0% \| Dev Buy: 0\.05 ETH/);
  assert.match(shareCard, new RegExp(`CA: ${TOKEN}`));
  assert.match(shareCard, new RegExp(`Trade: https://app\\.torchpad\\.fun/trade/robinhood/${TOKEN}`));

  const msg = formatLaunchMessage(input, { explorerUrl: 'https://explorer.example' });
  assert.match(msg, /NEW TORCH LAUNCH — \$EVL/);
  assert.match(msg, /Evil &lt;script&gt;/);
  assert.match(msg, new RegExp(TOKEN));
  assert.match(msg, /MCap:<\/b> ~\$2,610 \(1\.16 ETH\)/);
  assert.match(msg, /Dev Buy:<\/b> 0\.05 ETH \(4\.63% supply\)/);
  assert.match(msg, /Tax:<\/b> 2% Buy \/ 0% Sell/);
  assert.match(msg, /Anti-Snipe:<\/b> 80% → 2% over 30s/);
  assert.match(msg, /Liquidity locked · Verified Torch token/);
  assert.match(msg, /https:\/\/app\.torchpad\.fun\/trade\/robinhood\//);
  assert.doesNotMatch(msg, /<pre>/);
  assert.match(msg, /1970-01-01 00:00:00 UTC/);

  const kb = buildLaunchInlineKeyboard(input, { explorerUrl: 'https://explorer.example' });
  assert.equal(kb.length, 3);
  assert.match(kb[0][0].text, /Trade \$EVL on Torch/);
  assert.match(kb[0][0].url, /https:\/\/app\.torchpad\.fun\/trade\/robinhood\//);
  assert.match(kb[1][0].url, /https:\/\/x\.com\/intent\/tweet\?text=/);
  assert.match(kb[1][1].url, /https:\/\/t\.me\/share\/url\?url=/);

  // Tiny dev buy and supply % must never emit unescaped '<' in HTML mode
  const tinyMsg = formatLaunchMessage({
    ...input,
    initialBuyQuote: 0.00001,
    initialBuySupplyPct: 0.0001,
  });
  assert.match(tinyMsg, /Dev Buy:<\/b> 0\.00001 ETH \(&lt;0\.001% supply\)/);
});

test('generateLaunchCardPng renders a valid 1200x675 PNG with launch details', async () => {
  const input = {
    address: TOKEN,
    name: 'Arvo Protocol',
    symbol: 'ARVO',
    quoteSymbol: 'ETH',
    buyTaxPct: 3,
    sellTaxPct: 0,
    snipeStartTaxPct: 80,
    snipeDurationSec: 30,
    lpFeePct: 0.3,
    marketCapQuote: 2.52,
    marketCapUsd: 5670,
    initialBuyQuote: 0.05,
    initialBuySupplyPct: 4.63,
    timestamp: 1793463615,
    blockNumber: 1,
    txHash: '0xabc',
  };
  const svg = buildLaunchCardSvg(input);
  assert.match(svg, /\$ARVO/);
  assert.match(svg, /~\$5,670 \(2\.52 ETH\)/);
  assert.match(svg, /Liquidity Locked/);
  assert.match(svg, /TRADE ON TORCH/);

  const png = await generateLaunchCardPng(input);
  // PNG magic header: 89 50 4E 47 0D 0A 1A 0A
  assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');
  assert.ok(png.length > 10_000, 'PNG buffer has non-trivial size');
});

test('evaluateUserFilters and UserFilterStore enforce per-user filter settings', async () => {
  const sampleLaunch: TokenLaunch = {
    address: TOKEN,
    name: 'Orpo',
    symbol: 'ORPO',
    decimals: 18,
    totalSupply: 1_000_000_000,
    creator: CREATOR,
    quoteToken: ZeroAddress,
    quoteSymbol: 'ETH',
    buyTaxPct: 3,
    sellTaxPct: 0,
    snipeStartTaxPct: 80,
    snipeDurationSec: 30,
    lpFeePct: 0.3,
    marketCapQuote: 1.5,
    marketCapUsd: 3375,
    initialBuyQuote: 0.02,
    initialBuySupplyPct: 1.8,
    metadataUri: null,
    timestamp: 1793460063,
    blockNumber: 102651849,
    txHash: '0xabc',
  };

  // Default user receives everything
  const defaults = createDefaultUserPrefs(1001, '@alice');
  assert.equal(evaluateUserFilters(sampleLaunch, defaults), null);
  assert.match(describeUserFilters(defaults), /Default/);

  // User with higher minMarketCapEth is filtered out
  assert.match(
    evaluateUserFilters(sampleLaunch, { ...defaults, minMarketCapEth: 2.5 }) ?? '',
    /min 2\.5 ETH/,
  );

  // User with lower maxBuyTaxPct is filtered out
  assert.match(
    evaluateUserFilters(sampleLaunch, { ...defaults, maxBuyTaxPct: 2 }) ?? '',
    /max 2%/,
  );

  // User requiring anti-snipe passes when snipeDurationSec > 0, fails when 0
  assert.equal(
    evaluateUserFilters(sampleLaunch, { ...defaults, requireAntiSnipe: true }),
    null,
  );
  assert.match(
    evaluateUserFilters(
      { ...sampleLaunch, snipeDurationSec: 0 },
      { ...defaults, requireAntiSnipe: true },
    ) ?? '',
    /anti-snipe is disabled/,
  );

  // UserFilterStore persistence & reset check
  const storePath = `/tmp/torch-test-users-${Date.now()}.json`;
  const store = await UserFilterStore.load(storePath);
  await store.update(42, { minMarketCapEth: 1.2, maxBuyTaxPct: 5, requireAntiSnipe: true }, '@bob');
  assert.equal(store.subscriberCount, 1);

  const reloaded = await UserFilterStore.load(storePath);
  const bob = reloaded.get(42);
  assert.ok(bob);
  assert.equal(bob.minMarketCapEth, 1.2);
  assert.equal(bob.maxBuyTaxPct, 5);
  assert.equal(bob.requireAntiSnipe, true);

  const resetBob = await reloaded.reset(42);
  assert.equal(resetBob.minMarketCapEth, 0);
  assert.equal(resetBob.maxBuyTaxPct, 100);
  assert.equal(resetBob.requireAntiSnipe, false);
  assert.equal(resetBob.graduatedAlerts, true);
  assert.equal(resetBob.minGraduatedMultiplier, 10);
});

test('graduation (~10x Launch Complete) tracking, formatting, card rendering, and user filters work end-to-end', async () => {
  const poolId = '0x7bcc71e5efa1ef16f1ae01a1ddccf1163d47a14b2320cba8c35017c641e65e0e';
  const statePath = `/tmp/torch-test-state-${Date.now()}.json`;
  const store = await StateStore.load(statePath);

  const launch: TokenLaunch = {
    address: TOKEN,
    poolId,
    name: 'Boomer',
    symbol: 'BOOMER',
    decimals: 18,
    totalSupply: 1_000_000_000,
    creator: CREATOR,
    quoteToken: ZeroAddress,
    quoteSymbol: 'ETH',
    quoteDecimals: 18,
    quoteIsCurrency0: true,
    buyTaxPct: 2.7,
    sellTaxPct: 0,
    snipeStartTaxPct: 80,
    snipeDurationSec: 30,
    lpFeePct: 0.3,
    marketCapQuote: 1.0,
    marketCapUsd: 2270,
    initialBuyQuote: 0.005,
    initialBuySupplyPct: 0.5,
    metadataUri: null,
    timestamp: 1793500000,
    blockNumber: 103278361,
    txHash: '0xlaunchtx',
  };

  const tracked = store.trackLaunch(launch);
  assert.ok(tracked);
  assert.equal(tracked.graduated, false);
  assert.equal(tracked.initialMarketCapQuote, 1.0);

  // At tick 183800 (~10.42x above tick 207240), mcap should be ~10.42 ETH
  const coder = AbiCoder.defaultAbiCoder();
  const swapData = coder.encode(
    ['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'],
    [-100000000000000000n, 9000000000000000000000000n, 0n, 1000000n, 183800, 3000],
  );
  const decodedSwap = decodeSwapLog({
    topics: [SWAP_TOPIC, poolId, pad(CREATOR)],
    data: swapData,
  });
  assert.ok(decodedSwap);
  assert.equal(decodedSwap.poolId, poolId);
  assert.equal(decodedSwap.tick, 183800);

  const metrics = computePriceAndMarketCap(decodedSwap.tick, true, 1_000_000_000, 18, 18);
  assert.ok(metrics);
  assert.ok(metrics.marketCapQuote > 10.3 && metrics.marketCapQuote < 10.5);

  const updated = store.updateTokenPrice(poolId, metrics.priceQuote, metrics.marketCapQuote);
  assert.ok(updated);
  assert.ok(updated.multiple >= 10.3);

  store.markGraduated(poolId, updated.multiple, 1793500500, '0xgradtx', [1001]);
  assert.equal(store.getTrackedByPoolId(poolId)?.graduated, true);
  assert.deepEqual(store.getTrackedByPoolId(poolId)?.notifiedUserIds, [1001]);

  const grad: TokenGraduation = {
    address: TOKEN,
    poolId,
    name: 'Boomer',
    symbol: 'BOOMER',
    quoteToken: ZeroAddress,
    quoteSymbol: 'ETH',
    initialMarketCapQuote: 1.0,
    initialMarketCapUsd: 2270,
    currentMarketCapQuote: metrics.marketCapQuote,
    currentMarketCapUsd: metrics.marketCapQuote * 2270,
    currentPriceQuote: metrics.priceQuote,
    currentPriceUsd: metrics.priceQuote * 2270,
    multiple: updated.multiple,
    buyTaxPct: 2.7,
    sellTaxPct: 0,
    launchedAt: 1793500000,
    graduatedAt: 1793500500,
    blockNumber: 103279000,
    txHash: '0xgradtx',
    isFirstChannelGraduation: true,
    alreadyNotifiedUserIds: new Set(),
  };

  // User filter checks (/graduated on|off and /setminx)
  const defaultPrefs = createDefaultUserPrefs(1001, '@alice');
  assert.equal(evaluateGraduatedUserFilters(grad, defaultPrefs), null);
  assert.match(
    evaluateGraduatedUserFilters(grad, { ...defaultPrefs, graduatedAlerts: false }) ?? '',
    /graduated alerts disabled/,
  );
  assert.match(
    evaluateGraduatedUserFilters(grad, { ...defaultPrefs, minGraduatedMultiplier: 15 }) ?? '',
    /min 15x/,
  );

  // Formatting & PNG card checks
  const gradMsg = formatGraduatedMessage(grad, { explorerUrl: 'https://explorer.example' });
  assert.match(gradMsg, /TORCH LAUNCH COMPLETE — \$BOOMER GRADUATED!/);
  assert.match(gradMsg, /10\.4x from Launch!/);
  assert.match(gradMsg, /Current MCap:/);
  assert.match(gradMsg, /Current Price:/);

  const gradKb = buildGraduatedInlineKeyboard(grad);
  assert.equal(gradKb.length, 2);
  assert.match(gradKb[0][0].text, /Trade \$BOOMER on Torch/);

  const gradSvg = buildGraduatedCardSvg(grad);
  assert.match(gradSvg, /LAUNCH COMPLETE · GRADUATED/);
  const gradPng = await generateGraduatedCardPng(grad);
  assert.equal(gradPng.subarray(0, 4).toString('hex'), '89504e47');
});
