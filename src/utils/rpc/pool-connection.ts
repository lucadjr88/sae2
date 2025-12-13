import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo, AccountInfo, ParsedAccountData } from '@solana/web3.js';
import { RpcPoolManager, getGlobalRpcPoolManager } from './rpc-pool-manager.js';
import { nlog } from '../log-normalizer.js';

export interface RpcOperationOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fallbackToDefault?: boolean;
  logErrors?: boolean;
  // Custom backoff base (ms) applied for 429 errors: actual backoff = base * (attempt+1)
  rateLimitBackoffBaseMs?: number;
  // If set, and an endpoint reports this many 429s, mark it as failed/unhealthy
  markUnhealthyOn429Threshold?: number;
}

/**
 * RpcPoolConnection - A wrapper around Connection that uses RPC pool
 * with automatic round-robin, health checking, timeout, and retry logic.
 *
 * Transparently handles:
 * - Selection of healthy RPC endpoints via round-robin
 * - Concurrency limiting per endpoint
 * - Timeout and retry on failures
 * - Error classification (429, 402, timeout, etc)
 * - Latency tracking
 * - Fallback to primary connection
 */
export class RpcPoolConnection {
  private poolManager: RpcPoolManager;
  private defaultConnection: Connection;
  private readonly defaultTimeoutMs = 15000;
  private readonly defaultMaxRetries = 3;
  private readonly defaultLogErrors = true;
  private txCounter = 0;
  private lastLogTime = Date.now();
  private readonly LOG_BATCH_SIZE = 20;

  constructor(defaultConnection: Connection, poolManager?: RpcPoolManager) {
    this.defaultConnection = defaultConnection;
    this.poolManager = poolManager || getGlobalRpcPoolManager();
    // Log only once at application startup
    if (!poolManager) {
      nlog(`[RpcPoolConnection] Initialized global pool with ${this.poolManager.getPoolSize()} endpoints`);
    }
  }

  /**
   * Log aggregated statistics every N transactions
   */
  private logAggregatedStats(): void {
    if (this.txCounter % this.LOG_BATCH_SIZE !== 0) return;

    const metrics = this.poolManager.getRpcMetrics();
    const now = Date.now();
    const timeDiff = now - this.lastLogTime;
    this.lastLogTime = now;

    const totalTxs = metrics.reduce((sum, m) => sum + m.processedTxs, 0);
    const totalSuccesses = metrics.reduce((sum, m) => sum + m.successes, 0);
    const totalFailures = metrics.reduce((sum, m) => sum + m.failures, 0);
    const rate429 = metrics.reduce((sum, m) => sum + m.errorCounts.rateLimit429, 0);
    const rate402 = metrics.reduce((sum, m) => sum + m.errorCounts.payment402, 0);
    const txPerSecond = Math.round((this.LOG_BATCH_SIZE / timeDiff) * 1000);

    // Build health status string
    const healthyEndpoints = metrics.filter(m => m.healthy).length;
    const healthStatus = healthyEndpoints === metrics.length ? 'OK' : `${healthyEndpoints}/${metrics.length}`;

    // Build endpoint summary - only show endpoints with activity
    const endpointSummary = metrics
      .filter(m => m.processedTxs > 0)
      .map(m => `E${m.index}:${m.processedTxs}`)
      .join(' ');

    nlog(
      `[RPC]\t${totalTxs}tx\t${txPerSecond}tx/s\t${totalSuccesses}ok\t${totalFailures}fail\t429:${rate429}\t402:${rate402}\t${healthStatus}\t${endpointSummary}`
    );
  }

