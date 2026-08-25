import { getCache } from '../utils.js';
import { StatsStore } from '@toknt/cache';
import { formatTokenCount } from '@toknt/tokenizer';

export async function statsCommand(options?: { json?: boolean; reset?: boolean }): Promise<void> {
  const cache = getCache();
  const store = new StatsStore(cache.getBaseDir());

  if (options?.reset) {
    const stats = await store.reset();
    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    console.log('Token statistics reset.\n');
    return;
  }

  const stats = await store.load();

  if (options?.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('Token Statistics\n');
  console.log(`  Original tokens:  ${formatTokenCount(stats.originalTokens)} (estimated)`);
  console.log(`  Optimized tokens: ${formatTokenCount(stats.optimizedTokens)} (estimated)`);
  console.log(`  Tokens saved:     ${formatTokenCount(stats.savedTokens)}`);
  console.log(`  Reduction:        ${stats.reductionPercent}%`);
  console.log(`  Compressed:       ${stats.compressedOutputs}`);
  console.log(`  Recalled:         ${stats.recalledOutputs}\n`);
  if (stats.compressedOutputs === 0) {
    console.log('  No compressions yet. In Cursor Agent, run a large test command');
    console.log('  (e.g. npm test / pytest) with mode=balanced, then check again.\n');
  } else {
    console.log('  Note: Token counts are estimates, not exact billing data.\n');
    console.log('  Reset with: toknt stats --reset\n');
  }
}
