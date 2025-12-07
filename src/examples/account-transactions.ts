import { TransactionInfo } from './types.js';
import { Connection, PublicKey, ConfirmedSignatureInfo } from "@solana/web3.js";
import { newConnection } from '../utils/anchor-setup.js';
import { getCacheDataOnly, setCache } from '../utils/persist-cache.js';
import { RpcPoolConnection } from '../utils/rpc/pool-connection.js';
import { detectCraftingMaterial } from './tx-utils.js';
import OP_MAP from './op-map.js';

export async function getAccountTransactions(
  rpcEndpoint: string,
  rpcWebsocket: string,
  accountPubkey: string,
  limit: number = 1000,
  sinceUnixMs?: number,
  maxSignatures: number = 3000,
  opts?: { refresh?: boolean },
  poolConnection?: RpcPoolConnection  // Optional pre-configured pool connection
) {
  // Create default connection and wrapped pool connection
  const defaultConnection = newConnection(rpcEndpoint, rpcWebsocket);
  const conn = poolConnection || new RpcPoolConnection(defaultConnection);

  // Fetch delle firme (allSignatures) con paginazione
  const pubkey = new PublicKey(accountPubkey);
  const allSignatures: ConfirmedSignatureInfo[] = [];
  let before: string | undefined = undefined;
  let done = false;
  
  console.log(`[wallet-scan] sigs fetch ... limit=${limit}`);
  while (!done && allSignatures.length < maxSignatures) {
    let batch: ConfirmedSignatureInfo[] = [];
    try {
      // compact log
      // console.log(`[account-transactions] Calling getSignaturesForAddress (attempt for batch)`);
      batch = await conn.getSignaturesForAddress(pubkey, {
        limit: Math.min(1000, limit),
        before,
        timeoutMs: 8000,
        maxRetries: 1,
      });
      // console.log(`[account-transactions] Fetched ${batch.length} signatures (before=${before})`);
    } catch (err) {
      // If pool fails completely, silently continue with empty batch
      console.log(`[account-transactions] Error fetching signatures:`, (err as any)?.message);
      batch = [];
    }

    if (batch.length === 0) break;

    if (allSignatures.length % 1000 === 0) {
      console.log(`[wallet-scan] sigs ${allSignatures.length} ...`);
    }
    for (const sig of batch) {
      if (sinceUnixMs && sig.blockTime && (sig.blockTime * 1000) < sinceUnixMs) {
        done = true;
        break;
      }
      allSignatures.push(sig);
      if (allSignatures.length >= maxSignatures || allSignatures.length >= limit) {
        done = true;
        break;
      }
    }

    if (!done && batch.length > 0) {
      before = batch[batch.length - 1].signature;
    } else {
      done = true;
    }
  }

  // Definizione MATERIAL_MINTS all'interno del corpo funzione
  const MATERIAL_MINTS: { [pubkey: string]: string } = {
    'FUEL_MINT_PUBKEY': 'Fuel',
    'AMMO_MINT_PUBKEY': 'Ammo',
    'FOOD_MINT_PUBKEY': 'Food',
  };

  const transactions: TransactionInfo[] = [];
  let processedCount = 0;
  const startTime = Date.now();
  const BATCH_SIZE = 50;  // Further reduced batch size to minimize rate limits
  const fetchTimeoutMs = 10000;  // Increased timeout to 10s for rate-limited RPCs
  let currentDelay = 250; // ms, significantly increased delay between batches
  const MIN_DELAY = 40;
  const MAX_DELAY = 1500;
  const BACKOFF_MULTIPLIER = 1.25;
  const SUCCESS_DECREASE_STEP = 15;
  let successStreak = 0;
  let consecutiveErrors = 0;

  function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
      p.then((r: T) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } })
        .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
    });
  }

  console.log(`[wallet-scan] start ${allSignatures.length} sigs`);
  const batchStartTime = Date.now();

  for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
    const batchSigs = allSignatures.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allSignatures.length / BATCH_SIZE);
    const fetchPromises = batchSigs.map((sig: any) =>
      withTimeout<{ sig: any, tx: any }>(
        (async () => {
          let tx: any = null;
          let retries = 2;  // Allow 2 retries per transaction
          while (retries >= 0 && !tx) {
            try {
              tx = await conn.getParsedTransaction(sig.signature, {
                maxSupportedTransactionVersion: 0,
                timeoutMs: fetchTimeoutMs,
                maxRetries: 0,
              });
              if (tx) break;  // Success, exit retry loop
            } catch (err) {
              // If rate limited and retries remain, wait and retry
              if (retries > 0 && (err as any)?.message?.includes('429')) {
                await sleep(200 * (3 - retries));  // Exponential backoff
                retries--;
                continue;
              }
              tx = null;
              break;
            }
            retries--;
          }
          return { sig, tx };
        })(),
        fetchTimeoutMs + 2000  // Increased timeout buffer
      )
    );

    const results = await Promise.all(fetchPromises);

    // First pass: collect successful transactions
    for (const res of results) {
      if (!res || !res.tx) continue;

      const sig: any = res.sig;
      const tx: any = res.tx;
      processedCount++;

      if (processedCount % 25 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (processedCount / (Date.now() - startTime) * 1000).toFixed(1);
        // Logging or stats can go here if needed
      }

      // Extract programIds from transaction instructions
      const programIds: string[] = [];
      if (tx.transaction && tx.transaction.message && Array.isArray(tx.transaction.message.instructions)) {
        for (const ix of tx.transaction.message.instructions) {
          if (ix.programId) {
            programIds.push(ix.programId.toString());
          }
        }
      }

      const instructions: string[] = [];
      const logMessages: string[] = tx.meta?.logMessages || [];
      logMessages.forEach((log: string) => {
        const ixMatch = log.match(/Instruction: (\w+)/);
        if (ixMatch) instructions.push(ixMatch[1]);
        if (log.includes('SAGE') || log.includes('sage')) {
          const sageIxMatch = log.match(/ix([A-Z][a-zA-Z]+)/);
          if (sageIxMatch) instructions.push(sageIxMatch[1]);
        }
      });

      const accountKeys: string[] = (tx.transaction.message.accountKeys || []).map((k: any) => k.pubkey ? k.pubkey.toString() : (typeof k === 'string' ? k : ''));

      const craftingMaterial = (() => {
        let material: string | undefined;
        for (const instr of instructions) {
          if (/fuel/i.test(instr)) material = 'Fuel';
          else if (/ore/i.test(instr)) material = 'Ore';
          else if (/tool/i.test(instr)) material = 'Tool';
          else if (/component/i.test(instr)) material = 'Component';
          else if (/food/i.test(instr)) material = 'Food';
          else if (/claim/i.test(instr) && /ammo/i.test(instr)) material = 'Ammo';
        }
        if (!material && tx.meta && Array.isArray(tx.meta.innerInstructions)) {
          for (const blk of tx.meta.innerInstructions) {
            if (!blk || !Array.isArray(blk.instructions)) continue;
            for (const iin of blk.instructions) {
              const fields = [iin?.parsed?.destination, iin?.parsed?.mint, iin?.parsed?.token, iin?.parsed?.authority, iin?.parsed?.source];
              for (const val of fields) {
                if (typeof val === 'string') {
                  if (MATERIAL_MINTS[val]) {
                    material = MATERIAL_MINTS[val];
                  } else if (/^[A-Za-z0-9]{32,44}$/.test(val)) {
                    material = val;
                  }
                }
                if (material) break;
              }
              if (material) break;
            }
            if (material) break;
          }
        }
        return material;
      })();

      transactions.push({
        signature: sig.signature,
        blockTime: sig.blockTime || 0,
        slot: sig.slot,
        err: sig.err,
        memo: sig.memo || undefined,
        timestamp: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : 'Unknown',
        status: sig.err ? 'failed' : 'success',
        fee: tx.meta?.fee || 0,
        programIds: [...new Set(programIds)],
        instructions: [...new Set(instructions)],
        logMessages,
        accountKeys,
        craftingMaterial,
        meta: tx.meta,
      });
    }

    // Adaptive delay: backoff on errors, reduce on success
    if (consecutiveErrors > 0) {
      currentDelay = Math.min(MAX_DELAY, Math.ceil(currentDelay * BACKOFF_MULTIPLIER));
      consecutiveErrors = 0;
      successStreak = 0;
        const rate = (processedCount / (Date.now() - batchStartTime) * 1000).toFixed(0);
        console.log(`[wallet-scan] b${batchNum}/${totalBatches}: ${processedCount}/${allSignatures.length} tx, backoff ${currentDelay}ms | ${rate} tx/s`);
    } else {
      successStreak++;
      if (successStreak >= 20 && currentDelay > MIN_DELAY) {
        currentDelay = Math.max(MIN_DELAY, currentDelay - SUCCESS_DECREASE_STEP);
        successStreak = 0;
        const rate = (processedCount / (Date.now() - batchStartTime) * 1000).toFixed(0);
        console.log(`[wallet-scan] b${batchNum}/${totalBatches}: ${processedCount}/${allSignatures.length} tx, delay ${currentDelay}ms | ${rate} tx/s`);
      } else {
        const rate = (processedCount / (Date.now() - batchStartTime) * 1000).toFixed(0);
        console.log(`[wallet-scan] b${batchNum}/${totalBatches}: ${processedCount}/${allSignatures.length} tx, delay ${currentDelay}ms | ${rate} tx/s`);
      }
    }
    await sleep(currentDelay);
  }

  const elapsedSecs = (Date.now() - batchStartTime) / 1000;
  const txPerSec = elapsedSecs > 0 ? Math.round((transactions.length / elapsedSecs) * 100) / 100 : 0;
  console.log(`[account-transactions] COMPLETED: ${transactions.length}/${allSignatures.length} tx, ${txPerSec} tx/s, ${elapsedSecs.toFixed(1)}s elapsed`);
  return { transactions, totalSignaturesFetched: allSignatures.length };
}
