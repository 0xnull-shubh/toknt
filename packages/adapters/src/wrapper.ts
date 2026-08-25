import { TokntEngine, detectContextType, type ContextItem, type OptimizationMode } from '@toknt/core';
import { LocalCache, StatsStore } from '@toknt/cache';
import { estimateTokens } from '@toknt/tokenizer';
import type { AgentAdapter, ToolInput, ToolOutput } from './types.js';
import { BaseAdapter } from './types.js';

export class OptimizingAdapterWrapper {
  private engine: TokntEngine;
  private cache: LocalCache;
  private statsStore: StatsStore;
  private fixedMode?: OptimizationMode;

  constructor(cache?: LocalCache, mode?: OptimizationMode) {
    const c = cache ?? new LocalCache();
    this.cache = c;
    this.statsStore = new StatsStore(c.getBaseDir());
    this.fixedMode = mode;
    this.engine = new TokntEngine({ cache: c, mode: mode ?? 'safe' });
  }

  getEngine(): TokntEngine {
    return this.engine;
  }

  /** When mode isn't fixed at construct time, follow ~/.toknt/config.json. */
  private async ensureMode(): Promise<void> {
    if (this.fixedMode) return;
    const { mode } = await this.cache.getConfig();
    if (mode !== this.engine.mode) {
      this.engine = new TokntEngine({ cache: this.cache, mode });
    }
  }

  async processToolOutput(output: ToolOutput): Promise<ToolOutput> {
    await this.ensureMode();

    const type = detectContextType(output.toolName, output.content, {
      path: output.path,
      ...output.metadata,
    });

    const item: ContextItem = {
      id: crypto.randomUUID(),
      type,
      content: output.content,
      path: output.path,
      toolName: output.toolName,
      metadata: output.metadata,
    };

    const result = await this.engine.processContextItem(item);

    if (result.optimized) {
      await this.statsStore.recordOptimization(
        estimateTokens(output.content).tokens,
        estimateTokens(result.content).tokens
      );
    }

    return {
      ...output,
      content: result.content,
      metadata: {
        ...output.metadata,
        toknt: {
          optimized: result.optimized,
          strategy: result.strategy,
          recallUri: result.recallUri,
          safetyConfidence: result.safetyConfidence,
        },
      },
    };
  }

  async processRecall(uri: string): Promise<string | null> {
    const content = await this.engine.recall(uri);
    if (content) {
      await this.statsStore.recordRecall();
    }
    return content;
  }
}

export function wrapAdapter(
  adapter: AgentAdapter,
  wrapper: OptimizingAdapterWrapper
): AgentAdapter {
  const originalOutput = adapter.interceptToolOutput?.bind(adapter);

  adapter.interceptToolOutput = async (output: ToolOutput) => {
    const processed = await wrapper.processToolOutput(output);
    if (originalOutput) {
      return originalOutput(processed);
    }
    return processed;
  };

  return adapter;
}

export * from './types.js';
