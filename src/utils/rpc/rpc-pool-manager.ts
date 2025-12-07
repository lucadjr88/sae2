import { Connection } from '@solana/web3.js';
import { RpcPoolLoader } from './pool-loader.js';
import { RpcSelector } from './selector.js';
import { RpcHealthManager } from './health-manager.js';
import { RpcConcurrencyManager } from './concurrency-manager.js';
import { RpcMetricsTracker } from './metrics.js';
import { RpcMetrics } from './types.js';

/**
 * RpcPoolManager - Unified orchestrator for all RPC pool operations
 *
 * Manages:
 * - Pool loading and configuration
 * - Round-robin selection with health awareness
 * - Health checking and backoff logic
 * - Concurrency limits per RPC
 * - Metrics tracking (latency, error counts, processed transactions)
 */
export class RpcPoolManager {
  private poolLoader: RpcPoolLoader;
  private selector: RpcSelector;
  private healthManager: RpcHealthManager;
  private concurrencyManager: RpcConcurrencyManager;
  private metricsTracker: RpcMetricsTracker;

  constructor(configPath: string = 'public/rpc-pool.json') {
    this.poolLoader = new RpcPoolLoader(configPath);
    this.selector = new RpcSelector(this.poolLoader);
    this.healthManager = new RpcHealthManager(this.poolLoader);
    this.concurrencyManager = new RpcConcurrencyManager(this.poolLoader);
    this.metricsTracker = new RpcMetricsTracker(this.poolLoader);

    // Ensure pool is loaded
    this.poolLoader.load();
    console.log(`[RpcPoolManager] Initialized with ${this.poolLoader.getSize()} endpoints`);
  }

  // ============ Pool Management ============

  getPoolSize(): number {
    return this.poolLoader.getSize();
  }

  getPoolUrls(): string[] {
    return this.poolLoader.getPool().map(x => x.url);
  }

  getConnectionForIndex(index: number): Connection | null {
    const entry = this.poolLoader.getEntry(index);
    return entry?.connection || null;
  }

  // ============ RPC Selection ============

  /**
   * Pick the next healthy RPC based on round-robin
   */
  pickNextRpc(): { connection: Connection | null; index: number; url?: string } {
    return this.selector.pickNext();
  }

  // ============ Health Management ============

  /**
   * Try to acquire an RPC slot (checks health, backoff, and concurrency)
   */
  tryAcquireRpc(index: number): boolean {
    if (!this.concurrencyManager.canAcquire(index)) {
      return false;
    }
    return this.concurrencyManager.acquire(index);
  }

  /**
   * Release an RPC slot after use
   * Optionally record success/failure and latency
   */
  releaseRpc(index: number, opts?: { success?: boolean; latencyMs?: number; errorType?: string }): void {
    this.concurrencyManager.release(index);

    if (opts?.latencyMs) {
      this.metricsTracker.recordLatency(index, opts.latencyMs);
    }

    if (opts?.success) {
      this.healthManager.recordSuccess(index);
    } else {
      this.healthManager.recordFailure(index, opts?.errorType);
    }
  }

  /**
   * Mark an RPC as failed (low-level call)
   */
  markRpcFailure(index: number, errorType?: string): void {
    this.healthManager.recordFailure(index, errorType);
  }

  /**
   * Mark an RPC as successful (low-level call)
   */
  markRpcSuccess(index: number): void {
    this.healthManager.recordSuccess(index);
  }

  /**
   * Probe an RPC endpoint to check responsiveness
   */
  async probeRpc(index: number, timeoutMs = 5000): Promise<boolean> {
    return this.healthManager.probe(index, timeoutMs);
  }

  /**
   * Check if an RPC is healthy
   */
  isRpcHealthy(index: number): boolean {
    return this.healthManager.isHealthy(index);
  }

  /**
   * Check if an RPC is in backoff period
   */
  isRpcInBackoff(index: number): boolean {
    return this.healthManager.isInBackoff(index);
  }

  // ============ Concurrency Management ============

  /**
   * Check if we can acquire a slot for an RPC
   */
  canAcquireRpc(index: number): boolean {
    return this.concurrencyManager.canAcquire(index);
  }

  /**
   * Get current concurrent request count for an RPC
   */
  getRpcConcurrentCount(index: number): number {
    return this.concurrencyManager.getConcurrentCount(index);
  }

  /**
   * Get max concurrent for an RPC
   */
  getRpcMaxConcurrent(index: number): number {
    return this.concurrencyManager.getMaxConcurrent(index);
  }

  // ============ Metrics ============

  /**
   * Record transactions processed by an RPC
   */
  recordRpcProcessed(index: number, count: number = 1): void {
    this.metricsTracker.recordProcessed(index, count);
  }

  /**
   * Get comprehensive metrics for all RPC endpoints
   */
  getRpcMetrics(): RpcMetrics[] {
    return this.metricsTracker.getMetrics();
  }

  /**
   * Get metrics for a specific RPC
   */
  getRpcMetricsAt(index: number): RpcMetrics | null {
    return this.metricsTracker.getMetricsAt(index);
  }

  /**
   * Get average latency for an RPC
   */
  getRpcLatency(index: number): number | undefined {
    return this.metricsTracker.getLatency(index);
  }

  /**
   * Get total transactions processed by an RPC
   */
  getRpcProcessedCount(index: number): number {
    return this.metricsTracker.getProcessed(index);
  }

  // ============ Internal Access (for advanced usage) ============

  getPoolLoader(): RpcPoolLoader {
    return this.poolLoader;
  }

  getSelector(): RpcSelector {
    return this.selector;
  }

  getHealthManager(): RpcHealthManager {
    return this.healthManager;
  }

  getConcurrencyManager(): RpcConcurrencyManager {
    return this.concurrencyManager;
  }

  getMetricsTracker(): RpcMetricsTracker {
    return this.metricsTracker;
  }
}

// Singleton instance for backward compatibility
let globalManager: RpcPoolManager | null = null;

export function getGlobalRpcPoolManager(): RpcPoolManager {
  if (!globalManager) {
    globalManager = new RpcPoolManager();
  }
  return globalManager;
}

export function createRpcPoolManager(configPath?: string): RpcPoolManager {
  return new RpcPoolManager(configPath);
}
