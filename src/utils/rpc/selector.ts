import { Connection } from '@solana/web3.js';
import { RpcPoolLoader } from './pool-loader.js';
import { IRpcSelector } from './types.js';

export class RpcSelector implements IRpcSelector {
  private roundRobinIndex = 0;

  constructor(private poolLoader: RpcPoolLoader) {}

  /**
   * Selects the next RPC based on round-robin, preferring healthy endpoints.
   * Skips endpoints that are unhealthy or in backoff.
   */
  pickNext(): { connection: Connection | null; index: number; url?: string } {
    const pool = this.poolLoader.getPool();
    const meta = this.poolLoader.getMeta();

    if (!pool || pool.length === 0) {
      console.log('[RpcSelector] No endpoints in pool');
      return { connection: null, index: -1 };
    }

    const len = pool.length;
    const now = Date.now();

    for (let attempt = 0; attempt < len; attempt++) {
      const idx = this.roundRobinIndex % len;
      this.roundRobinIndex = (this.roundRobinIndex + 1) % len;

      const m = meta[idx];
      const e = pool[idx];

      // Skip if unhealthy or in backoff
      if (m && (!m.healthy || (m.backoffUntil && m.backoffUntil > now))) {
        continue;
      }

      // Skip if concurrency limit reached
      const maxConcurrent = e.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 8);
      if (m && m.currentConcurrent >= maxConcurrent) {
        continue;
      }

      return {
        connection: e.connection || null,
        index: idx,
        url: e.url,
      };
    }

    // No healthy endpoint available
    return { connection: null, index: -1, url: undefined };
  }

  /**
   * Reset round-robin counter (useful for testing)
   */
  reset(): void {
    this.roundRobinIndex = 0;
  }

  /**
   * Get the current round-robin index
   */
  getCurrentIndex(): number {
    return this.roundRobinIndex;
  }
}

export function createRpcSelector(poolLoader: RpcPoolLoader): RpcSelector {
  return new RpcSelector(poolLoader);
}