  /**
   * Execute an RPC operation with automatic pool selection, timeout, and retry
   */
  private async executeWithPool<T>(
    operation: (conn: Connection, rpcIndex: number) => Promise<T>,
    opts: RpcOperationOptions = {}
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = opts.maxRetries ?? this.defaultMaxRetries;
    const fallbackToDefault = false; // Never fallback - RPC pool only
    const logErrors = opts.logErrors !== false && this.defaultLogErrors;

    let lastError: any;

    // Try RPC pool endpoints first
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const picked = this.poolManager.pickNextRpc();

        if (picked.index < 0 || !picked.connection) {
          // No healthy RPC in pool, try default
          if (fallbackToDefault) {
            const startTime = Date.now();
            try {
              const result = await this.executeWithTimeout(
                operation(this.defaultConnection, -1),
                timeoutMs
              );
              // Count as processed even though using default
              return result;
            } catch (err) {
              // Fallback failed - count as error overall
              throw err;
            }
          }
          throw new Error('No healthy RPC endpoints available in pool');
        }

        // Acquire concurrency slot
        if (!this.poolManager.tryAcquireRpc(picked.index)) {
          // Pool slot unavailable, try default connection
          if (fallbackToDefault) {
            const startTime = Date.now();
            try {
              const result = await this.executeWithTimeout(
                operation(this.defaultConnection, -1),
                timeoutMs
              );
              // Count as processed even though using default
              return result;
            } catch (err) {
              // Fallback failed - count as error overall
              throw err;
            }
          }
          throw new Error(`RPC endpoint ${picked.index} concurrency limit reached`);
        }

        const startTime = Date.now();
        try {
          const result = await this.executeWithTimeout(operation(picked.connection, picked.index), timeoutMs);
          const latencyMs = Date.now() - startTime;

          // Record success and release
          this.poolManager.releaseRpc(picked.index, {
            success: true,
            latencyMs,
          });
          // Record processed transaction
          this.poolManager.recordRpcProcessed(picked.index, 1);
          this.txCounter++;
          this.logAggregatedStats();

          return result;
        } catch (err: any) {
          const latencyMs = Date.now() - startTime;
          const errorType = this.classifyError(err);

          // Record failure and release
          this.poolManager.releaseRpc(picked.index, {
            success: false,
            latencyMs,
            errorType,
          });

          lastError = err;

          // On rate limit, wait longer before retry. Allow custom base backoff.
          if (errorType === '429' && attempt < maxRetries) {
            const base = opts?.rateLimitBackoffBaseMs ?? 1000;
            const backoffMs = Math.min(5000, base * (attempt + 1));
            // If endpoint shows high 429 counts, mark unhealthy to avoid further use
            try {
              const metrics = this.poolManager.getRpcMetricsAt(picked.index);
              const thresh = opts?.markUnhealthyOn429Threshold;
              if (thresh && metrics && (metrics.errorCounts?.rateLimit429 || 0) >= thresh) {
                this.poolManager.markRpcFailure(picked.index, '429-threshold');
                // small pause to allow selector to skip it
                await new Promise(resolve => setTimeout(resolve, Math.min(2000, backoffMs)));
              }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }

          if (attempt === maxRetries && fallbackToDefault) {
            // Try default connection as last resort
            try {
              const result = await this.executeWithTimeout(
                operation(this.defaultConnection, -1),
                timeoutMs
              );
              return result;
            } catch (defaultErr) {
              lastError = defaultErr;
            }
          }
        }
      } catch (err: any) {
        lastError = err;

        if (attempt === maxRetries) {
          if (logErrors) {
            // Solo log final error, non tutti gli intermedi
          }
          throw lastError;
        }

        // Wait before retry
        const delayMs = Math.min(1000, (attempt + 1) * 200);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    throw lastError;
  }

  /**
   * Execute operation with timeout
   */
  private executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('RPC timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Classify error type for proper backoff handling
   */
  private classifyError(err: any): string {
    const message = (err?.message || String(err)).toLowerCase();

    if (message.includes('429') || message.includes('rate limit')) return '429';
    if (message.includes('402') || message.includes('insufficient') || message.includes('payment')) return '402';
    if (message.includes('timeout') || message.includes('timed out')) return 'timeout';

    return 'other';
  }

  // ============ Connection API Wrappers ============

  /**
   * Fetch a single transaction
   */
  async getTransaction(
    signature: string,
    opts?: RpcOperationOptions & { maxSupportedTransactionVersion?: number }
  ): Promise<any | null> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getTransaction(signature, {
          maxSupportedTransactionVersion: opts?.maxSupportedTransactionVersion,
        }),
      opts
    );
  }

