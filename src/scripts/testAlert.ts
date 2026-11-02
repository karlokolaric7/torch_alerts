/**
 * Sends ONE test alert to Telegram using the most recent real Torch launch.
 * Use it to confirm the bot token / channel / formatting work, without waiting
 * for a new launch. Does not touch the dedup state.
 *
 *   npm run test-alert
 */
import { loadConfig } from '../config';
import { extractCandidateAddresses } from '../chain/extract';
import { buildTokenLaunch } from '../chain/launchDetails';
import { createRpcProvider } from '../chain/watcher';
import { TelegramNotifier } from '../telegram/notifier';
import { ConsoleNotifier } from '../telegram/consoleNotifier';
import { errorMessage } from '../logger';
import type { Notifier, TokenLaunch } from '../types';
import type { JsonRpcProvider } from 'ethers';

const LOOKBACK_BLOCKS = 200_000;

async function findLatestLaunch(provider: JsonRpcProvider): Promise<TokenLaunch | null> {
  const config = loadConfig();
  if (!config.launchEventTopic) {
    throw new Error('Set LAUNCH_EVENT_TOPIC in .env first (see `npm run inspect`)');
  }
  const head = await provider.getBlockNumber();

  // Walk backwards in chunks until we hit a launch event.
  for (let to = head; to > head - LOOKBACK_BLOCKS; to -= config.maxBlockRange) {
    const from = Math.max(0, to - config.maxBlockRange + 1);
    const logs = await provider.getLogs({
      address: config.factoryAddress,
      fromBlock: from,
      toBlock: to,
      topics: [config.launchEventTopic],
    });
    const log = logs.at(-1);
    if (!log) continue;

    const [address] = extractCandidateAddresses(log, config.tokenSuffix);
    if (!address) continue;

    return buildTokenLaunch(provider, address, log);
  }
  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const provider = createRpcProvider(config.rpcUrl);
  const formatOptions = {
    explorerUrl: config.explorerUrl,
    tokenUrlTemplate: config.tokenUrlTemplate,
    includeImageCard: config.includeImageCard,
    includeShareCard: config.includeShareCard,
  };
  const notifier: Notifier = config.dryRun
    ? new ConsoleNotifier(formatOptions)
    : new TelegramNotifier(config.telegramBotToken, config.telegramChannelId, formatOptions);

  await notifier.verify();
  console.log('Looking up the most recent Torch launch...');
  const launch = await findLatestLaunch(provider);
  if (!launch) throw new Error(`No launch found in the last ${LOOKBACK_BLOCKS} blocks`);

  await notifier.postLaunch(launch);
  if (notifier instanceof TelegramNotifier) {
    await notifier.flushPendingTasks();
  }
  console.log(`✅ Test alert sent for ${launch.symbol ?? '?'} (${launch.address})`);
  provider.destroy();
}

main().catch((err) => {
  console.error(`test-alert failed: ${errorMessage(err)}`);
  process.exit(1);
});
