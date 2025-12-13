import { TransactionInfo } from '../examples/types.js';
import * as persistCache from './persist-cache.js';
import { nlog } from './log-normalizer.js';

/**
 * TransactionCache - Centralized coordination of transaction fetching and caching
 * 
 * Problem: Multiple endpoints were fetching the same transactions for the same wallet
 * multiple times, causing unnecessary RPC calls.
 * 
 * Solution: Cache transactions per wallet + time period combination. Once fetched,
 * subsequent requests for the same wallet use cached data.
 * 
 * Usage:
 *   1. Create instance: const cache = new TransactionCache();
 *   2. Get transactions: const txs = await cache.getTransactions(wallet, { hours: 24 });
 *   3. Cache is automatically persisted and reused across requests
 */
export class TransactionCache {
  private inMemoryCache: Map<string, { txs: TransactionInfo[]; fetched: number }> = new Map();
  private fetchInProgress: Map<string, Promise<TransactionInfo[]>> = new Map();
  
  /**
   * Generate cache key from wallet and time period
   */
  private getCacheKey(wallet: string, hours: number): string {
    return `tx-cache-${wallet}-${hours}h`;
  }

  /**
   * Get transactions for a wallet, using cache if available
   * 
   * @param wallet - Wallet public key
   * @param options - Options including hours (default 24)
   * @param fetchFn - Function to fetch transactions from RPC if not cached
   * @returns Array of transactions
   */
  async getTransactions(
    wallet: string,
    options: { hours?: number; refresh?: boolean } = {},
    fetchFn: () => Promise<TransactionInfo[]>
  ): Promise<TransactionInfo[]> {
    const hours = options.hours || 24;
    const cacheKey = this.getCacheKey(wallet, hours);
    
    // 1. Check if refresh is requested
    if (options.refresh) {
      nlog(`[tx-cache] Refresh requested for ${wallet.substring(0, 8)}... (${hours}h)`);
      // Clear in-memory cache
      this.inMemoryCache.delete(cacheKey);
      // Don't clear disk cache yet, do fresh fetch
    }

    // 2. Check if already fetching (prevent duplicate concurrent requests)
    if (this.fetchInProgress.has(cacheKey)) {
      nlog(`[tx-cache] Fetch already in progress for ${wallet.substring(0, 8)}... (${hours}h), waiting...`);
      return await this.fetchInProgress.get(cacheKey)!;
    }

    // 3. Check in-memory cache
    const memCached = this.inMemoryCache.get(cacheKey);
    if (memCached && !options.refresh) {
      const ageMs = Date.now() - memCached.fetched;
      const ageMin = (ageMs / 60000).toFixed(1);
      nlog(`[tx-cache] In-memory HIT for ${wallet.substring(0, 8)}... (${hours}h) - ${memCached.txs.length} tx (age: ${ageMin}min)`);
      return memCached.txs;
    }

    // 4. Check disk cache
    const diskCached = await this.loadFromDisk(cacheKey);
    if (diskCached && !options.refresh) {
      const ageMs = Date.now() - diskCached.fetched;
      const ageMin = (ageMs / 60000).toFixed(1);
      nlog(`[tx-cache] Disk HIT for ${wallet.substring(0, 8)}... (${hours}h) - ${diskCached.txs.length} tx (age: ${ageMin}min)`);
      // Restore to in-memory cache
      this.inMemoryCache.set(cacheKey, diskCached);
      return diskCached.txs;
    }

    // 5. Fetch fresh data
    nlog(`[tx-cache] MISS for ${wallet.substring(0, 8)}... (${hours}h) - fetching fresh data`);
    
    const fetchPromise = fetchFn().then(txs => {
      // Defensive: ensure all txs have programIds, logMessages, instructions
      for (const tx of txs) {
        if (!Array.isArray(tx.programIds)) tx.programIds = [];
        if (!Array.isArray(tx.logMessages)) tx.logMessages = [];
        if (!Array.isArray(tx.instructions)) tx.instructions = [];
      }
      // Cache in memory
      this.inMemoryCache.set(cacheKey, { txs, fetched: Date.now() });
      // Cache on disk
      this.saveToDisk(cacheKey, { txs, fetched: Date.now() }).catch(err => {
        console.error(`[tx-cache] Failed to save to disk for ${cacheKey}:`, err);
      });
      nlog(`[tx-cache] Fetched and cached ${txs.length} tx for ${wallet.substring(0, 8)}... (${hours}h)`);
      return txs;
    });

    this.fetchInProgress.set(cacheKey, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.fetchInProgress.delete(cacheKey);
    }
  }

  /**
   * Load cache from disk
   */
  private async loadFromDisk(cacheKey: string): Promise<{ txs: TransactionInfo[]; fetched: number } | null> {
    try {
      const cached = await persistCache.getCacheDataOnly('transaction-cache', cacheKey);
      if (cached && cached.txs && Array.isArray(cached.txs) && cached.fetched) {
        return cached as { txs: TransactionInfo[]; fetched: number };
      }
    } catch (err) {
      // Silently fail disk read
    }
    return null;
  }

  /**
   * Save cache to disk
   */
  private async saveToDisk(cacheKey: string, data: { txs: TransactionInfo[]; fetched: number }): Promise<void> {
    try {
      await persistCache.setCache('transaction-cache', cacheKey, data);
      // Cleanup legacy adjacent-hour cache files (e.g., -25h when canonical is -24h)
      try {
        const m = cacheKey.match(/-(\d+)h$/);
        if (m && m[1]) {
          const h = parseInt(m[1], 10);
          const legacyCandidates = [h + 1, Math.max(1, h - 1)];
          // replicate safeKey logic from persist-cache.js
          const safeKey = (key: string) => {
            if (/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return key;
            const crypto = require('crypto');
            return crypto.createHash('sha256').update(key).digest('hex');
          };
          const fs = require('fs').promises;
          const path = require('path');
          const nsDir = path.join(process.cwd(), 'cache', 'transaction-cache');
          for (const hh of legacyCandidates) {
            const altKey = cacheKey.replace(/-(\d+)h$/, `-${hh}h`);
            if (altKey !== cacheKey) {
              const file = path.join(nsDir, `${safeKey(altKey)}.json`);
              try {
                await fs.unlink(file);
                nlog(`[tx-cache] Removed legacy cache file: ${file}`);
              } catch (e) {
                // ignore if not present
              }
            }
          }
        }
      } catch (e) {
        // ignore cleanup errors
      }
    } catch (err) {
      console.error(`[tx-cache] Failed to save to disk:`, err);
    }
  }

  /**
   * Clear all caches (in-memory and in-progress tracking)
   */
  clearMemory(): void {
    this.inMemoryCache.clear();
    this.fetchInProgress.clear();
    nlog('[tx-cache] Memory cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    inMemoryCaches: number;
    inProgressFetches: number;
  } {
    return {
      inMemoryCaches: this.inMemoryCache.size,
      inProgressFetches: this.fetchInProgress.size,
    };
  }
}

// Global singleton instance
let globalTransactionCache: TransactionCache | null = null;

export function getGlobalTransactionCache(): TransactionCache {
  if (!globalTransactionCache) {
    globalTransactionCache = new TransactionCache();
  }
  return globalTransactionCache;
}