  /**
   * Fetch signatures for an address
   */
  async getSignaturesForAddress(
    address: PublicKey,
    opts?: RpcOperationOptions & { limit?: number; before?: string; until?: string }
  ): Promise<ConfirmedSignatureInfo[]> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getSignaturesForAddress(address, {
          limit: opts?.limit,
          before: opts?.before,
          until: opts?.until,
        }),
      opts
    );
  }

  /**
   * Fetch a parsed transaction
   */
  async getParsedTransaction(
    signature: string,
    opts?: RpcOperationOptions & { maxSupportedTransactionVersion?: number }
  ): Promise<ParsedTransactionWithMeta | null> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: opts?.maxSupportedTransactionVersion,
        }),
      opts
    );
  }

  /**
   * Fetch account info
   */
  async getAccountInfo(
    address: PublicKey,
    opts?: RpcOperationOptions & { commitment?: 'processed' | 'confirmed' | 'finalized' }
  ): Promise<AccountInfo<Buffer> | null> {
    return this.executeWithPool(
      async (conn, _index) => {
        return conn.getAccountInfo(address, {
          commitment: opts?.commitment,
        });
      },
      opts
    );
  }

  /**
   * Fetch parsed account info
   */
  async getParsedAccountInfo(
    address: PublicKey,
    opts?: RpcOperationOptions & { commitment?: 'processed' | 'confirmed' | 'finalized' }
  ): Promise<any | null> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getParsedAccountInfo(address, {
          commitment: opts?.commitment,
        }),
      opts
    );
  }

  /**
   * Fetch program accounts via RPC pool (wraps `getProgramAccounts`)
   */
  async getProgramAccounts(
    programId: PublicKey,
    opts?: any,
  ): Promise<any[]> {
    return this.executeWithPool(
      async (conn, index) => {
        nlog(`[RpcPoolConnection] getProgramAccounts -> endpoint E${index}`);
        // `getProgramAccounts` can be provider/connection-specific signatures
        return (conn as any).getProgramAccounts(programId, opts);
      },
      { timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs, maxRetries: opts?.maxRetries ?? this.defaultMaxRetries }
    );
  }

  /**
   * Fetch multiple accounts info via RPC pool (wraps `getMultipleAccountsInfo`)
   */
  async getMultipleAccountsInfo(
    addresses: PublicKey[],
    opts?: any,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.executeWithPool(
      async (conn, index) => {
        nlog(`[RpcPoolConnection] getMultipleAccountsInfo chunk(${addresses.length}) -> endpoint E${index}`);
        return (conn as any).getMultipleAccountsInfo(addresses, opts);
      },
      { timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs, maxRetries: opts?.maxRetries ?? this.defaultMaxRetries }
    );
  }

  /**
   * Get epoch info
   */
  async getEpochInfo(opts?: RpcOperationOptions & { commitment?: 'processed' | 'confirmed' | 'finalized' }): Promise<any> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getEpochInfo(opts?.commitment),
      opts
    );
  }

  /**
   * Get slot
   */
  async getSlot(opts?: RpcOperationOptions & { commitment?: 'processed' | 'confirmed' | 'finalized' }): Promise<number> {
    return this.executeWithPool(
      async (conn, _index) =>
        conn.getSlot(opts?.commitment),
      opts
    );
  }

  /**
   * Get the underlying RPC pool manager for advanced usage
   */
  getPoolManager(): RpcPoolManager {
    return this.poolManager;
  }

  /**
   * Get metrics from the pool
   */
  getMetrics() {
    return this.poolManager.getRpcMetrics();
  }
}

export function createRpcPoolConnection(
  defaultConnection: Connection,
  poolManager?: RpcPoolManager
): RpcPoolConnection {
  return new RpcPoolConnection(defaultConnection, poolManager);
}
