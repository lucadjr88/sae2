import { Program } from "@project-serum/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { byteArrayToString, readAllFromRPC } from "@staratlas/data-source";
import { Fleet, SAGE_IDL } from "@staratlas/sage";
import { newConnection, newAnchorProvider, withRetry } from '../utils/anchor-setup.js';
import { RpcPoolConnection } from '../utils/rpc/pool-connection.js';
import { nlog } from '../utils/log-normalizer.js';
import { getRpcMetrics } from '../utils/rpc-pool.js';
import { loadKeypair } from '../utils/wallet-setup.js';
import { setCache } from '../utils/persist-cache.js';
import { TransactionInfo } from './types.js';

const SAGE_PROGRAM_ID = "SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE";
const SRSLY_PROGRAM_ID = "SRSLY1fq9TJqCk1gNSE7VZL2bztvTn9wm4VR8u8jMKT";

export async function getFleets(rpcEndpoint: string, rpcWebsocket: string, walletPath: string, profileId: string) {
  let logPrefix = `[getFleets][${profileId.substring(0,8)}]`;
  const startTime = Date.now();
  
  const connStart = Date.now();
  const connection = newConnection(rpcEndpoint, rpcWebsocket);
  
  const walletStart = Date.now();
  const wallet = loadKeypair(walletPath);
  
  const providerStart = Date.now();
  const provider = newAnchorProvider(connection, wallet);

  const programStart = Date.now();
  const sageProgram = new Program(SAGE_IDL, SAGE_PROGRAM_ID, provider);
  const playerProfilePubkey = new PublicKey(profileId);


  // Helper function to retry readAllFromRPC with exponential backoff
  async function readAllFromRPCWithRetry(
    conn: Connection,
    prog: any,
    dataClass: any,
    commitment: any,
    filters: any,
    maxRetries: number = 3
  ) {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await readAllFromRPC(conn, prog, dataClass, commitment, filters);
        return result;
      } catch (err: any) {
        lastError = err;
        const msg = err?.message?.toLowerCase() || '';
        const is429 = msg.includes('429') || msg.includes('rate limit');
        const delay = is429 ? (500 * Math.pow(2, attempt)) : (200 * Math.pow(1.5, attempt));
        
        if (attempt < maxRetries) {
          // retrying readAllFromRPC (suppressed verbose log)
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  // Get fleets owned and rented in parallel for faster execution
  const fetchStart = Date.now();
  
  const [ownedFleets, rentedFleets] = await Promise.all([
    // Owned fleets: owningProfile matches at offset 41
    readAllFromRPCWithRetry(
      connection,
      sageProgram as any,
      Fleet,
      'processed',
      [{
        memcmp: {
          offset: 41, // 8 (discriminator) + 1 (version) + 32 (gameId) = 41
          bytes: playerProfilePubkey.toBase58(),
        },
      }],
    ),
    // Rented fleets: subProfile matches at offset 73
    readAllFromRPCWithRetry(
      connection,
      sageProgram as any,
      Fleet,
      'processed',
      [{
        memcmp: {
          offset: 73, // subProfile offset
          bytes: playerProfilePubkey.toBase58(),
        },
      }],
    ),
  ]);
  
  

  // Combine both owned and rented fleets
  const fleets = [...ownedFleets, ...rentedFleets];
  const knownFleetKeys = new Set<string>(fleets.filter((f: any) => f && (f as any).key)
    .map((f: any) => (f as any).key.toString()));
  
  // NEW: Also find fleets that have recent transactions signed by the wallet
  // This catches borrowed/rented fleets that don't have player profile in subProfile
  let walletAuthority: string | null = null;
  // Diagnostics to return for debugging/UX
  let primaryPayerCounts: Array<[string, number]> = [];
  let fallbackPayerCounts: Array<[string, number]> = [];
  let totalPrimaryTxs = 0;
  let totalFallbackTxs = 0;
  const additionalFleetKeys = new Set<string>();
  // Track fleets discovered via heuristics to mark them as rented later
  const walletHeuristicKeys = new Set<string>();
  const srslyHeuristicKeys = new Set<string>();
  // Track fleets that show recent usage by the derived wallet (fee payer)
  const operatedByWalletKeys = new Set<string>();
  
  // First, derive wallet by scanning recent tx across fleets and counting fee payers
  if (fleets.length > 0) {
    try {
      const payerCounts = new Map<string, number>();
      const sampleFleets = fleets.slice(0, Math.min(10, fleets.length));
      
      // Adaptive delay for wallet derivation phase
      let derivDelay = 100; // ms
      const MIN_DERIVE_DELAY = 80;
      const MAX_DERIVE_DELAY = 1500;
      const DERIVE_BACKOFF_MULTIPLIER = 1.5;
      let derivSuccesses = 0;
      let derivErrors = 0;
      
      function derivSleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
      
      // Create RPC pool connection once for reuse
      const poolConnection = new RpcPoolConnection(connection);

      for (const f of sampleFleets) {
        const fleetKey = (f as any).key.toString();
        
        // Use RPC pool for getSignaturesForAddress with timeout
        let signatures: any[] = [];
        let sigFetchSuccess = false;
        
        try {
          signatures = await poolConnection.getSignaturesForAddress(new PublicKey(fleetKey), {
            limit: 3,
            timeoutMs: 4000,
            maxRetries: 1,
            logErrors: false,
          });
          
          if (signatures.length > 0) {
            sigFetchSuccess = true;
            derivSuccesses++;
          } else {
            derivErrors++;
          }
        } catch (err) {
          derivErrors++;
        }
        
        // Process fetched signatures with timeout on getParsedTransaction
        for (const sig of signatures) {
          try {
            const tx = await poolConnection.getParsedTransaction(sig.signature, {
              maxSupportedTransactionVersion: 0,
              timeoutMs: 3000,
              maxRetries: 0,
              logErrors: false,
            });
            
            if (tx) {
              const feePayer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toString();
              if (feePayer) payerCounts.set(feePayer, (payerCounts.get(feePayer) || 0) + 1);
            }
          } catch (err) {
            // tolerate errors, poolConnection already handles fallback
          }
        }
        
        // Adaptive delay after each fleet (not just at end)
        if (sigFetchSuccess) {
          derivSuccesses++;
          if (derivSuccesses > 2) {
            derivDelay = Math.max(MIN_DERIVE_DELAY, derivDelay - 10);
            derivSuccesses = 0;
          }
        } else {
          derivErrors++;
          if (derivErrors > 1) {
            derivDelay = Math.min(MAX_DERIVE_DELAY, derivDelay * DERIVE_BACKOFF_MULTIPLIER);
            derivErrors = 0;
          }
        }
        
        // Apply delay before next fleet
        if (sampleFleets.indexOf(f) < sampleFleets.length - 1) {
          await derivSleep(derivDelay);
        }
      }
      // Pick the most frequent payer
      let topPayer: string | null = null;
      let topCount = 0;
      for (const [payer, count] of payerCounts.entries()) {
        if (count > topCount) { topCount = count; topPayer = payer; }
      }
      if (topPayer) {
        totalPrimaryTxs = Array.from(payerCounts.values()).reduce((s, v) => s + v, 0);
        const proportion = totalPrimaryTxs > 0 ? (topCount / totalPrimaryTxs) : 0;
        // Accept primary-derived payer only if confident: either absolute occurrences or majority
        if (topCount >= 10 || proportion >= 0.5) {
          walletAuthority = topPayer;
          // Derived wallet authority accepted (suppressed verbose log)
        } else {
          // Primary derivation candidate below confidence (suppressed verbose log)
        }
      }
      // Save primary payer counts for diagnostics
      primaryPayerCounts = Array.from(payerCounts.entries()).sort((a,b) => b[1]-a[1]).slice(0, 20);
      // Fallback: if no walletAuthority found, perform a deeper scan across more signatures
      if (!walletAuthority) {
        try {
          // Primary pass failed — running extended fallback scan (verbose log suppressed)
          const fallbackPayers = new Map<string, number>();
          const fallbackFleets = fleets.slice(0, Math.min(20, fleets.length));
          let totalSigs = 0;
          let totalTxs = 0;
          for (const f of fallbackFleets) {
            const fk = (f as any).key.toString();
            let sigs: any[] = [];
            try {
              // Use RPC pool for fallback scan too
              sigs = await poolConnection.getSignaturesForAddress(new PublicKey(fk), {
                limit: 50,
                timeoutMs: 4000,
                maxRetries: 1,
                logErrors: false,
              });
            } catch (err) {
              console.warn(`[wallet-derive] Could not fetch signatures for ${fk}:`, (err as any)?.message || String(err));
              continue;
            }
            totalSigs += sigs.length;
            // Limit txs per fleet to avoid runaway usage
            const sigSlice = sigs.slice(0, 20);
            for (const s of sigSlice) {
              try {
                const ptx = await poolConnection.getParsedTransaction(s.signature, {
                  maxSupportedTransactionVersion: 0,
                  timeoutMs: 3000,
                  maxRetries: 0,
                  logErrors: false,
                });
                totalTxs++;
                if (!ptx) continue;
                const payer = ptx?.transaction?.message?.accountKeys?.[0]?.pubkey?.toString?.();
                if (payer) fallbackPayers.set(payer, (fallbackPayers.get(payer) || 0) + 1);
              } catch (err) {
                // tolerate errors
              }
            }
          }
          // Extended scan summary (suppressed verbose logs)
          const sorted = Array.from(fallbackPayers.entries()).sort((a,b) => b[1]-a[1]).slice(0,10);
          // Save fallback diagnostics
          fallbackPayerCounts = Array.from(fallbackPayers.entries()).sort((a,b) => b[1]-a[1]).slice(0, 50);
          totalFallbackTxs = totalTxs;
          let best: string | null = null;
          let bestCount = 0;
          for (const [p, c] of fallbackPayers.entries()) {
            if (c > bestCount) { best = p; bestCount = c; }
          }
          if (best) {
            const proportionFallback = totalTxs > 0 ? (bestCount / totalTxs) : 0;
            // Accept fallback-derived payer if it meets absolute or proportional threshold
            if (bestCount >= 10 || proportionFallback >= 0.5) {
              walletAuthority = best;
              // Fallback-derived walletAuthority accepted (suppressed verbose log)
            } else {
              // Fallback candidate below confidence (suppressed verbose log)
            }
          } else {
            console.warn('[wallet-derive] Fallback scan failed to derive walletAuthority');
          }
        } catch (err) {
          console.error('[wallet-derive] Extended fallback failed:', err);
        }
      }
    } catch (error) {
      console.error('Error deriving wallet:', error);
    }
  }
  
  // OPTIMIZED: Analyze wallet transactions and extract SAGE fleet accounts
  if (walletAuthority) {
    try {
      // Analyzing wallet transactions for SAGE fleet involvement (verbose log suppressed)
      const cutoffMs = Date.now() - (24 * 60 * 60 * 1000); // 24h cutoff
      
      // Collect wallet signatures with early cutoff - process in chunks of 500
      const walletSignatures: any[] = [];
      let before: string | undefined = undefined;
      const maxToAnalyze = 5000; // Allow more for 24h coverage, but process efficiently
      
      nlog('[wallet-scan] Fetching recent wallet signatures (up to 5000 for 24h)...');
      let fetchBatchCount = 0;
      
      // Adaptive delay like in account-transactions.ts
      let currentDelay = 120; // ms
      const MIN_DELAY = 90;
      const MAX_DELAY = 2000;
      const BACKOFF_MULTIPLIER = 1.6;
      const SUCCESS_DECREASE_STEP = 10;
      let successStreak = 0;
      let consecutiveErrors = 0;
      function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
      
      // Create pool connection for wallet signature scanning
      const poolConnection2 = new RpcPoolConnection(connection);
      
      while (walletSignatures.length < maxToAnalyze) {
        fetchBatchCount++;
        
        // Use RPC pool with retry logic
        let batch: any[] = [];
        let batchSuccess = false;
        try {
          batch = await poolConnection2.getSignaturesForAddress(
            new PublicKey(walletAuthority),
            { 
              limit: 100,  // Reduced from 200 to 100 for less aggression
              before,
              timeoutMs: 8000,
              maxRetries: 1,
              logErrors: false,
            }
          );
          batchSuccess = true;
        } catch (err: any) {
          // Handle rate limiting
          if (err?.message?.includes('429')) {
            nlog('[wallet-scan] Rate limited (429), backoff delay: ' + currentDelay + 'ms');
            consecutiveErrors++;
            if (consecutiveErrors > 2) {
              currentDelay = Math.min(MAX_DELAY, currentDelay * BACKOFF_MULTIPLIER);
            }
            await sleep(Math.max(1000, currentDelay));
          }
          batch = [];
        }
        
        // Log RPC metrics every batch
        const metrics = poolConnection2.getMetrics();
        const healthyCount = metrics.filter(m => m.healthy).length;
        const totalProcessed = metrics.reduce((sum, m) => sum + m.processedTxs, 0);
        const avgLatency = metrics.length > 0 ? Math.round(metrics.reduce((sum, m) => sum + (m.avgLatencyMs || 0), 0) / metrics.length) : 0;
        
        nlog(`[wallet-scan] Batch ${fetchBatchCount}: ${batch.length} sigs, total: ${walletSignatures.length}, delay: ${currentDelay}ms | RPC: ${healthyCount}/${metrics.length} healthy, ${totalProcessed} processed, ${avgLatency}ms avg latency`);
        
        // Adaptive delay after each batch
        if (batchSuccess) {
          successStreak++;
          consecutiveErrors = 0;
          if (successStreak > 3) {
            currentDelay = Math.max(MIN_DELAY, currentDelay - SUCCESS_DECREASE_STEP);
            successStreak = 0;
          }
        } else {
          successStreak = 0;
          if (batch.length > 0) {
            // Soft failure, had some results
            consecutiveErrors++;
            if (consecutiveErrors > 1) {
              currentDelay = Math.min(MAX_DELAY, currentDelay * BACKOFF_MULTIPLIER);
            }
          }
        }
        
        // Apply delay before next batch
        if (walletSignatures.length < maxToAnalyze && batch.length > 0) {
          await sleep(currentDelay);
        }
        
        if (batch.length === 0) break;
        
        for (const sig of batch) {
          const btMs = sig.blockTime ? sig.blockTime * 1000 : 0;
          // Early cutoff if older than 24h
          if (sig.blockTime && btMs < cutoffMs) {
            nlog(`[wallet-scan] cutoff reached at ${new Date(btMs).toISOString()}`);
            break;
          }
          walletSignatures.push(sig);
          if (walletSignatures.length >= maxToAnalyze) break;
        }
        
        if (walletSignatures.length >= maxToAnalyze) break;
        const last = batch[batch.length - 1];
        before = last.signature;
        if (last.blockTime && (last.blockTime * 1000) < cutoffMs) break;
      }
      
      nlog(`[wallet-scan] Collected ${walletSignatures.length} signatures`);
      
      // Now extract fleet accounts from these transactions efficiently
      const preAnalysisMetrics = poolConnection2.getMetrics();
      const preHealthy = preAnalysisMetrics.filter(m => m.healthy).length;
      nlog(`[tx-analysis] Processing ${walletSignatures.length} wallet transactions...`);
      nlog(`[tx-analysis] RPC pool status: ${preHealthy}/${preAnalysisMetrics.length} healthy endpoints`);
      
      let analyzedCount = 0;
      const fleetCandidates = new Set<string>();
      const startTime = Date.now();
      
      // Create RPC pool connection for parallelized fetching
      const poolConnection = new RpcPoolConnection(connection);
      
      // Collect transactions in TransactionInfo format for caching
      const collectedTransactions: TransactionInfo[] = [];
      
      // Parallelized processing: fetch transactions in chunks and process concurrently
      const chunkSize = 50; // number of signatures to fetch concurrently per batch
      const timeoutMs = 8000; // per-request timeout

      function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
        return new Promise(resolve => {
          let done = false;
          const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
          p.then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } }).catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
        });
      }

      for (let i = 0; i < walletSignatures.length; i += chunkSize) {
        const batch = walletSignatures.slice(i, i + chunkSize);
        const fetchPromises = batch.map((s, idx) =>
          withTimeout(
            poolConnection.getParsedTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
            }),
            timeoutMs + 500
          ).then(tx => ({ sig: batch[idx], tx }))
        );
        const results = await Promise.all(fetchPromises);

        for (let j = 0; j < results.length; j++) {
          const { sig, tx } = results[j];
          analyzedCount++;
          if (analyzedCount % 25 === 0 || analyzedCount === 1) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const rate = (analyzedCount / (Date.now() - startTime) * 1000).toFixed(2);
            const metrics = poolConnection.getMetrics();
            const healthyCount = metrics.filter(m => m.healthy).length;
            const totalSuccesses = metrics.reduce((sum, m) => sum + m.successes, 0);
            const totalFailures = metrics.reduce((sum, m) => sum + m.failures, 0);
            const successRate = totalSuccesses + totalFailures > 0 ? ((totalSuccesses / (totalSuccesses + totalFailures)) * 100).toFixed(0) : '0';
            const avgLatency = metrics.length > 0 ? Math.round(metrics.reduce((sum, m) => sum + (m.avgLatencyMs || 0), 0) / metrics.filter(m => m.avgLatencyMs).length) : 0;
            // tx-analysis progress suppressed
          }

            if (!tx) {
              // occasional tx fetch timeout (suppressed warning)
              continue;
            }

          try {
            // Collect transaction data for caching
            const txTime = sig.blockTime || Math.floor(Date.now() / 1000);
            const parsed: any = tx;
            const programIds: string[] = [];
            try {
              if (parsed && parsed.transaction && parsed.transaction.message && Array.isArray(parsed.transaction.message.instructions)) {
                for (const ix of parsed.transaction.message.instructions) {
                  if (ix.programId) programIds.push(ix.programId.toString());
                }
              }
            } catch (e) {}
            const instructions: string[] = [];
            const logMessages: string[] = parsed?.meta?.logMessages || [];
            logMessages.forEach((log: string) => {
              const ixMatch = log.match(/Instruction: (\w+)/);
              if (ixMatch) instructions.push(ixMatch[1]);
            });

            const txInfo: TransactionInfo = {
              signature: sig.signature,
              blockTime: sig.blockTime || 0,
              slot: (sig as any).slot || 0,
              err: parsed?.meta?.err || null,
              timestamp: new Date(txTime * 1000).toISOString(),
              status: parsed?.meta?.err ? 'failed' : 'success',
              fee: parsed?.meta?.fee || 0,
              programIds: [...new Set(programIds)],
              instructions: [...new Set(instructions)],
              logMessages,
              accountKeys: ((parsed?.transaction?.message?.accountKeys || [])).map((k: any) => k?.pubkey ? k.pubkey.toString() : (typeof k === 'string' ? k : '')).filter((k: string) => k),
            };
            collectedTransactions.push(txInfo);

            const accountKeys = (tx as any).transaction?.message?.staticAccountKeys || (tx as any).transaction?.message?.accountKeys || [];
            const hasSage = accountKeys.some((key: any) => key && key.toString && key.toString() === SAGE_PROGRAM_ID);
            if (!hasSage) continue;
            for (const accountKey of accountKeys) {
              const account = accountKey.toString();
              if (knownFleetKeys.has(account)) continue;
              if (account === SAGE_PROGRAM_ID) continue;
              if (account === walletAuthority) continue;
              fleetCandidates.add(account);
            }
          } catch (e) {
            // tolerate per-tx parse errors
          }
        }
        // brief pause between batches to reduce burst pressure
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Found potential fleet accounts from transactions (verbose log suppressed)
      
      // Save collected transactions to persistent cache so preloader can find them
      if (walletAuthority && collectedTransactions.length > 0) {
        try {
          const hours = Math.max(1, Math.floor((Date.now() - cutoffMs) / (60 * 60 * 1000)));
          const cacheKey = `tx-cache-${walletAuthority}-${hours}h`;
          await setCache('transaction-cache', cacheKey, { txs: collectedTransactions, fetched: Date.now() });
          nlog(`[fleets] Cached ${collectedTransactions.length} txs for ${walletAuthority.substring(0,8)}... (${hours}h window)`);
        } catch (e) {
          console.error('[fleets] Error caching transactions:', e);
        }
      }
      
      // Now verify which candidates are actually fleet accounts (536 bytes, SAGE owner)
      let verifiedCount = 0;
      for (const candidate of fleetCandidates) {
        verifiedCount++;
        if (verifiedCount % 50 === 0) {
          // candidate verification progress suppressed
        }
        
        try {
          const accountInfo = await connection.getAccountInfo(new PublicKey(candidate));
          if (!accountInfo) continue;
          if (accountInfo.data.length !== 536) continue;
          if (accountInfo.owner.toString() !== SAGE_PROGRAM_ID) continue;
          
          // This is a fleet account!
          additionalFleetKeys.add(candidate);
        } catch {
          // Skip invalid accounts
        }
      }
      
      // verified fleet accounts with recent wallet activity (suppressed log)
      
      // Fetch full fleet data for additional fleets
      for (const fleetKey of additionalFleetKeys) {
        try {
          // Fetch by direct pubkey via Anchor account fetch
          const fleetPubkey = new PublicKey(fleetKey);
          // @ts-ignore - account type name from IDL
          const accountData = await (sageProgram.account as any).fleet.fetch(fleetPubkey);
          if (accountData) {
            const wrapped = {
              type: 'ok',
              key: fleetPubkey,
              data: { data: accountData },
            } as any;
            fleets.push(wrapped);
            knownFleetKeys.add(fleetKey);
            // Added rented fleet (wallet heuristic) (log suppressed)
            walletHeuristicKeys.add(fleetKey);
          }
        } catch (error) {
          console.error(`Error fetching fleet ${fleetKey}:`, error);
        }
      }
    } catch (error) {
      console.error('Error searching for rented fleets:', error);
    }

    // Additionally: mark fleets that clearly show recent usage by this wallet as RENTED if not owned by player
    try {
      const poolConn = new RpcPoolConnection(connection);
      const sample = fleets.filter((f: any) => f && (f as any).key).slice(0, Math.min(20, fleets.length));
      for (const f of sample) {
        const fk = (f as any).key.toString();
        try {
          const sigs = await connection.getSignaturesForAddress(new PublicKey(fk), { limit: 2 });
          let usedByWallet = false;
          for (const s of sigs) {
            try {
              const tx = await poolConn.getParsedTransaction(s.signature, {
                maxSupportedTransactionVersion: 0,
                timeoutMs: 3000,
                maxRetries: 0,
                logErrors: false,
              });
              const payer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toString();
              if (payer === walletAuthority) { usedByWallet = true; break; }
            } catch (err) {
              // tolerate errors
            }
          }
          if (usedByWallet) operatedByWalletKeys.add(fk);
        } catch {}
      }
      // Wallet usage evidence summary (suppressed verbose log)
    } catch {}
  }

  // NEW: SRSLY rentals scan - identify fleets referenced by the rentals program for this profile
  // Starting SRSLY scan (verbose logs suppressed)
  try {
    const srslyProgramKey = new PublicKey(SRSLY_PROGRAM_ID);
    
    // Retry logic for SRSLY scan with exponential backoff
    let accounts;
    let srslyRetries = 0;
    const maxSrslyRetries = 3;
    while (srslyRetries < maxSrslyRetries) {
      // SRSLY scan attempt (suppressed verbose log)
      try {
        accounts = await withRetry(() => connection.getProgramAccounts(srslyProgramKey));
        // SRSLY getProgramAccounts success (suppressed verbose log)
        break;
      } catch (err) {
        srslyRetries++;
        const delay = Math.min(1000 * Math.pow(2, srslyRetries), 5000); // exponential backoff, max 5s
        console.warn(`${logPrefix} [SRSLY] Fetch failed (attempt ${srslyRetries}/${maxSrslyRetries}): ${err instanceof Error ? err.message : String(err)}`);
        if (srslyRetries < maxSrslyRetries) {
          // SRSLY retry suppressed
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!accounts) {
      console.warn(`${logPrefix} [SRSLY] Failed to fetch program accounts after retries, skipping SRSLY scan`);
      accounts = [];
    }

    // Helper to find byte subsequence
    const bufIncludes = (haystack: Uint8Array, needle: Uint8Array) => {
      outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    };

    const borrowerBytes = playerProfilePubkey.toBytes();
    const srslyWithBorrower = accounts.filter(a => a.account.data && bufIncludes(a.account.data, borrowerBytes) !== -1);
    // SRSLY: found accounts referencing borrower profile (log suppressed)

    // From those accounts, collect all 32-byte windows and probe for SAGE fleet accounts
    const candidateKeys = new Set<string>();
    for (const { account } of srslyWithBorrower) {
      const data = account.data;
      if (!data || data.length < 32) continue;
      for (let i = 0; i <= data.length - 32; i++) {
        const slice = data.subarray(i, i + 32);
        try {
          const pk = new PublicKey(slice);
          candidateKeys.add(pk.toBase58());
        } catch { /* ignore invalid keys */ }
      }
    }

    // Batch-check candidates in chunks with error handling
    const candidates = Array.from(candidateKeys);
    // SRSLY: checking candidate fleet keys (log suppressed)
    const chunkSize = 50;
    const discoveredFleetKeys: string[] = [];
    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize).map(k => new PublicKey(k));
      try {
        const infos = await connection.getMultipleAccountsInfo(chunk);
        for (let j = 0; j < chunk.length; j++) {
          const info = infos[j];
          if (!info) continue;
          if (info.owner.toBase58() === SAGE_PROGRAM_ID && info.data.length === 536) {
            const k = chunk[j].toBase58();
            if (!knownFleetKeys.has(k)) {
              discoveredFleetKeys.push(k);
              // Discovered candidate fleet (suppressed verbose log)
            }
          }
        }
      } catch (err) {
        console.warn(`[SRSLY] Error checking candidate batch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fetch and append these fleets as rented
    // SRSLY: fetching discovered fleets (log suppressed)
    for (const k of discoveredFleetKeys) {
      try {
        const fleetPubkey = new PublicKey(k);
        // @ts-ignore - account type name from IDL
        const accountData = await (sageProgram.account as any).fleet.fetch(fleetPubkey);
        if (accountData) {
          const wrapped = {
            type: 'ok',
            key: fleetPubkey,
            data: { data: accountData },
          } as any;
          fleets.push(wrapped);
          knownFleetKeys.add(k);
          // Added rented fleet (SRSLY heuristic) (log suppressed)
          srslyHeuristicKeys.add(k);
        }
      } catch (e) {
        console.warn(`${logPrefix} [SRSLY] Failed to fetch fleet ${k.substring(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    
    // SRSLY scan complete (suppressed verbose log)
  } catch (e) {
    console.error(`${logPrefix} [SRSLY] Scan failed (non-fatal), continuing without SRSLY data: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (fleets.length === 0) {
    console.warn(`${logPrefix} Nessuna fleet trovata dopo scansione SAGE/SRSLY. Avvio fallback wallet discovery.`);
    // Nessuna flotta trovata: fallback per derivare il wallet public key dal profilo
    try {
      const poolConnection = new RpcPoolConnection(connection);
      const sigs = await poolConnection.getSignaturesForAddress(playerProfilePubkey, {
        limit: 20,
        timeoutMs: 4000,
        maxRetries: 1,
        logErrors: false,
      });
      const payerCounts = new Map<string, number>();
      for (const s of sigs) {
        try {
          const tx = await poolConnection.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            timeoutMs: 3000,
            maxRetries: 0,
            logErrors: false,
          });
          const payer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toString();
          if (payer) payerCounts.set(payer, (payerCounts.get(payer) || 0) + 1);
        } catch {}
      }
      let topPayer: string | null = null;
      let topCount = 0;
      for (const [payer, count] of payerCounts.entries()) {
        if (count > topCount) { topCount = count; topPayer = payer; }
      }
      walletAuthority = topPayer;
    } catch (e) {
      // fallback non riuscito
      walletAuthority = null;
    }
    console.warn(`${logPrefix} Fallback walletAuthority: ${walletAuthority}`);
    return {
      fleets: [],
      walletAuthority: walletAuthority
    };
  }

  // Pre-extract owningProfile and subProfile from raw account bytes for robustness
  const keyList: PublicKey[] = fleets
    .filter((f: any) => f && f.type === 'ok' && (f as any).key)
    .map((f: any) => (f as any).key as PublicKey);

  const ownerByKey = new Map<string, string | null>();
  const subByKey = new Map<string, string | null>();
  try {
    const chunkSize = 50;
    for (let i = 0; i < keyList.length; i += chunkSize) {
      const chunk = keyList.slice(i, i + chunkSize);
      // Retry getMultipleAccountsInfo per-chunk with exponential backoff to tolerate 429s
      let infos: (import('@solana/web3.js').AccountInfo<Buffer> | null)[] | null = null;
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          infos = await connection.getMultipleAccountsInfo(chunk);
          break;
        } catch (err: any) {
          const msg = err?.message || String(err);
          const is429 = msg.includes('429') || msg.toLowerCase().includes('rate limit') || err?.code === 15;
          const delay = is429 ? (500 * Math.pow(2, attempt)) : (200 * Math.pow(1.5, attempt));
          if (attempt < maxRetries) {
            console.warn(`[fleets] getMultipleAccountsInfo chunk attempt ${attempt + 1} failed (${is429 ? '429' : 'err'}), retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          } else {
            console.error(`[fleets] getMultipleAccountsInfo failed after ${maxRetries + 1} attempts:`, err?.message || err);
          }
        }
      }
      if (!infos) {
        // Mark all in chunk as unknown so processing can continue
        for (const pk of chunk) {
          ownerByKey.set(pk.toBase58(), null);
          subByKey.set(pk.toBase58(), null);
        }
        continue;
      }
      for (let j = 0; j < chunk.length; j++) {
        const info = infos[j];
        const k = chunk[j].toBase58();
        if (info?.data && info.data.length >= 105) {
          try {
            const ownerPk = new PublicKey(info.data.slice(41, 73)).toBase58();
            const subPk = new PublicKey(info.data.slice(73, 105)).toBase58();
            ownerByKey.set(k, ownerPk);
            subByKey.set(k, subPk);
          } catch {
            ownerByKey.set(k, null);
            subByKey.set(k, null);
          }
        } else {
          ownerByKey.set(k, null);
          subByKey.set(k, null);
        }
      }
    }
  } catch (e) {
    console.error('Failed to pre-extract owner/subProfile from accounts:', e);
  }

  // Fleet discovery complete (summary log suppressed)
  const fleetsData = fleets
    .filter((f: any) => f.type === 'ok')
    .map((fleet: any) => {
      const subProfile = fleet.data.data.subProfile;
      const owningProfile = fleet.data.data.owningProfile;
      const keyStr = fleet.key.toString();

      // Resolve base58 strings using raw account bytes first, then fallbacks
      const ownerStr = ownerByKey.get(keyStr) ?? (typeof (owningProfile as any)?.toBase58 === 'function'
        ? (owningProfile as any).toBase58()
        : (typeof (owningProfile as any)?.toString === 'function'
          ? (owningProfile as any).toString()
          : null));
      const subStr = subByKey.get(keyStr) ?? (typeof (subProfile as any)?.toBase58 === 'function'
        ? (subProfile as any).toBase58()
        : (typeof (subProfile as any)?.toString === 'function'
          ? (subProfile as any).toString()
          : null));
      
      // A fleet is RENTED when any of the following is true:
      // 1) You are the subProfile (you use it) AND you are NOT the owner
      // 2) It was discovered via wallet heuristic AND it's not owned by you
      // 3) It was discovered via SRSLY rental scan AND it's not owned by you
      const rentedBySubProfile = !!(
        subStr &&
        subStr === playerProfilePubkey.toBase58() &&
        ownerStr &&
        ownerStr !== playerProfilePubkey.toBase58()
      );
      const rentedByWalletHeuristic = !!(
        (walletHeuristicKeys.has(keyStr) || operatedByWalletKeys.has(keyStr)) &&
        // treat unknown owner as not owned by player
        (ownerStr ? (ownerStr !== playerProfilePubkey.toBase58()) : true)
      );
      const rentedBySrsly = !!(
        srslyHeuristicKeys.has(keyStr) &&
        (ownerStr ? (ownerStr !== playerProfilePubkey.toBase58()) : true)
      );
      const isRented = rentedBySubProfile || rentedByWalletHeuristic || rentedBySrsly;

      try {
        const name = byteArrayToString(fleet.data.data.fleetLabel) || '<unnamed>';
        //console.log(
        //  `[fleets] ${name} | key=${keyStr} | owner=${ownerStr} | sub=${subStr} | flags: subMatch=${subStr===playerProfilePubkey.toString()} ownerMatch=${ownerStr===playerProfilePubkey.toString()} walletHeuristic=${walletHeuristicKeys.has(keyStr)} srslyHeuristic=${srslyHeuristicKeys.has(keyStr)} => isRented=${isRented}`
        //);
      } catch {}
      
      return {
        callsign: byteArrayToString(fleet.data.data.fleetLabel),
        key: fleet.key.toString(),
        data: fleet.data.data,
        isRented: isRented
      };
    });

  // Build owner frequency map to attempt to derive a walletOwner (primary owner wallet)
  const ownerCounts = new Map<string, number>();
  for (const f of fleets) {
    try {
      const k = (f as any).key?.toString?.();
      const owner = k ? ownerByKey.get(k) : null;
      if (owner && owner !== playerProfilePubkey.toBase58()) {
        ownerCounts.set(owner, (ownerCounts.get(owner) || 0) + 1);
      }
    } catch {}
  }

  let walletOwner: string | null = null;
  if (ownerCounts.size > 0) {
    const sorted = Array.from(ownerCounts.entries()).sort((a, b) => b[1] - a[1]);
    const [candidate, count] = sorted[0];
    if (candidate) walletOwner = candidate;
  }

  return {
    fleets: fleetsData,
    walletAuthority: walletAuthority,
    walletOwner: walletOwner,
    ownerByKey: Object.fromEntries(Array.from(ownerByKey.entries()))
  };
}
