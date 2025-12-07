import { PublicKey } from "@solana/web3.js";
import { newConnection } from '../utils/anchor-setup.js';
import { pickNextRpcConnection, markRpcFailure, markRpcSuccess, recordRpcProcessed, tryAcquireRpc, releaseRpc } from '../utils/rpc-pool.js';
export async function getAccountTransactions(rpcEndpoint, rpcWebsocket, accountPubkey, limit = 1000, sinceUnixMs, maxSignatures = 3000, opts) {
    // Connessione Solana
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    // Fetch delle firme (allSignatures) con paginazione
    const pubkey = new PublicKey(accountPubkey);
    const allSignatures = [];
    console.log(`[wallet-scan] sigs fetch ... limit=${limit}`);
    let before = undefined;
    let done = false;
    while (!done && allSignatures.length < maxSignatures) {
        const batch = await connection.getSignaturesForAddress(pubkey, { limit: Math.min(1000, limit), before });
        if (batch.length === 0)
            break;
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
        if (allSignatures.length % 1000 === 0) {
            console.log(`[wallet-scan] sigs ${allSignatures.length} ...`);
        }
        if (!done && batch.length > 0) {
            before = batch[batch.length - 1].signature;
        }
        else {
            done = true;
        }
    }
    // Definizione MATERIAL_MINTS all'interno del corpo funzione
    const MATERIAL_MINTS = {
        'FUEL_MINT_PUBKEY': 'Fuel',
        'AMMO_MINT_PUBKEY': 'Ammo',
        'FOOD_MINT_PUBKEY': 'Food',
    };
    // Import MATERIAL_MINTS if non presente
    // import { MATERIAL_MINTS } from './material-mints'; // se serve
    const transactions = [];
    let processedCount = 0;
    const startTime = Date.now();
    const BATCH_SIZE = 150;
    const fetchTimeoutMs = 5000;
    let currentDelay = 50; // ms, adaptive
    const MIN_DELAY = 40;
    const MAX_DELAY = 1500;
    const BACKOFF_MULTIPLIER = 1.25;
    const SUCCESS_DECREASE_STEP = 15;
    let successStreak = 0;
    let consecutiveErrors = 0;
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function withTimeout(p, ms) {
        return new Promise(resolve => {
            let done = false;
            const timer = setTimeout(() => { if (!done) {
                done = true;
                resolve(null);
            } }, ms);
            p.then((r) => { if (!done) {
                done = true;
                clearTimeout(timer);
                resolve(r);
            } }).catch(() => { if (!done) {
                done = true;
                clearTimeout(timer);
                resolve(null);
            } });
        });
    }
    console.log(`[wallet-scan] start ${allSignatures.length} sigs`);
    for (let i = 0; i < allSignatures.length; i += BATCH_SIZE) {
        const batchSigs = allSignatures.slice(i, i + BATCH_SIZE);
        const fetchPromises = batchSigs.map((sig) => {
            const picked = pickNextRpcConnection();
            const rotConn = (picked && picked.connection) || connection;
            const rpcIndex = (picked && picked.index) ?? -1;
            return withTimeout((async () => {
                let tx = null;
                let acquired = false;
                let startFetch = Date.now();
                try {
                    if (rpcIndex >= 0) {
                        try {
                            acquired = tryAcquireRpc(rpcIndex);
                        }
                        catch (_e) {
                            acquired = false;
                        }
                    }
                    tx = await rotConn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    const latency = Date.now() - startFetch;
                    if (tx && rpcIndex >= 0 && acquired) {
                        releaseRpc(rpcIndex, { success: true, latencyMs: latency });
                        markRpcSuccess(rpcIndex);
                        recordRpcProcessed(rpcIndex, 1);
                    }
                }
                catch (err) {
                    if (typeof rpcIndex === 'number' && rpcIndex >= 0) {
                        const msg = err && typeof err.message === 'string' ? err.message : '';
                        const errType = msg.includes('429') ? '429' : (msg.includes('402') ? '402' : ((msg.includes('timed out') || msg.includes('timeout')) ? 'timeout' : 'other'));
                        try {
                            releaseRpc(rpcIndex, { success: false, errorType: errType });
                        }
                        catch (_e) { }
                        markRpcFailure(rpcIndex, err);
                    }
                    try {
                        tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
                    }
                    catch (e2) {
                        tx = null;
                    }
                }
                return { sig, tx };
            })(), fetchTimeoutMs);
        });
        const results = await Promise.all(fetchPromises);
        for (const res of results) {
            if (!res || !res.tx)
                continue;
            const sig = res.sig;
            const tx = res.tx;
            processedCount++;
            if (processedCount % 25 === 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const rate = (processedCount / (Date.now() - startTime) * 1000).toFixed(1);
                // Logging or stats can go here if needed
            }
            // Extract programIds from transaction instructions
            const programIds = [];
            if (tx.transaction && tx.transaction.message && Array.isArray(tx.transaction.message.instructions)) {
                for (const ix of tx.transaction.message.instructions) {
                    if (ix.programId) {
                        programIds.push(ix.programId.toString());
                    }
                }
            }
            const instructions = [];
            const logMessages = tx.meta?.logMessages || [];
            logMessages.forEach((log) => {
                const ixMatch = log.match(/Instruction: (\w+)/);
                if (ixMatch)
                    instructions.push(ixMatch[1]);
                if (log.includes('SAGE') || log.includes('sage')) {
                    const sageIxMatch = log.match(/ix([A-Z][a-zA-Z]+)/);
                    if (sageIxMatch)
                        instructions.push(sageIxMatch[1]);
                }
            });
            const accountKeys = (tx.transaction.message.accountKeys || []).map((k) => k.pubkey ? k.pubkey.toString() : (typeof k === 'string' ? k : ''));
            const craftingMaterial = (() => {
                let material;
                for (const instr of instructions) {
                    if (/fuel/i.test(instr))
                        material = 'Fuel';
                    else if (/ore/i.test(instr))
                        material = 'Ore';
                    else if (/tool/i.test(instr))
                        material = 'Tool';
                    else if (/component/i.test(instr))
                        material = 'Component';
                    else if (/food/i.test(instr))
                        material = 'Food';
                    else if (/claim/i.test(instr) && /ammo/i.test(instr))
                        material = 'Ammo';
                }
                if (!material && tx.meta && Array.isArray(tx.meta.innerInstructions)) {
                    for (const blk of tx.meta.innerInstructions) {
                        if (!blk || !Array.isArray(blk.instructions))
                            continue;
                        for (const iin of blk.instructions) {
                            const fields = [iin?.parsed?.destination, iin?.parsed?.mint, iin?.parsed?.token, iin?.parsed?.authority, iin?.parsed?.source];
                            for (const val of fields) {
                                if (typeof val === 'string') {
                                    if (MATERIAL_MINTS[val]) {
                                        material = MATERIAL_MINTS[val];
                                    }
                                    else if (/^[A-Za-z0-9]{32,44}$/.test(val)) {
                                        material = val;
                                    }
                                }
                                if (material)
                                    break;
                            }
                            if (material)
                                break;
                        }
                        if (material)
                            break;
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
            const rate = (processedCount / (Date.now() - startTime) * 1000).toFixed(0);
            console.log(`[wallet-scan] backoff ${currentDelay}ms | ${rate} tx/s`);
        }
        else {
            successStreak++;
            if (successStreak >= 20 && currentDelay > MIN_DELAY) {
                currentDelay = Math.max(MIN_DELAY, currentDelay - SUCCESS_DECREASE_STEP);
                successStreak = 0;
                const rate = (processedCount / (Date.now() - startTime) * 1000).toFixed(0);
                console.log(`[wallet-scan] delay ${currentDelay}ms | ${rate} tx/s`);
            }
        }
        await sleep(currentDelay);
    }
    return { transactions, totalSignaturesFetched: allSignatures.length };
}
