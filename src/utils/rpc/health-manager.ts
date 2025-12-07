import { RpcPoolLoader } from './pool-loader.js';
import { IRpcHealthManager } from './types.js';

export class RpcHealthManager implements IRpcHealthManager {
  private readonly UNHEALTHY_THRESHOLD = Number(process.env.RPC_UNHEALTHY_THRESHOLD || 100);
  private readonly BACKOFF_BASE_MS = Number(process.env.RPC_BACKOFF_BASE_MS || 500); // Reduced from 2000
  private readonly COOLDOWN_MS = Number(process.env.RPC_COOLDOWN_MS || 15000); // Reduced from 60000

  constructor(private poolLoader: RpcPoolLoader) {}

  isHealthy(index: number): boolean {
    const meta = this.poolLoader.getMetaAt(index);
    return meta ? meta.healthy : false;
  }

  isInBackoff(index: number): boolean {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta || !meta.backoffUntil) return false;
    return meta.backoffUntil > Date.now();
  }

  setBackoff(index: number, durationMs: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;
    meta.backoffUntil = Date.now() + durationMs;
    meta.healthy = false;
  }

  clearBackoff(index: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;
    meta.backoffUntil = undefined;
    meta.failures = 0;
    meta.healthy = true;
  }

  /**
   * Record a failure and update health status
   * Handles error classification for different failure types
   */
  recordFailure(index: number, errorType?: string): void {
    const meta = this.poolLoader.getMetaAt(index);
    const entry = this.poolLoader.getEntry(index);
    if (!meta || !entry) return;

    // Increment failures (capped to avoid overflow)
    meta.failures = Math.min((meta.failures || 0) + 1, 100000);
    meta.lastFailureAt = Date.now();

    // Classify error type
    const classification = errorType || 'other';
    if (classification === '429') meta.errorCounts.rateLimit429++;
    else if (classification === '402') meta.errorCounts.payment402++;
    else if (classification === 'timeout') meta.errorCounts.timeout++;
    else meta.errorCounts.other++;

    // Handle 429 rate limit with shorter backoff
    if (classification === '429') {
      meta.healthy = false;
      const backoffDuration = this.BACKOFF_BASE_MS * 4 + Math.floor(this.COOLDOWN_MS * 0.25);
      meta.backoffUntil = Date.now() + backoffDuration;
      return;
    }

    // Check threshold and transition to unhealthy
    if (meta.failures >= this.UNHEALTHY_THRESHOLD && meta.healthy) {
      this.transitionToUnhealthy(index);
    }
  }

  /**
   * Record a success, improving health status
   */
  recordSuccess(index: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    if (!meta) return;

    meta.successes++;
    meta.failures = 0; // Reset all failures on success
    meta.healthy = true;
    meta.backoffUntil = undefined;
  }

  /**
   * Probe an RPC endpoint to check if it's responsive
   * On success, clears failures and marks as healthy
   */
  async probe(index: number, timeoutMs = 5000): Promise<boolean> {
    const entry = this.poolLoader.getEntry(index);
    if (!entry || !entry.connection) return false;

    const conn = entry.connection;
    try {
      const p = conn.getEpochInfo();
      await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), timeoutMs))]);

      // Success - clear failures and backoff
      this.clearBackoff(index);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Transition RPC to unhealthy state with exponential backoff
   */
  private transitionToUnhealthy(index: number): void {
    const meta = this.poolLoader.getMetaAt(index);
    const entry = this.poolLoader.getEntry(index);
    if (!meta || !entry) return;

    meta.healthy = false;

    // Exponential backoff: base * 2^(failures-threshold), capped at 10 seconds max
    const exponent = Math.min(10, meta.failures - this.UNHEALTHY_THRESHOLD);
    const backoff = Math.min(10000, this.BACKOFF_BASE_MS * Math.pow(2, exponent));
    meta.backoffUntil = Date.now() + backoff + this.COOLDOWN_MS;

    console.warn(
      `[rpc-health] Marking RPC index ${index} (${entry.name}) as unhealthy ` +
        `(failures=${meta.failures}) backoffUntil=${new Date(meta.backoffUntil).toISOString()}`
    );
  }
}

export function createRpcHealthManager(poolLoader: RpcPoolLoader): RpcHealthManager {
  return new RpcHealthManager(poolLoader);
}
