import { TransactionInfo } from '../examples/types.js';
import { getAccountTransactions } from '../examples/account-transactions.js';
import { nlog } from './log-normalizer.js';
import { getCacheWithTimestamp } from './persist-cache.js';
import { RpcPoolConnection } from './rpc/pool-connection.js';

/**
 * WalletTransactionPreloader
 *
 * Problem: When analyzing a profile, we need transactions from both:
 * - Wallet Owner (signs fleet transactions)
 * - Wallet Fee Payer (pays the fees)
 *
 * Before: Each function would independently fetch the same wallets' transactions,
 * causing duplicate RPC calls.
 *
 * Solution: Pre-load transactions for BOTH wallets in parallel, once per profile analysis,
 * and reuse the same data for all downstream functions.
 *
 * Usage:
 *   const preloader = new WalletTransactionPreloader(rpcEndpoint, rpcWebsocket);
 *   await preloader.preloadForProfile(walletOwner, walletFeePayer, { hours: 24 });
 *   const ownerTxs = preloader.getTransactions(walletOwner);
 *   const payerTxs = preloader.getTransactions(walletFeePayer);
 */
export class WalletTransactionPreloader {
  private rpcEndpoint: string;
  private rpcWebsocket: string;
  private preloadedTransactions: Map<string, TransactionInfo[]> = new Map();
  private preloadInProgress: Map<string, Promise<TransactionInfo[]>> = new Map();
  private poolConnection: RpcPoolConnection | undefined;

  constructor(
    rpcEndpoint: string,
    rpcWebsocket: string,
    poolConnection?: RpcPoolConnection
  ) {
    this.rpcEndpoint = rpcEndpoint;
    this.rpcWebsocket = rpcWebsocket;
    this.poolConnection = poolConnection;
  }

  /**
   * Pre-load transactions for multiple wallets in parallel
   * This fetches them once and caches in memory for the session
   */
  async preloadForProfile(
    walletOwner: string,
    walletFeePayer: string,
    options: { hours?: number; refresh?: boolean } = {}
  ): Promise<{
    ownerTransactions: TransactionInfo[];
    payerTransactions: TransactionInfo[];
  }> {
    const hours = options.hours || 24;
    nlog(`[preloader] Starting pre-load for profile (owner: ${walletOwner.substring(0, 8)}..., payer: ${walletFeePayer.substring(0, 8)}...)`);

    const startTime = Date.now();

    // Determine time cutoff
    const cutoffMs = Date.now() - (hours * 60 * 60 * 1000);
    const sinceUnixMs = cutoffMs;

    // If owner and payer are the same wallet, fetch once and reuse
    let ownerTxs: TransactionInfo[] = [];
    let payerTxs: TransactionInfo[] = [];
    if (walletOwner === walletFeePayer) {
      ownerTxs = await this.loadWalletTransactions(walletOwner, sinceUnixMs, options);
      payerTxs = ownerTxs; // reuse same reference to avoid duplicate work
    } else {
      // Load both wallets in parallel
      [ownerTxs, payerTxs] = await Promise.all([
        this.loadWalletTransactions(walletOwner, sinceUnixMs, options),
        this.loadWalletTransactions(walletFeePayer, sinceUnixMs, options),
      ]);
    }

    const elapsedMs = Date.now() - startTime;
    nlog(
      `[preloader] ✅ Pre-load complete: ${ownerTxs.length} owner txs + ${payerTxs.length} payer txs in ${(elapsedMs / 1000).toFixed(1)}s`
    );

    return {
      ownerTransactions: ownerTxs,
      payerTransactions: payerTxs,
    };
  }

  /**
   * Load transactions for a single wallet
   * Returns cached data if already loaded, otherwise fetches fresh
   */
  private async loadWalletTransactions(
    wallet: string,
    sinceUnixMs: number,
    options: { refresh?: boolean } = {}
  ): Promise<TransactionInfo[]> {
    // Check if already in memory
    if (this.preloadedTransactions.has(wallet) && !options.refresh) {
      const cached = this.preloadedTransactions.get(wallet)!;
      nlog(`[preloader] Cache HIT for ${wallet.substring(0, 8)}... (${cached.length} txs)`);
      return cached;
    }

    // Check if fetch already in progress
    if (this.preloadInProgress.has(wallet)) {
      nlog(`[preloader] Fetch in progress for ${wallet.substring(0, 8)}..., waiting...`);
      return await this.preloadInProgress.get(wallet)!;
    }

    // Before fetching, check persistent transaction-cache on disk to avoid duplicate scans
    try {
      // Use floor-based hour computation to match cache keys produced elsewhere
      const hours = sinceUnixMs ? Math.max(1, Math.floor((Date.now() - sinceUnixMs) / (60 * 60 * 1000))) : 24;
      const cacheKey = `tx-cache-${wallet}-${hours}h`;
      if (!options.refresh) {
        const disk = await getCacheWithTimestamp<any>('transaction-cache', cacheKey);
        if (disk && disk.data && Array.isArray(disk.data.txs)) {
          const txs = disk.data.txs as TransactionInfo[];
          this.preloadedTransactions.set(wallet, txs);
          nlog(`[preloader] Disk cache HIT for ${wallet.substring(0, 8)}... (${txs.length} txs, age: ${((Date.now()-disk.savedAt)/60000).toFixed(1)}min)`);
          return txs;
        }
      }
    } catch (e) {
      // ignore disk read errors
    }

    // Perform fetch
    nlog(`[preloader] Fetching for ${wallet.substring(0, 8)}...`);
    const fetchPromise = getAccountTransactions(
      this.rpcEndpoint,
      this.rpcWebsocket,
      wallet,
      5000,  // limit
      sinceUnixMs,
      10000, // maxSignatures
      { refresh: options.refresh },
      this.poolConnection
    )
      .then(result => result.transactions)
      .finally(() => {
        this.preloadInProgress.delete(wallet);
      });

    this.preloadInProgress.set(wallet, fetchPromise);

    const txs = await fetchPromise;
    this.preloadedTransactions.set(wallet, txs);
    nlog(`[preloader] Loaded ${txs.length} txs for ${wallet.substring(0, 8)}...`);

    return txs;
  }

  /**
   * Get previously loaded transactions
   * Returns undefined if not yet loaded
   */
  getTransactions(wallet: string): TransactionInfo[] | undefined {
    return this.preloadedTransactions.get(wallet);
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.preloadedTransactions.clear();
    this.preloadInProgress.clear();
    nlog('[preloader] Cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    cachedWallets: number;
    totalTransactions: number;
    inProgressFetches: number;
  } {
    let totalTxs = 0;
    for (const txs of this.preloadedTransactions.values()) {
      totalTxs += txs.length;
    }
    return {
      cachedWallets: this.preloadedTransactions.size,
      totalTransactions: totalTxs,
      inProgressFetches: this.preloadInProgress.size,
    };
  }
}

// Global singleton for preloader
let globalPreloader: WalletTransactionPreloader | null = null;

export function getGlobalWalletTransactionPreloader(
  rpcEndpoint: string,
  rpcWebsocket: string,
  poolConnection?: RpcPoolConnection
): WalletTransactionPreloader {
  if (!globalPreloader) {
    globalPreloader = new WalletTransactionPreloader(rpcEndpoint, rpcWebsocket, poolConnection);
  }
  return globalPreloader;
}
