import { getCache } from '../utils.js';
import { StatsStore } from '@toknt/cache';
import { formatTokenCount } from '@toknt/tokenizer';

function printStats(stats: Awaited<ReturnType<StatsStore['load']>>, recent: Awaited<ReturnType<StatsStore['recentActivity']>>): void {
  console.log('Tokn\'t live savings (Cursor Agent)\n');
  console.log(`  Delivered saved:   ${formatTokenCount(stats.savedTokens)} (${stats.reductionPercent}%)`);
  console.log(`  Delivered comps:   ${stats.compressedOutputs}`);
  console.log(`  Tool calls seen:   ${stats.toolCallsTracked}`);
  console.log(`  Opportunity:       ${formatTokenCount(stats.opportunitySavedTokens)} detected (not deliverable via Cursor hooks)`);
  if (stats.lastTool) {
    console.log(
      `  Last event:        ${stats.lastTool} · saved ${formatTokenCount(stats.lastSavedTokens ?? 0)}` +
        (stats.lastDelivered ? ' · delivered' : ' · tracked')
    );
  }
  console.log();
  if (recent.length) {
    console.log('  Recent activity:');
    for (const e of recent.slice(0, 8)) {
      const tag = e.delivered ? 'DELIVERED' : e.savedTokens > 0 ? 'opportunity' : 'seen';
      console.log(
        `    [${tag}] ${e.tool}  -${formatTokenCount(e.savedTokens)}  ${e.strategy ?? ''}`.trimEnd()
      );
    }
    console.log();
  }
  console.log('  Delivered = model actually got less context (Shell wrap / MCP).');
  console.log('  Opportunity = waste Tokn\'t saw on Read/etc. (Cursor cannot strip those yet).');
  console.log('  Live view: toknt stats --watch   ·   Reset: toknt stats --reset\n');
}

export async function statsCommand(options?: {
  json?: boolean;
  reset?: boolean;
  watch?: boolean;
}): Promise<void> {
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

  if (options?.watch) {
    const render = async () => {
      const stats = await store.load();
      const recent = await store.recentActivity(8);
      // clear screen
      process.stdout.write('\x1Bc');
      printStats(stats, recent);
      console.log(`  Watching ~/.toknt — ${new Date().toLocaleTimeString()} (Ctrl+C to stop)`);
    };
    await render();
    const timer = setInterval(() => {
      void render();
    }, 1000);
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        clearInterval(timer);
        console.log('\n');
        resolve();
      });
    });
    return;
  }

  const stats = await store.load();
  const recent = await store.recentActivity(8);

  if (options?.json) {
    console.log(JSON.stringify({ ...stats, recent }, null, 2));
    return;
  }

  printStats(stats, recent);
}
