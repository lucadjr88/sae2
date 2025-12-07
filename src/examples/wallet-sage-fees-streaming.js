import { getAccountTransactions } from './account-transactions.js';
import { decodeSageInstruction } from '../decoders/sage-crafting-decoder.js';
import { extractSageMaterialActions } from '../utils/extract-instructions.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeRecipe, decodeCraftingProcess, decodeCraftableItem } from '../decoders/crafting-decoder.js';
import { decodeAccountWithRust } from '../decoders/rust-wrapper.js';
import { resolveMints } from '../utils/metaplex-metadata.js';
import { pickNextRpcConnection, tryAcquireRpc, releaseRpc } from '../utils/rpc-pool.js';
export async function getWalletSageFeesDetailedStreaming(rpcEndpoint, rpcWebsocket, walletPubkey, fleetAccounts, fleetAccountNames = {}, fleetRentalStatus = {}, hours = 24, sendUpdate, saveProgress, cachedData, lastProcessedSignature) {
    // --- LOGICA LEGACY ADATTATA ALLA MODULARIZZAZIONE ---
    // Costanti e mapping
    const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
    const excludeAccounts = [
        'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE',
        'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr',
        '11111111111111111111111111111111',
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ];
    const specificFleetAccounts = fleetAccounts.filter(account => account && !excludeAccounts.includes(account) && account.length > 40);
    const now = Date.now();
    const cutoffTime = now - (hours * 60 * 60 * 1000);
    // OP_MAP: mapping operazioni SAGE
    const OP_MAP = {
        'StartMiningAsteroid': 'Mining',
        'StopMiningAsteroid': 'Mining',
        'IdleToLoadingBay': 'Cargo/Dock',
        'LoadingBayToIdle': 'Cargo/Dock',
        'WithdrawCargoFromFleet': 'Cargo/Dock',
        'DepositCargoToFleet': 'Cargo/Dock',
        'StartSubwarp': 'Subwarp',
        'StopSubwarp': 'Subwarp',
        'Crafting': 'Crafting',
        'ProcessCraft': 'Crafting',
        'CompleteCraft': 'Crafting',
        // ...aggiungi altri mapping come legacy...
    };
    const CRAFT_PROGRAM_ID = 'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5';
    const connection = new Connection(rpcEndpoint, 'confirmed');
    // Parametri batch e rate limiting
    const BATCH_SIZE = 100;
    const MAX_TRANSACTIONS = 3000;
    const MIN_DELAY = 90;
    const MAX_DELAY = 5000;
    const BACKOFF_MULTIPLIER = 1.6;
    const SUCCESS_PROBE_WINDOW = 25;
    const SUCCESS_DECREASE_STEP = 5;
    const JITTER_PCT = 0.10;
    const MAX_RETRIES = 5;
    let currentDelay = MIN_DELAY;
    let successStreak = 0;
    let consecutiveErrors = 0;
    // Gestione incrementale/cache
    const isIncrementalUpdate = !!(cachedData && lastProcessedSignature);
    let feesByFleet = isIncrementalUpdate && cachedData ? { ...cachedData.feesByFleet } : {};
    let feesByOperation = isIncrementalUpdate && cachedData ? { ...cachedData.feesByOperation } : {};
    let totalFees24h = isIncrementalUpdate && cachedData ? (cachedData.totalFees24h || 0) : 0;
    let sageFees24h = isIncrementalUpdate && cachedData ? (cachedData.sageFees24h || 0) : 0;
    let unknownOperations = 0;
    const processedTransactions = [];
    const rentedFleets = new Set();
    const cacheSavePromises = [];
    // Fase 1: Fetch firme (con batch, delay, rate limiting)
    sendUpdate({ type: 'progress', stage: 'signatures', message: 'Fetching signatures...', processed: 0, total: 0 });
    const result = await getAccountTransactions(rpcEndpoint, rpcWebsocket, walletPubkey, MAX_TRANSACTIONS, cutoffTime, MAX_TRANSACTIONS, undefined);
    const allTransactions = result.transactions;
    const totalSigs = result.totalSignaturesFetched;
    sendUpdate({ type: 'progress', stage: 'signatures', message: `Found ${totalSigs} signatures`, processed: totalSigs, total: totalSigs });
    // Fase 2: Batch processing e parsing avanzato
    for (let i = 0; i < allTransactions.length; i += BATCH_SIZE) {
        const batch = allTransactions.slice(i, i + BATCH_SIZE);
        const batchStart = Date.now();
        for (const tx of batch) {
            // Parsing avanzato: riconoscimento e distinzione crafting tramite decoder locale
            let operation = 'Unknown';
            let isCrafting = false;
            let craftingMaterial = undefined;
            let craftingType = undefined;
            if (tx.instructions && tx.instructions.length > 0) {
                for (const instr of tx.instructions) {
                    const decoded = decodeSageInstruction(instr);
                    if (decoded && (decoded.program === 'SAGE-Starbased' || decoded.program === 'Crafting') && decoded.craftType === 'crafting') {
                        isCrafting = true;
                        craftingType = decoded.name || decoded.craftType || 'Crafting';
                        craftingMaterial = decoded.material || craftingMaterial;
                        operation = craftingType;
                        break;
                    }
                    // fallback legacy
                    if (OP_MAP[instr]) {
                        operation = OP_MAP[instr];
                        if (operation === 'Crafting')
                            isCrafting = true;
                        break;
                    }
                    if (/craft/i.test(instr)) {
                        operation = 'Crafting';
                        isCrafting = true;
                        break;
                    }
                }
            }
            // 2. Pattern matching su logMessages (legacy fallback)
            if (!isCrafting && tx.logMessages) {
                for (const log of tx.logMessages) {
                    const ixMatch = log.match(/Instruction:\s*(\w+)/);
                    if (ixMatch && (/craft/i.test(ixMatch[1]) || OP_MAP[ixMatch[1]] === 'Crafting')) {
                        operation = 'Crafting';
                        isCrafting = true;
                        break;
                    }
                }
            }
            // 3. Parsing innerInstructions per materiali (migliorato)
            if (isCrafting && tx.meta && Array.isArray(tx.meta.innerInstructions)) {
                for (const blk of tx.meta.innerInstructions) {
                    if (!blk || !Array.isArray(blk.instructions))
                        continue;
                    for (const iin of blk.instructions) {
                        // Prova a estrarre materiale da parsed, program, e dati
                        const candidates = [iin?.parsed?.destination, iin?.parsed?.mint, iin?.parsed?.token, iin?.parsed?.authority, iin?.parsed?.source, iin?.program, iin?.data];
                        for (const val of candidates) {
                            if (typeof val === 'string') {
                                if (/fuel/i.test(val))
                                    craftingMaterial = 'Fuel';
                                else if (/ore/i.test(val))
                                    craftingMaterial = 'Ore';
                                else if (/tool/i.test(val))
                                    craftingMaterial = 'Tool';
                                else if (/component/i.test(val))
                                    craftingMaterial = 'Component';
                                else if (/food/i.test(val))
                                    craftingMaterial = 'Food';
                                else if (/ammo/i.test(val))
                                    craftingMaterial = 'Ammo';
                                // Estendi con altri materiali noti
                                else if (/metal/i.test(val))
                                    craftingMaterial = 'Metal';
                                else if (/fiber/i.test(val))
                                    craftingMaterial = 'Fiber';
                                else if (/chemical/i.test(val))
                                    craftingMaterial = 'Chemical';
                                else if (/circuit/i.test(val))
                                    craftingMaterial = 'Circuit';
                            }
                            if (craftingMaterial)
                                break;
                        }
                        if (craftingMaterial)
                            break;
                    }
                    if (craftingMaterial)
                        break;
                }
            }
            // 4. If still crafting, try to fetch on-chain recipe account(s) owned by the Crafting program
            let decodedRecipe = null;
            if (isCrafting && tx.accountKeys && Array.isArray(tx.accountKeys)) {
                try {
                    const candidates = tx.accountKeys.filter(k => k && !excludeAccounts.includes(k) && k.length > 40).slice(0, 6);
                    if (candidates.length > 0) {
                        // Attempt batched fetch using rpc-pool
                        try {
                            const pks = candidates.map(c => new PublicKey(c));
                            const picked = pickNextRpcConnection();
                            if (picked && picked.connection && typeof picked.index === 'number' && picked.index >= 0 && tryAcquireRpc(picked.index)) {
                                const start = Date.now();
                                try {
                                    // @ts-ignore
                                    const accounts = await picked.connection.getMultipleAccountsInfo(pks);
                                    const latency = Date.now() - start;
                                    releaseRpc(picked.index, { success: !!accounts, latencyMs: latency });
                                    for (let ci = 0; ci < candidates.length; ci++) {
                                        const acc = accounts && accounts[ci] ? accounts[ci] : null;
                                        if (!acc || !acc.data)
                                            continue;
                                        if (acc.owner && acc.owner.toBase58 && acc.owner.toBase58() !== CRAFT_PROGRAM_ID)
                                            continue;
                                        // Prefer Rust decoder if available
                                        try {
                                            const rr = decodeAccountWithRust(acc.data);
                                            if (rr) {
                                                // rr may contain different shapes depending on the Rust CLI; try common keys
                                                if (rr.recipe || rr.Recipe) {
                                                    decodedRecipe = { kind: 'recipe', data: rr.recipe || rr.Recipe };
                                                    break;
                                                }
                                                if (rr.process || rr.Process) {
                                                    decodedRecipe = { kind: 'process', data: rr.process || rr.Process };
                                                    break;
                                                }
                                                if (rr.item || rr.Item) {
                                                    decodedRecipe = { kind: 'item', data: rr.item || rr.Item };
                                                    break;
                                                }
                                                // if Rust returned a generic object that looks like decoded account, accept it
                                                if (rr.data && (rr.data.Recipe || rr.data.Process || rr.data.Item)) {
                                                    const inner = rr.data;
                                                    if (inner.Recipe) {
                                                        decodedRecipe = { kind: 'recipe', data: inner.Recipe };
                                                        break;
                                                    }
                                                    if (inner.Process) {
                                                        decodedRecipe = { kind: 'process', data: inner.Process };
                                                        break;
                                                    }
                                                    if (inner.Item) {
                                                        decodedRecipe = { kind: 'item', data: inner.Item };
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                        catch (e) {
                                            // ignore rust wrapper failures and fall back to JS
                                        }
                                        const dr = decodeRecipe(acc.data);
                                        if (dr) {
                                            decodedRecipe = { kind: 'recipe', data: dr };
                                            break;
                                        }
                                        const dp = decodeCraftingProcess(acc.data);
                                        if (dp) {
                                            decodedRecipe = { kind: 'process', data: dp };
                                            break;
                                        }
                                        const di = decodeCraftableItem(acc.data);
                                        if (di) {
                                            decodedRecipe = { kind: 'item', data: di };
                                            break;
                                        }
                                    }
                                }
                                catch (e) {
                                    const latency = Date.now() - start;
                                    releaseRpc(picked.index, { success: false, latencyMs: latency, errorType: 'other' });
                                }
                            }
                        }
                        catch (e) {
                            // ignore batch errors and fallback to individual fetches
                        }
                        // fallback to single fetches if batch didn't decode
                        if (!decodedRecipe) {
                            for (const candidate of candidates) {
                                try {
                                    const acc = await connection.getAccountInfo(new PublicKey(candidate));
                                    if (!acc)
                                        continue;
                                    if (acc.owner.toBase58() !== CRAFT_PROGRAM_ID)
                                        continue;
                                    // Try Rust decoder first per-account
                                    try {
                                        const rr = decodeAccountWithRust(acc.data);
                                        if (rr) {
                                            if (rr.recipe || rr.Recipe) {
                                                decodedRecipe = { kind: 'recipe', data: rr.recipe || rr.Recipe };
                                                break;
                                            }
                                            if (rr.process || rr.Process) {
                                                decodedRecipe = { kind: 'process', data: rr.process || rr.Process };
                                                break;
                                            }
                                            if (rr.item || rr.Item) {
                                                decodedRecipe = { kind: 'item', data: rr.item || rr.Item };
                                                break;
                                            }
                                            if (rr.data && (rr.data.Recipe || rr.data.Process || rr.data.Item)) {
                                                const inner = rr.data;
                                                if (inner.Recipe) {
                                                    decodedRecipe = { kind: 'recipe', data: inner.Recipe };
                                                    break;
                                                }
                                                if (inner.Process) {
                                                    decodedRecipe = { kind: 'process', data: inner.Process };
                                                    break;
                                                }
                                                if (inner.Item) {
                                                    decodedRecipe = { kind: 'item', data: inner.Item };
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    catch (e) {
                                        // ignore rust wrapper per-account failures
                                    }
                                    const dr = decodeRecipe(acc.data);
                                    if (dr) {
                                        decodedRecipe = { kind: 'recipe', data: dr };
                                        break;
                                    }
                                    const dp = decodeCraftingProcess(acc.data);
                                    if (dp) {
                                        decodedRecipe = { kind: 'process', data: dp };
                                        break;
                                    }
                                    const di = decodeCraftableItem(acc.data);
                                    if (di) {
                                        decodedRecipe = { kind: 'item', data: di };
                                        break;
                                    }
                                }
                                catch (e) {
                                    // ignore individual account errors
                                }
                            }
                        }
                    }
                    if (decodedRecipe) {
                        if (decodedRecipe.kind === 'recipe') {
                            const mints = (decodedRecipe.data.recipe_items || []).map((ri) => ri.mint).filter(Boolean);
                            if (mints && mints.length > 0) {
                                try {
                                    const md = await resolveMints(mints);
                                    const display = mints.map((mm) => {
                                        const info = md[mm];
                                        if (info && info.name)
                                            return info.name + (info.symbol ? ` (${info.symbol})` : '');
                                        return mm;
                                    }).join(', ');
                                    craftingMaterial = display;
                                }
                                catch (e) {
                                    craftingMaterial = mints.join(', ');
                                }
                            }
                            craftingType = craftingType || `Recipe:${decodedRecipe.data.category?.slice(0, 8) || decodedRecipe.data.version}`;
                        }
                        else if (decodedRecipe.kind === 'process') {
                            craftingType = craftingType || `Process:${decodedRecipe.data.crafting_id}`;
                            // recipe pubkey may hint the recipe
                            craftingMaterial = craftingMaterial || decodedRecipe.data.recipe;
                        }
                        else if (decodedRecipe.kind === 'item') {
                            craftingType = craftingType || `OutputItem`;
                            if (decodedRecipe.data.mint) {
                                try {
                                    const md = await resolveMints([decodedRecipe.data.mint]);
                                    const info = md[decodedRecipe.data.mint];
                                    craftingMaterial = info && info.name ? (info.name + (info.symbol ? ` (${info.symbol})` : '')) : decodedRecipe.data.mint;
                                }
                                catch (e) {
                                    craftingMaterial = decodedRecipe.data.mint;
                                }
                            }
                        }
                    }
                }
                catch (e) {
                    // ignore
                }
            }
            if (operation === 'Unknown')
                unknownOperations++;
            // Aggregazione per fleet
            let involvedFleetName = 'Other Operations';
            for (const fleet of specificFleetAccounts) {
                if (tx.accountKeys && tx.accountKeys.includes(fleet)) {
                    involvedFleetName = fleetAccountNames[fleet] || fleet.substring(0, 8);
                    break;
                }
            }
            // Raggruppa tutte le crafting sotto 'Crafting' per feesByFleet/feesByOperation
            const opKey = isCrafting ? 'Crafting' : operation;
            if (!feesByFleet[involvedFleetName]) {
                feesByFleet[involvedFleetName] = {
                    totalFee: 0,
                    feePercentage: 0,
                    totalOperations: 0,
                    operations: {},
                    isRented: fleetRentalStatus[involvedFleetName] || false
                };
            }
            feesByFleet[involvedFleetName].totalFee += tx.fee;
            feesByFleet[involvedFleetName].totalOperations++;
            if (!feesByFleet[involvedFleetName].operations[opKey]) {
                feesByFleet[involvedFleetName].operations[opKey] = {
                    count: 0,
                    totalFee: 0,
                    avgFee: 0,
                    percentageOfFleet: 0,
                    details: [] // Dettagli per unfold
                };
            }
            feesByFleet[involvedFleetName].operations[opKey].count++;
            feesByFleet[involvedFleetName].operations[opKey].totalFee += tx.fee;
            // Salva dettaglio solo per crafting
            if (isCrafting) {
                // Estrarre dettagli materiali/token per questa transazione
                let materialActions = [];
                try {
                    materialActions = await extractSageMaterialActions(connection, [tx.signature]);
                } catch (e) {
                    console.warn('[wallet-sage-fees-streaming] extractSageMaterialActions failed:', e);
                }
                if (materialActions && materialActions.length > 0) {
                    for (const action of materialActions) {
                        feesByFleet[involvedFleetName].operations[opKey].details.push({
                            ...action,
                            fee: tx.fee,
                            txid: tx.signature,
                            fleet: involvedFleetName,
                            decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
                            decodedData: decodedRecipe ? decodedRecipe.data : undefined
                        });
                    }
                } else {
                    // fallback: push basic info if no actions found
                    feesByFleet[involvedFleetName].operations[opKey].details.push({
                        type: craftingType || 'Crafting',
                        fee: tx.fee,
                        material: craftingMaterial,
                        txid: tx.signature,
                        fleet: involvedFleetName,
                        decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
                        decodedData: decodedRecipe ? decodedRecipe.data : undefined
                    });
                }
            }
            // Aggregazione per operazione
            if (!feesByOperation[opKey]) {
                feesByOperation[opKey] = { count: 0, totalFee: 0, avgFee: 0, details: [] };
            }
            feesByOperation[opKey].count++;
            feesByOperation[opKey].totalFee += tx.fee;
            if (isCrafting) {
                // Usa gli stessi dettagli estratti sopra
                if (materialActions && materialActions.length > 0) {
                    for (const action of materialActions) {
                        feesByOperation[opKey].details.push({
                            ...action,
                            fee: tx.fee,
                            txid: tx.signature,
                            fleet: involvedFleetName,
                            decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
                            decodedData: decodedRecipe ? decodedRecipe.data : undefined
                        });
                    }
                } else {
                    feesByOperation[opKey].details.push({
                        type: craftingType || 'Crafting',
                        fee: tx.fee,
                        material: craftingMaterial,
                        txid: tx.signature,
                        fleet: involvedFleetName,
                        decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
                        decodedData: decodedRecipe ? decodedRecipe.data : undefined
                    });
                }
            }
            // Dettaglio crafting solo nel summary unfold
            if (isCrafting) {
                tx.craftingMaterial = craftingMaterial;
                // Attach decoded recipe/process/item to the transaction for UI inspection
                if (decodedRecipe)
                    tx.decodedRecipe = decodedRecipe;
            }
            processedTransactions.push(tx);
            totalFees24h += tx.fee;
            if (!tx.programIds.includes(SAGE_PROGRAM_ID))
                continue;
            sageFees24h += tx.fee;
        }
        // Aggiornamento percentuali
        Object.keys(feesByOperation).forEach(op => {
            feesByOperation[op].avgFee = feesByOperation[op].totalFee / feesByOperation[op].count;
        });
        Object.keys(feesByFleet).forEach(fleet => {
            feesByFleet[fleet].feePercentage = sageFees24h > 0 ? (feesByFleet[fleet].totalFee / sageFees24h) * 100 : 0;
            Object.keys(feesByFleet[fleet].operations).forEach(op => {
                const opData = feesByFleet[fleet].operations[op];
                opData.avgFee = opData.totalFee / opData.count;
                opData.percentageOfFleet = feesByFleet[fleet].totalFee > 0 ? (opData.totalFee / feesByFleet[fleet].totalFee) * 100 : 0;
            });
        });
        // Build partial result per batch
        const partialResult = {
            type: 'progress',
            stage: 'transactions',
            message: `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (delay: ${currentDelay}ms)`,
            processed: Math.min(i + BATCH_SIZE, allTransactions.length),
            total: totalSigs,
            percentage: (((Math.min(i + BATCH_SIZE, allTransactions.length)) / totalSigs) * 100).toFixed(1),
            batchTime: ((Date.now() - batchStart) / 1000).toFixed(1),
            currentDelay,
            walletAddress: walletPubkey,
            period: `Last ${hours} hours`,
            totalFees24h,
            sageFees24h,
            transactionCount24h: processedTransactions.filter(t => t.programIds.includes(SAGE_PROGRAM_ID)).length,
            totalSignaturesFetched: totalSigs,
            feesByFleet: { ...feesByFleet },
            feesByOperation: { ...feesByOperation },
            unknownOperations,
            rentedFleetAccounts: Object.keys(fleetRentalStatus).filter(k => fleetRentalStatus[k]),
            fleetAccountNamesEcho: fleetAccountNames,
            fleetRentalStatusFinal: fleetRentalStatus
        };
        sendUpdate(partialResult);
        if (saveProgress) {
            const cachePromise = saveProgress(partialResult).catch(err => {
                console.error('[stream] Incremental cache save failed:', err);
            });
            cacheSavePromises.push(cachePromise);
        }
        await new Promise(resolve => setTimeout(resolve, currentDelay));
    }
    // Attendi salvataggio cache
    if (cacheSavePromises.length > 0) {
        await Promise.all(cacheSavePromises);
    }
    // Aggregazione e ordinamento finale
    processedTransactions.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));
    const finalResult = {
        type: 'complete',
        walletAddress: walletPubkey,
        period: `Last ${hours} hours`,
        totalFees24h,
        sageFees24h,
        transactionCount24h: processedTransactions.filter(t => t.programIds.includes(SAGE_PROGRAM_ID)).length,
        totalSignaturesFetched: totalSigs,
        feesByFleet,
        feesByOperation,
        transactions: processedTransactions,
        unknownOperations,
        rentedFleetAccounts: Object.keys(fleetRentalStatus).filter(k => fleetRentalStatus[k]),
        fleetAccountNamesEcho: fleetAccountNames,
        fleetRentalStatusFinal: fleetRentalStatus
    };
    sendUpdate(finalResult);
    return finalResult;
}
