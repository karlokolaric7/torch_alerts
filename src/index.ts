/**
 * torch-alerts entry point.
 * Wires config → RPC provider → state store → user filter store → Telegram notifier → watcher,
 * starts interactive Telegram bot commands, optional HTTP health-check server + heartbeat log,
 * and handles graceful shutdown / clean crash recovery for 24/7 Render deployment.
 */
import http from 'node:http';
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

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Starts a lightweight HTTP health-check endpoint if `PORT` or `HEALTH_PORT` is set
 * in the environment (useful for Render health checks or uptime monitors).
 */
function startHealthServer(watcher: LaunchWatcher): http.Server | null {
  const rawPort = process.env.PORT?.trim() || process.env.HEALTH_PORT?.trim();
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0) return null;

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const s = watcher.getStatus();
      const body = JSON.stringify({
        status: s.running ? 'ok' : 'starting',
        uptimeSec: Math.floor((Date.now() - s.startedAtMs) / 1000),
        lastBlock: s.lastBlock,
        seenCount: s.seenCount,
        trackedCount: s.trackedCount,
        graduatedCount: s.graduatedCount,
        postedThisSession: s.postedThisSession,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`Health-check server listening on 0.0.0.0:${port} (/health)`);
  });
  server.on('error', (err) => {
    logger.warn(`Health-check server error: ${errorMessage(err)}`);
  });
  return server;
}

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
  const healthServer = startHealthServer(watcher);

  // Periodic heartbeat log for Render worker logs
  const heartbeatTimer = setInterval(() => {
    const s = watcher.getStatus();
    logger.info(
      `[HEARTBEAT] Bot healthy: lastBlock=${s.lastBlock ?? 'init'} postedSession=${s.postedThisSession} ` +
        `seen=${s.seenCount} tracked=${s.trackedCount} graduated=${s.graduatedCount}`,
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  if (telegramNotifier && config.enableBotCommands) {
    await telegramNotifier.startCommandListener(watcher);
  }

  // Graceful shutdown: stop polling, stop bot commands, flush state, close the provider.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(heartbeatTimer);
    healthServer?.close();
    telegramNotifier?.stopCommandListener(signal);
    watcher.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await watcher.start(); // resolves after stop()

  clearInterval(heartbeatTimer);
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
  logger.error(`Uncaught exception (exiting for clean supervisor restart): ${errorMessage(err)}`, err);
  process.exit(1);
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
