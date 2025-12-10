import { RpcPoolLoader } from './pool-loader.js';
import { IRpcConcurrencyManager } from './types.js';

export class RpcConcurrencyManager implements IRpcConcurrencyManager {
  constructor(private poolLoader: RpcPoolLoader) {}

  /**
   * Check if we can acquire a slot for this RPC without exceeding limits
   */
  canAcquire(index: number): boolean {
    const entry = this.poolLoader.getEntry(index);
    const meta = this.poolLoader.getMetaAt(index);
    if (!entry || !meta) return false;

    const maxConcurrent = entry.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 12);
    const now = Date.now();

    // Check if in backoff period
    if (meta.backoffUntil && meta.backoffUntil > now) {
      return false;
    }

    // Check if unhealthy
    if (!meta.healthy) {
      return false;
    }

    // Check if concurrency limit reached
    if (meta.currentConcurrent >= maxConcurrent) {
      return false;
    }

    return true;
  }

  /**
   * Acquire a concurrency slot for this RPC
   * Returns true if successful, false if cannot acquire
   */
  acquire(index: number): boolean {
    if (!this.canAcquire(index)) {
      return false;
    }

    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return false;

    meta.currentConcurrent++;
    return true;
  }

  /**
   * Release a concurrency slot for this RPC
   */
  release(index: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;

    if (meta.currentConcurrent > 0) {
      meta.currentConcurrent--;
    }
  }

  /**
   * Get the current concurrent request count for this RPC
   */
  getConcurrentCount(index: number): number {
    const meta = this.poolLoader.getMetaAt(index);
    return meta ? meta.currentConcurrent : 0;
  }

  /**
   * Get max concurrent for a given index
   */
  getMaxConcurrent(index: number): number {
    const entry = this.poolLoader.getEntry(index);
    return entry ? (entry.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 12)) : 0;
  }
}

export function createRpcConcurrencyManager(poolLoader: RpcPoolLoader): RpcConcurrencyManager {
  return new RpcConcurrencyManager(poolLoader);
}
