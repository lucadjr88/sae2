import { TransactionInfo } from './types.js';
import { Connection, PublicKey, ConfirmedSignatureInfo } from "@solana/web3.js";
import { newConnection } from '../utils/anchor-setup.js';
import { getCacheDataOnly, setCache } from '../utils/persist-cache.js';
import { RpcPoolConnection } from '../utils/rpc/pool-connection.js';
import { nlog } from '../utils/log-normalizer.js';
import { detectCraftingMaterial } from './tx-utils.js';
import OP_MAP from './op-map.js';
import { getGlobalTransactionCache } from '../utils/transaction-cache.js';

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
  
  nlog(`[wallet-scan] sigs fetch ... limit=${limit}`);
  while (!done && allSignatures.length < maxSignatures) {
    let batch: ConfirmedSignatureInfo[] = [];
    try {
      batch = await conn.getSignaturesForAddress(pubkey, {
        limit: Math.min(1000, limit),
        before,
        timeoutMs: 8000,
        maxRetries: 1,
      });
    } catch (err) {
      console.log(`[account-transactions] Error fetching signatures:`, (err as any)?.message);
      batch = [];
    }

    if (batch.length === 0) break;

    if (allSignatures.length % 1000 === 0) {
      nlog(`[wallet-scan] sigs ${allSignatures.length} ...`);
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
  const BATCH_SIZE = 50;
  const fetchTimeoutMs = 10000;
  let currentDelay = 250;
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

  nlog(`[wallet-scan] start ${allSignatures.length} sigs`);
  const batchStartTime = Date.now();

  // Use TransactionCache for parsed-tx fetching to avoid duplicate RPCs across callers
  const txCache = getGlobalTransactionCache();
  // Compute hours deterministically from sinceUnixMs using floor to avoid off-by-one
  // rounding that can produce e.g. 25h when a small millisecond delta exists.
  const hours = sinceUnixMs ? Math.max(1, Math.floor((Date.now() - sinceUnixMs) / (60 * 60 * 1000))) : 24;
  // Verification log: expose received cutoff and computed hours for debugging
  nlog(`[wallet-scan] received sinceUnixMs=${sinceUnixMs} computedHours=${hours}`);

  const fetchedTransactions = await txCache.getTransactions(accountPubkey, { hours, refresh: opts?.refresh }, async () => {
    // This fetchFn runs only when cache miss/refresh; it will fetch parsed transactions for allSignatures
    const innerTransactions: TransactionInfo[] = [];
    let innerProcessed = 0;
    for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
      const batchSigs = allSignatures.slice(i, i + BATCH_SIZE);
      const fetchPromises = batchSigs.map((sig: any) =>
        withTimeout<{ sig: any, tx: any }>(
          (async () => {
            let tx: any = null;
            let retries = 2;
            while (retries >= 0 && !tx) {
              try {
                tx = await conn.getParsedTransaction(sig.signature, {
                  maxSupportedTransactionVersion: 0,
                  timeoutMs: fetchTimeoutMs,
                  maxRetries: 0,
                });
                if (tx) break;
              } catch (err) {
                if (retries > 0 && (err as any)?.message?.includes('429')) {
                  await sleep(200 * (3 - retries));
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
          fetchTimeoutMs + 2000
        )
      );

      const results = await Promise.all(fetchPromises);

      for (const res of results) {
        if (!res || !res.tx) continue;

        const sig: any = res.sig;
        const tx: any = res.tx;
        innerProcessed++;

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

        innerTransactions.push({
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

      // Respect pacing/backoff between batches
      await sleep(currentDelay);
    }

    const elapsedSecs = (Date.now() - batchStartTime) / 1000;
    const txPerSec = elapsedSecs > 0 ? Math.round((innerTransactions.length / elapsedSecs) * 100) / 100 : 0;
    console.log(`[account-transactions] COMPLETED: ${innerTransactions.length}/${allSignatures.length} tx, ${txPerSec} tx/s, ${elapsedSecs.toFixed(1)}s elapsed`);
    return innerTransactions;
  });

  // fetchedTransactions contains the parsed txs (cached or freshly fetched)
  return { transactions: fetchedTransactions, totalSignaturesFetched: allSignatures.length };
}
