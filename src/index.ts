/**
 * torch-alerts entry point.
 * Wires config → RPC provider → state store → user filter store → Telegram notifier → watcher,
 * starts interactive Telegram bot commands, and handles graceful shutdown.
 */
import { loadConfig, ConfigError } from './config';
import { logger, errorMessage } from './logger';
import { StateStore } from './store/stateStore';
import { UserFilterStore } from './store/userFilterStore';
import { TelegramNotifier } from './telegram/notifier';
import { ConsoleNotifier } from './telegram/consoleNotifier';
import { warmupImageCardRenderer } from './telegram/imageCard';
import { LaunchWatcher, createRpcProvider } from './chain/watcher';
import { startEthPriceRefresher, stopEthPriceRefresher } from './chain/price';
import { withTimeout } from './chain/token';
import type { Notifier } from './types';

async function main(): Promise<void> {
  const config = loadConfig();

  // staticNetwork + fast batching; also warm up ETH/USD spot price & sharp SVG rasterizer in parallel.
  const provider = createRpcProvider(config.rpcUrl);
  const [network] = await Promise.all([
    withTimeout(provider.getNetwork(), 15_000, 'RPC connection'),
    startEthPriceRefresher().catch(() => undefined),
    warmupImageCardRenderer(),
  ]);
  logger.info(`Connected to RPC (chainId ${network.chainId})`);

  const userStore = await UserFilterStore.load(config.userFiltersFile);

  const notifierOptions = {
    explorerUrl: config.explorerUrl,
    tokenUrlTemplate: config.tokenUrlTemplate,
    includeImageCard: config.includeImageCard,
    postToChannel: config.postToChannel,
    fastChannelTextFirst: config.fastChannelTextFirst,
    userStore,
  };
  const telegramNotifier = config.dryRun
    ? null
    : new TelegramNotifier(config.telegramBotToken, config.telegramChannelId, notifierOptions);
  const notifier: Notifier = telegramNotifier ?? new ConsoleNotifier(notifierOptions);
  await notifier.verify();

  const store = await StateStore.load(config.stateFile);
  const watcher = new LaunchWatcher(provider, config, store, notifier, userStore);

  if (telegramNotifier && config.enableBotCommands) {
    await telegramNotifier.startCommandListener(watcher);
  }

  // Graceful shutdown: stop polling, stop bot commands, flush state, close the provider.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    telegramNotifier?.stopCommandListener(signal);
    watcher.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await watcher.start(); // resolves after stop()

  stopEthPriceRefresher();
  await Promise.all([
    telegramNotifier?.flushPendingTasks(),
    store.save().catch((err) => logger.error(`Failed to save state: ${errorMessage(err)}`)),
    userStore.save().catch((err) => logger.error(`Failed to save user filters: ${errorMessage(err)}`)),
  ]);
  watcher.destroyProvider();
}

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${errorMessage(reason)}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${errorMessage(err)}`, err);
});

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof ConfigError) {
      logger.error(`Configuration error: ${err.message}`);
    } else {
      logger.error(`Fatal: ${errorMessage(err)}`, err);
    }
    process.exit(1);
  },
);
