import { Program } from "@project-serum/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { byteArrayToString, readAllFromRPC } from "@staratlas/data-source";
import { Fleet, SAGE_IDL } from "@staratlas/sage";
import { newConnection, newAnchorProvider, withRetry } from '../utils/anchor-setup.js';
import { RpcPoolConnection } from '../utils/rpc/pool-connection.js';
import { nlog } from '../utils/log-normalizer.js';
import { getRpcMetrics } from '../utils/rpc-pool.js';
import { loadKeypair } from '../utils/wallet-setup.js';

const SAGE_PROGRAM_ID = "SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE";
const SRSLY_PROGRAM_ID = "SRSLY1fq9TJqCk1gNSE7VZL2bztvTn9wm4VR8u8jMKT";

export async function getFleets(rpcEndpoint: string, rpcWebsocket: string, walletPath: string, profileId: string) {
  console.log(`[fleets] start ${profileId}`);
  const startTime = Date.now();
  
  console.log(`[fleets] conn -> ${rpcEndpoint}`);
  const connStart = Date.now();
  const connection = newConnection(rpcEndpoint, rpcWebsocket);
  console.log(`[fleets] conn ok ${Date.now() - connStart}ms`);
  
  console.log(`[fleets] wallet -> ${walletPath}`);
  const walletStart = Date.now();
  const wallet = loadKeypair(walletPath);
  console.log(`[fleets] wallet ok ${Date.now() - walletStart}ms`);
  
  console.log(`[fleets] provider ->`);
  const providerStart = Date.now();
  const provider = newAnchorProvider(connection, wallet);
  console.log(`[fleets] provider ok ${Date.now() - providerStart}ms`);

  console.log(`[fleets] program ->`);
  const programStart = Date.now();
  const sageProgram = new Program(SAGE_IDL, SAGE_PROGRAM_ID, provider);
  const playerProfilePubkey = new PublicKey(profileId);
  console.log(`[fleets] program ok ${Date.now() - programStart}ms`);
  console.log(`[fleets] setup ${Date.now() - startTime}ms`);


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
          console.log(`[readAllFromRPC] Attempt ${attempt + 1} failed (${is429 ? '429' : 'other'}), retrying in ${delay}ms...`, err?.message);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  // Get fleets owned and rented in PARALLEL for faster execution
  console.log(`[fleets] fetch owned+rented ...`);
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
  
  console.log(`[getFleets] Found ${ownedFleets.length} owned + ${rentedFleets.length} rented fleets in ${Date.now() - fetchStart}ms (parallel fetch)`);

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
          console.log('Derived wallet authority (tallied):', walletAuthority, 'from', topCount, 'occurrences', `(proportion=${proportion.toFixed(2)})`);
        } else {
          console.log('Primary derivation found candidate but confidence too low:', topPayer, topCount, 'of', totalPrimaryTxs, `(proportion=${proportion.toFixed(2)})`);
        }
      }
      // Save primary payer counts for diagnostics
      primaryPayerCounts = Array.from(payerCounts.entries()).sort((a,b) => b[1]-a[1]).slice(0, 20);
      // Fallback: if no walletAuthority found, perform a deeper scan across more signatures
      if (!walletAuthority) {
        try {
          console.log('[wallet-derive] Primary pass failed — running extended fallback scan');
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
          console.log(`[wallet-derive] Extended scan: signatures fetched=${totalSigs}, transactions parsed=${totalTxs}`);
          // Log top fallback payers for diagnostics
          const sorted = Array.from(fallbackPayers.entries()).sort((a,b) => b[1]-a[1]).slice(0,10);
          console.log('[wallet-derive] Fallback payer counts (top 10):', sorted);
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
              console.log('[wallet-derive] Fallback derived walletAuthority:', walletAuthority, 'count:', bestCount, `(proportion=${proportionFallback.toFixed(2)})`);
            } else {
              console.log('[wallet-derive] Fallback candidate found but confidence too low:', best, bestCount, 'of', totalTxs, `(proportion=${proportionFallback.toFixed(2)})`);
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
      console.log('Analyzing wallet transactions for SAGE fleet involvement (optimized)...');
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
        const fetchPromises = batch.map(s =>
          withTimeout(
            poolConnection.getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              timeoutMs,
              maxRetries: 0,
            }),
            timeoutMs + 500
          )
        );
        const results = await Promise.all(fetchPromises);

        for (let j = 0; j < results.length; j++) {
          const tx = results[j];
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
            console.log(`[tx-analysis]\t${analyzedCount}/${walletSignatures.length} txs\t${elapsed}s\t${rate} tx/s\t${healthyCount}/${metrics.length} RPC\t${successRate}% ok\t${avgLatency}ms`);
          }

          if (!tx) {
            if (analyzedCount % 200 === 0) console.log(`[tx-analysis] Warning: tx ${analyzedCount} returned null or timed out`);
            continue;
          }

          try {
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
      console.log(`[tx-analysis] Found ${fleetCandidates.size} potential fleet accounts from transactions`);
      
      // Now verify which candidates are actually fleet accounts (536 bytes, SAGE owner)
      let verifiedCount = 0;
      for (const candidate of fleetCandidates) {
        verifiedCount++;
        if (verifiedCount % 50 === 0) {
          console.log(`[tx-analysis] verified ${verifiedCount}/${fleetCandidates.size} candidates...`);
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
      
      console.log(`[tx-analysis] Found ${additionalFleetKeys.size} verified fleet accounts with recent wallet activity`);
      
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
            console.log(`Added rented fleet (wallet heuristic): ${byteArrayToString((accountData as any).fleetLabel)}`);
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
      console.log(`Wallet usage evidence on ${operatedByWalletKeys.size} fleets`);
    } catch {}
  }

  // NEW: SRSLY rentals scan - identify fleets referenced by the rentals program for this profile
  try {
    console.log('Scanning SRSLY rentals to augment rented fleets...');
    const srslyProgramKey = new PublicKey(SRSLY_PROGRAM_ID);
    
    // Retry logic for SRSLY scan with exponential backoff
    let accounts;
    let srslyRetries = 0;
    const maxSrslyRetries = 3;
    while (srslyRetries < maxSrslyRetries) {
      try {
        accounts = await withRetry(() => connection.getProgramAccounts(srslyProgramKey));
        console.log(`[SRSLY] Successfully fetched program accounts (attempt ${srslyRetries + 1})`);
        break;
      } catch (err) {
        srslyRetries++;
        const delay = Math.min(1000 * Math.pow(2, srslyRetries), 5000); // exponential backoff, max 5s
        console.warn(`[SRSLY] Fetch failed (attempt ${srslyRetries}/${maxSrslyRetries}): ${err instanceof Error ? err.message : String(err)}`);
        if (srslyRetries < maxSrslyRetries) {
          console.log(`[SRSLY] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!accounts) {
      console.warn('[SRSLY] Failed to fetch program accounts after retries, skipping SRSLY scan');
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
    console.log(`[SRSLY] Found ${srslyWithBorrower.length} accounts referencing borrower profile`);

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
    console.log(`[SRSLY] Checking ${candidates.length} candidate fleet keys...`);
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
              console.log(`[SRSLY] Discovered candidate fleet: ${k.substring(0, 8)}...`);
            }
          }
        }
      } catch (err) {
        console.warn(`[SRSLY] Error checking candidate batch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fetch and append these fleets as rented
    console.log(`[SRSLY] Fetching ${discoveredFleetKeys.length} discovered fleets...`);
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
          console.log(`[SRSLY] Added rented fleet: ${byteArrayToString((accountData as any).fleetLabel)}`);
          srslyHeuristicKeys.add(k);
        }
      } catch (e) {
        console.warn(`[SRSLY] Failed to fetch fleet ${k.substring(0, 8)}...: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    
    console.log(`[SRSLY] Scan complete: ${discoveredFleetKeys.length} new fleets discovered`);
  } catch (e) {
    console.error('[SRSLY] Scan failed (non-fatal), continuing without SRSLY data:', e instanceof Error ? e.message : String(e));
  }

  if (fleets.length === 0) {
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
      const infos = await connection.getMultipleAccountsInfo(chunk);
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

  return {
    fleets: fleetsData,
    walletAuthority: walletAuthority
  };
}
