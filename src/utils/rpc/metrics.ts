import { RpcPoolLoader } from './pool-loader.js';
import { RpcMetrics, IRpcMetricsTracker } from './types.js';

export class RpcMetricsTracker implements IRpcMetricsTracker {
  constructor(private poolLoader: RpcPoolLoader) {}

  /**
   * Record latency for an RPC using exponential moving average
   * alpha = 0.2 for recent values weighted more
   */
  recordLatency(index: number, latencyMs: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;

    const alpha = 0.2;
    if (!meta.avgLatencyMs) {
      meta.avgLatencyMs = latencyMs;
    } else {
      meta.avgLatencyMs = Math.round(alpha * latencyMs + (1 - alpha) * meta.avgLatencyMs);
    }
  }

  /**
   * Get average latency for an RPC (or undefined if not recorded)
   */
  getLatency(index: number): number | undefined {
    const meta = this.poolLoader.getMetaAt(index);
    return meta?.avgLatencyMs;
  }

  /**
   * Record number of transactions processed by an RPC
   */
  recordProcessed(index: number, count: number = 1): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;
    meta.processedTxs += count;
  }

  /**
   * Get total transactions processed by an RPC
   */
  getProcessed(index: number): number {
    const meta = this.poolLoader.getMetaAt(index);
    return meta ? meta.processedTxs : 0;
  }

  /**
   * Get comprehensive metrics for all RPC endpoints
   */
  getMetrics(): RpcMetrics[] {
    const pool = this.poolLoader.getPool();
    const meta = this.poolLoader.getMeta();

    return meta.map((m, i) => ({
      index: i,
      healthy: m.healthy,
      failures: m.failures,
      successes: m.successes,
      processedTxs: m.processedTxs,
      currentConcurrent: m.currentConcurrent,
      avgLatencyMs: m.avgLatencyMs,
      backoffUntil: m.backoffUntil,
      errorCounts: { ...m.errorCounts },
      url: pool[i]?.url,
      maxConcurrent: pool[i]?.maxConcurrent,
      cooldownMs: pool[i]?.cooldownMs,
    }));
  }

  /**
   * Get metrics for a specific RPC endpoint
   */
  getMetricsAt(index: number): RpcMetrics | null {
    const entry = this.poolLoader.getEntry(index);
    const meta = this.poolLoader.getMetaAt(index);

    if (!entry || !meta) return null;

    return {
      index,
      healthy: meta.healthy,
      failures: meta.failures,
      successes: meta.successes,
      processedTxs: meta.processedTxs,
      currentConcurrent: meta.currentConcurrent,
      avgLatencyMs: meta.avgLatencyMs,
      backoffUntil: meta.backoffUntil,
      errorCounts: { ...meta.errorCounts },
      url: entry.url,
      maxConcurrent: entry.maxConcurrent,
      cooldownMs: entry.cooldownMs,
    };
  }

  /**
   * Reset all metrics for an RPC endpoint
   */
  reset(index: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;

    meta.failures = 0;
    meta.successes = 0;
    meta.processedTxs = 0;
    meta.avgLatencyMs = undefined;
    meta.errorCounts = { rateLimit429: 0, payment402: 0, timeout: 0, other: 0 };
  }
}

export function createRpcMetricsTracker(poolLoader: RpcPoolLoader): RpcMetricsTracker {
  return new RpcMetricsTracker(poolLoader);
}
