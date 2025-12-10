import { Connection } from '@solana/web3.js';

export type RpcEntry = {
  name: string;
  url: string;
  ws?: string | null;
  connection?: Connection;
  maxConcurrent?: number;
  cooldownMs?: number;
  backoffBaseMs?: number;
};

export type ErrorCounts = {
  rateLimit429: number;
  payment402: number;
  timeout: number;
  other: number;
};

export type RpcMeta = {
  failures: number;
  successes: number;
  lastFailureAt?: number;
  healthy: boolean;
  processedTxs: number;
  currentConcurrent: number;
  avgLatencyMs?: number;
  backoffUntil?: number;
  errorCounts: ErrorCounts;
};

export type RpcMetrics = {
  index: number;
  healthy: boolean;
  failures: number;
  successes: number;
  processedTxs: number;
  currentConcurrent: number;
  avgLatencyMs?: number;
  backoffUntil?: number;
  errorCounts: ErrorCounts;
  url?: string;
  maxConcurrent?: number;
  cooldownMs?: number;
};

export interface IRpcPool {
  getPool(): RpcEntry[];
  getMeta(): RpcMeta[];
  getSize(): number;
}

export interface IRpcSelector {
  pickNext(): { connection: Connection | null; index: number; url?: string };
}

export interface IRpcHealthManager {
  isHealthy(index: number): boolean;
  isInBackoff(index: number): boolean;
  setBackoff(index: number, durationMs: number): void;
  clearBackoff(index: number): void;
  recordFailure(index: number, errorType?: string): void;
  recordSuccess(index: number): void;
  probe(index: number, timeoutMs?: number): Promise<boolean>;
}

export interface IRpcConcurrencyManager {
  canAcquire(index: number): boolean;
  acquire(index: number): boolean;
  release(index: number): void;
  getConcurrentCount(index: number): number;
}

export interface IRpcMetricsTracker {
  recordLatency(index: number, latencyMs: number): void;
  getLatency(index: number): number | undefined;
  recordProcessed(index: number, count?: number): void;
  getProcessed(index: number): number;
  getMetrics(): RpcMetrics[];
}
