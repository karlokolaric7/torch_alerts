/**
 * Diagnostic tool: scans recent factory logs and groups them by event topic0.
 *
 * Use it to find the factory's launch event and set LAUNCH_EVENT_TOPIC for
 * strict detection. The launch event is typically the topic whose logs each
 * contain a *distinct* suffix address (one per new token).
 *
 *   npm run inspect            # last 20,000 blocks
 *   npm run inspect -- 100000  # custom lookback
 */
import { JsonRpcProvider } from 'ethers';
import { loadChainConfig } from '../config';
import { extractCandidateAddresses } from '../chain/extract';
import { errorMessage } from '../logger';

interface TopicStats {
  count: number;
  withCandidate: number;
  addresses: Set<string>;
  sampleTx?: string;
}

async function main(): Promise<void> {
  const config = loadChainConfig();
  const lookback = Number(process.argv[2] ?? 20_000);
  if (!Number.isInteger(lookback) || lookback <= 0) throw new Error('Lookback must be a positive integer');

  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const head = await provider.getBlockNumber();
  const start = Math.max(0, head - lookback);
  console.log(`Scanning ${config.factoryAddress} blocks ${start}-${head}...`);

  const stats = new Map<string, TopicStats>();
  for (let from = start; from <= head; from += config.maxBlockRange) {
    const to = Math.min(head, from + config.maxBlockRange - 1);
    const logs = await provider.getLogs({ address: config.factoryAddress, fromBlock: from, toBlock: to });

    for (const log of logs) {
      const topic0 = log.topics[0] ?? '(anonymous)';
      const s = stats.get(topic0) ?? { count: 0, withCandidate: 0, addresses: new Set<string>() };
      s.count++;
      const candidates = extractCandidateAddresses(log, config.tokenSuffix);
      if (candidates.length) {
        s.withCandidate++;
        candidates.forEach((a) => s.addresses.add(a));
        s.sampleTx ??= log.transactionHash;
      }
      stats.set(topic0, s);
    }
    process.stdout.write(`\r  processed up to block ${to}`);
  }
  console.log('\n');

  if (!stats.size) {
    console.log('No factory logs found in range. Try a larger lookback.');
  }
  for (const [topic, s] of [...stats].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`topic0 ${topic}`);
    console.log(`  logs: ${s.count}, logs with *${config.tokenSuffix} address: ${s.withCandidate}, distinct tokens: ${s.addresses.size}`);
    if (s.addresses.size) console.log(`  sample token: ${[...s.addresses][0]}  tx: ${s.sampleTx}`);
  }
  console.log(
    '\nHint: the launch event usually has logs ≈ distinct tokens (each launch emits it once).',
  );
  provider.destroy();
}

main().catch((err) => {
  console.error(`inspect failed: ${errorMessage(err)}`);
  process.exit(1);
});

