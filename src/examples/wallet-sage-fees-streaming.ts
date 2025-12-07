import { TransactionInfo } from './types.js';
import { getAccountTransactions } from './account-transactions.js';
import { decodeSageInstruction } from '../decoders/sage-crafting-decoder.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeRecipe, isRecipeAccount, decodeCraftingProcess, decodeCraftableItem } from '../decoders/crafting-decoder.js';
import { decodeAccountWithRust } from '../decoders/rust-wrapper.js';
import { resolveMints } from '../utils/metaplex-metadata.js';
import { RpcPoolConnection } from '../utils/rpc/pool-connection.js';
import OP_MAP from './op-map.js';

export async function getWalletSageFeesDetailedStreaming(
  rpcEndpoint: string,
  rpcWebsocket: string,
  walletPubkey: string,
  fleetAccounts: string[],
  fleetAccountNames: { [account: string]: string } = {},
  fleetRentalStatus: { [account: string]: boolean } = {},
  hours: number = 24,
  sendUpdate: (data: any) => void,
  saveProgress?: (partialResult: any) => Promise<void>,
  cachedData?: any,
  lastProcessedSignature?: string
): Promise<any> {
  // --- LOGICA LEGACY ADATTATA ALLA MODULARIZZAZIONE ---
  // Costanti e mapping
  const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
  const excludeAccounts = [
    'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE',
    'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr',
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ];
  // Minimal materials map to detect crafting token movements
  const MATERIALS: Record<string, string> = {
    'MASS9GqtJz6ABisAxcUn3FeR4phMqH1XfG6LPKJePog': 'Biomass',
    'foodQJAztMzX1DKpLaiounNe2BDMds5RNuPC6jsNrDG': 'Food',
    'fueL3hBZjLLLJHiFH9cqZoozTG3XQZ53diwFPwbzNim': 'Fuel',
    'HYDR4EPHJcDPcaLYUcNCtrXUdt1PnaN4MvE655pevBYp': 'Hydrogen',
  };
  const specificFleetAccounts = fleetAccounts.filter(account => account && !excludeAccounts.includes(account) && account.length > 40);
  const now = Date.now();
  const cutoffTime = now - (hours * 60 * 60 * 1000);
  // OP_MAP is now imported from op-map.js
  const CRAFT_PROGRAM_ID = 'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5';
  const connection = new Connection(rpcEndpoint, 'confirmed');

  // Parametri batch e rate limiting
  const BATCH_SIZE = 150;
  const MAX_TRANSACTIONS = 3000;
  const MIN_DELAY = 70;
  const MAX_DELAY = 5000;
  const BACKOFF_MULTIPLIER = 1.5;
  const SUCCESS_PROBE_WINDOW = 25;
  const SUCCESS_DECREASE_STEP = 5;
  const JITTER_PCT = 0.10;
  const MAX_RETRIES = 5;
  let currentDelay = MIN_DELAY;
  let successStreak = 0;
  let consecutiveErrors = 0;

  // Gestione incrementale/cache
  const isIncrementalUpdate = !!(cachedData && lastProcessedSignature);
  let feesByFleet: any = isIncrementalUpdate && cachedData ? { ...cachedData.feesByFleet } : {};
  let feesByOperation: any = isIncrementalUpdate && cachedData ? { ...cachedData.feesByOperation } : {};
  let totalFees24h = isIncrementalUpdate && cachedData ? (cachedData.totalFees24h || 0) : 0;
  let sageFees24h = isIncrementalUpdate && cachedData ? (cachedData.sageFees24h || 0) : 0;
  let unknownOperations = 0;
  let processedTransactions: TransactionInfo[] = [];
  const rentedFleets = new Set<string>();
  const cacheSavePromises: Promise<void>[] = [];
  
  // Create a single reusable RPC pool connection for crafting details
  const sharedPoolConnection = new RpcPoolConnection(connection);

  // Fase 1: Fetch firme (con batch, delay, rate limiting)
  sendUpdate({ type: 'progress', stage: 'signatures', message: 'Fetching signatures...', processed: 0, total: 0 });
  const result = await getAccountTransactions(
    rpcEndpoint,
    rpcWebsocket,
    walletPubkey,
    MAX_TRANSACTIONS,
    cutoffTime,
    MAX_TRANSACTIONS,
    undefined
  );
  const allTransactions = result.transactions;
  const totalSigs = result.totalSignaturesFetched;
  sendUpdate({ type: 'progress', stage: 'signatures', message: `Found ${totalSigs} signatures`, processed: totalSigs, total: totalSigs });

  // Fase 2: Batch processing e parsing avanzato
  for (let i = 0; i < allTransactions.length; i += BATCH_SIZE) {
    const batch = allTransactions.slice(i, i + BATCH_SIZE);
    const batchStart = Date.now();
    for (const tx of batch) {
      // Don't skip transactions with empty instructions - they might still be valid SAGE transactions
      // The programIds check below will filter out non-SAGE transactions
      
      // Parsing avanzato: riconoscimento e distinzione crafting tramite decoder locale
      let operation = 'Unknown';
      let isCrafting = false;
      let craftingMaterial = undefined;
      let craftingType = undefined;
      let hasSageInstruction = false;
      
      if (tx.instructions && tx.instructions.length > 0) {
        for (const instr of tx.instructions) {
          const decoded = decodeSageInstruction(instr);
          if (decoded && (decoded.program === 'SAGE-Starbased' || decoded.program === 'Crafting') && decoded.craftType === 'crafting') {
            isCrafting = true;
            hasSageInstruction = true;
            craftingType = decoded.name || decoded.craftType || 'Crafting';
            craftingMaterial = decoded.material || craftingMaterial;
            operation = craftingType;
            break;
          }
          // fallback legacy
          if (OP_MAP[instr]) {
            operation = OP_MAP[instr];
            hasSageInstruction = true;
            if (operation === 'Crafting') isCrafting = true;
            break;
          }
          if (/craft/i.test(instr)) {
            operation = 'Crafting';
            isCrafting = true;
            hasSageInstruction = true;
            break;
          }
        }
      }
      
      // Skip ONLY pure non-SAGE transactions (no SAGE program ID at all)
      if (!tx.programIds.includes(SAGE_PROGRAM_ID)) {
        continue;
      }
      
      // If operation is still Unknown but has SAGE program, count it as SAGE operation
      // Don't skip it - it's a valid SAGE transaction we just haven't decoded yet
      // 2. Pattern matching su logMessages (fallback for Unknown operations)
      if (operation === 'Unknown' && tx.logMessages) {
        for (const log of tx.logMessages) {
          const ixMatch = log.match(/Instruction:\s*(\w+)/);
          if (ixMatch) {
            const ixName = ixMatch[1];
            if (OP_MAP[ixName]) {
              operation = OP_MAP[ixName];
              hasSageInstruction = true;
              if (operation.includes('Craft')) isCrafting = true;
              break;
            }
          }
        }
      }
      // 2b. Additional crafting detection
      if (!isCrafting && tx.logMessages) {
        for (const log of tx.logMessages) {
          if (/craft/i.test(log)) {
            operation = 'Crafting';
            isCrafting = true;
            hasSageInstruction = true;
            break;
          }
        }
      }
      // 2c. Enhanced FleetStateHandler detection for Subwarp/Mining completion
      if (operation === 'FleetStateHandler' && tx.logMessages) {
        const logsJoined = tx.logMessages.join(' ');
        if (logsJoined.includes('MoveSubwarp')) {
          operation = 'StopSubwarp';
        } else if (logsJoined.includes('MineAsteroid')) {
          operation = 'StopMining';
        }
      }
      
      // 3. Parsing innerInstructions per materiali (migliorato)
      if (isCrafting && tx.meta && Array.isArray((tx.meta as any).innerInstructions)) {
        for (const blk of (tx.meta as any).innerInstructions) {
          if (!blk || !Array.isArray(blk.instructions)) continue;
          for (const iin of blk.instructions) {
            // Prova a estrarre materiale da parsed, program, e dati
            const candidates = [iin?.parsed?.destination, iin?.parsed?.mint, iin?.parsed?.token, iin?.parsed?.authority, iin?.parsed?.source, iin?.program, iin?.data];
            for (const val of candidates) {
              if (typeof val === 'string') {
                if (/fuel/i.test(val)) craftingMaterial = 'Fuel';
                else if (/ore/i.test(val)) craftingMaterial = 'Ore';
                else if (/tool/i.test(val)) craftingMaterial = 'Tool';
                else if (/component/i.test(val)) craftingMaterial = 'Component';
                else if (/food/i.test(val)) craftingMaterial = 'Food';
                else if (/ammo/i.test(val)) craftingMaterial = 'Ammo';
                // Estendi con altri materiali noti
                else if (/metal/i.test(val)) craftingMaterial = 'Metal';
                else if (/fiber/i.test(val)) craftingMaterial = 'Fiber';
                else if (/chemical/i.test(val)) craftingMaterial = 'Chemical';
                else if (/circuit/i.test(val)) craftingMaterial = 'Circuit';
              }
              if (craftingMaterial) break;
            }
            if (craftingMaterial) break;
          }
          if (craftingMaterial) break;
        }
      }
      // 3b. Fallback: deduci Fuel/Food dai log/instructions se non trovato
      if (isCrafting && !craftingMaterial) {
        const logsLower = (tx.logMessages || []).join(' ').toLowerCase();
        const instrLower = (tx.instructions || []).join(' ').toLowerCase();
        const combinedLower = `${logsLower} ${instrLower}`;
        if (combinedLower.includes('fuel')) craftingMaterial = 'Fuel';
        else if (combinedLower.includes('food')) craftingMaterial = 'Food';
      }
      // 4. If still crafting, try to fetch on-chain recipe account(s) owned by the Crafting program
      let decodedRecipe: any = null;
      let craftingAction: string = 'crafting_start'; // default
      if (isCrafting && tx.accountKeys && Array.isArray(tx.accountKeys)) {
        // Determine start/claim using token balance deltas first
        try {
          const preBalances = tx.meta?.preTokenBalances || [];
          const postBalances = tx.meta?.postTokenBalances || [];
          const preMap: Record<string, any> = {};
          for (const p of preBalances) {
            if (!p) continue;
            const key = `${p.owner || ''}:${p.mint || ''}`;
            preMap[key] = p;
          }
          let foundPos = false;
          let foundNeg = false;
          for (const p of postBalances) {
            if (!p || !p.mint) continue;
            const key = `${p.owner || ''}:${p.mint}`;
            const pre = preMap[key];
            const preAmt = pre?.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
            const postAmt = p.uiTokenAmount?.amount ? BigInt(p.uiTokenAmount.amount) : 0n;
            const delta = postAmt - preAmt;
            if (delta > 0n) foundPos = true;
            if (delta < 0n) foundNeg = true;
          }
          if (foundPos && !foundNeg) craftingAction = 'crafting_claim';
          else if (foundNeg && !foundPos) craftingAction = 'crafting_start';
          else if (foundPos) craftingAction = 'crafting_claim';
        } catch (e) {
          // fallback to logs
        }
        // Fallback to logs if deltas inconclusive
        if (craftingAction === 'crafting_start') {
          const logsStr = (tx.meta?.logMessages || []).join(' ').toLowerCase();
          if (logsStr.includes('claim') || logsStr.includes('complete') || logsStr.includes('withdraw')) {
            craftingAction = 'crafting_claim';
          }
        }
        // Fallback to inner instructions token transfers: any positive MATERIAL transfer implies claim
        if (craftingAction === 'crafting_start') {
          try {
            const inners = tx.meta?.innerInstructions || [];
            let posFound = false;
            for (const inner of inners || []) {
              for (const inst of inner.instructions || []) {
                const parsed = (inst as any).parsed?.info || (inst as any).info || (inst as any).parsed;
                if (!parsed) continue;
                const amount = parsed.amount || parsed.tokenAmount?.amount || parsed.uiTokenAmount?.amount;
                const mint = parsed.mint || parsed.mintAddress || parsed.tokenMint;
                if (!amount || !mint) continue;
                const a = BigInt(String(amount));
                if (a > 0n && MATERIALS[mint]) { posFound = true; break; }
              }
              if (posFound) break;
            }
            if (posFound) craftingAction = 'crafting_claim';
          } catch (e) {}
        }
        
        try {
          const candidates = tx.accountKeys.filter(k => k && !excludeAccounts.includes(k) && k.length > 40).slice(0, 6);
          if (candidates.length > 0) {
            // Use shared pool connection instead of creating new one
            
            // Fetch account info with pool
            for (let ci = 0; ci < candidates.length && !decodedRecipe; ci++) {
              try {
                const accInfo = await sharedPoolConnection.getAccountInfo(new PublicKey(candidates[ci]), {
                  timeoutMs: 5000,
                  maxRetries: 0,
                  logErrors: false,
                });
                if (!accInfo || !accInfo.data) continue;
                if (accInfo.owner && accInfo.owner.toBase58() !== CRAFT_PROGRAM_ID) continue;
                
                // Try Rust decoder
                try {
                  const rr = decodeAccountWithRust(accInfo.data);
                  if (rr) {
                    if (rr.recipe || rr.Recipe) { decodedRecipe = { kind: 'recipe', data: rr.recipe || rr.Recipe }; break; }
                    if (rr.process || rr.Process) { decodedRecipe = { kind: 'process', data: rr.process || rr.Process }; break; }
                    if (rr.item || rr.Item) { decodedRecipe = { kind: 'item', data: rr.item || rr.Item }; break; }
                    if (rr.data && (rr.data.Recipe || rr.data.Process || rr.data.Item)) {
                      const inner = rr.data;
                      if (inner.Recipe) { decodedRecipe = { kind: 'recipe', data: inner.Recipe }; break; }
                      if (inner.Process) { decodedRecipe = { kind: 'process', data: inner.Process }; break; }
                      if (inner.Item) { decodedRecipe = { kind: 'item', data: inner.Item }; break; }
                    }
                  }
                } catch (e) {
                  // ignore rust wrapper failures
                }
                
                // Try JS decoders
                if (!decodedRecipe) {
                  const dr = decodeRecipe(accInfo.data);
                  if (dr) { decodedRecipe = { kind: 'recipe', data: dr }; break; }
                }
                if (!decodedRecipe) {
                  const dp = decodeCraftingProcess(accInfo.data);
                  if (dp) { decodedRecipe = { kind: 'process', data: dp }; break; }
                }
                if (!decodedRecipe) {
                  const di = decodeCraftableItem(accInfo.data);
                  if (di) { decodedRecipe = { kind: 'item', data: di }; break; }
                }
              } catch (err) {
                // tolerate individual fetch errors
              }
            }
          }
          
          if (decodedRecipe) {
            if (decodedRecipe.kind === 'recipe') {
              const mints = (decodedRecipe.data.recipe_items || []).map((ri: any) => ri.mint).filter(Boolean);
              if (mints && mints.length > 0) {
                try {
                  const md = await resolveMints(mints);
                  const display = mints.map((mm: string) => {
                    const info = md[mm];
                    if (info && info.name) return info.name + (info.symbol ? ` (${info.symbol})` : '');
                    return mm;
                  }).join(', ');
                  craftingMaterial = display;
                } catch (e) {
                  craftingMaterial = mints.join(', ');
                }
              }
              craftingType = craftingType || `Recipe:${decodedRecipe.data.category?.slice(0,8) || decodedRecipe.data.version}`;
            } else if (decodedRecipe.kind === 'process') {
              craftingType = craftingType || `Process:${decodedRecipe.data.crafting_id}`;
              // recipe pubkey may hint the recipe
              craftingMaterial = craftingMaterial || decodedRecipe.data.recipe;
            } else if (decodedRecipe.kind === 'item') {
              craftingType = craftingType || `OutputItem`;
              if (decodedRecipe.data.mint) {
                try {
                  const md = await resolveMints([decodedRecipe.data.mint]);
                  const info = md[decodedRecipe.data.mint];
                  craftingMaterial = info && info.name ? (info.name + (info.symbol ? ` (${info.symbol})` : '')) : decodedRecipe.data.mint;
                } catch (e) {
                  craftingMaterial = decodedRecipe.data.mint;
                }
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }
      if (operation === 'Unknown') {
        unknownOperations++;
      }
      
      // Group related operations: Dock/Undock/Cargo operations, Subwarp
      let groupedOperation = operation;
      if (operation === 'Dock' || operation === 'Undock' || operation === 'LoadCargo' || operation === 'UnloadCargo') {
        groupedOperation = 'Dock/Undock/Load/Unload';
      } else if (operation === 'StartSubwarp' || operation === 'StopSubwarp' || operation === 'FleetStateHandler') {
        groupedOperation = 'Subwarp';
      } else if (operation === 'StartMining' || operation === 'StopMining') {
        groupedOperation = 'Mining';
      }
      
      // Aggregazione per fleet - cerca fleet account o cargo hold
      let involvedFleetName = undefined;
      
      // First try: direct fleet account match
      for (const fleet of specificFleetAccounts) {
        if (tx.accountKeys && tx.accountKeys.includes(fleet)) {
          involvedFleetName = fleetAccountNames[fleet] || fleet.substring(0, 8);
          break;
        }
      }
      
      // Second try: if cargo/dock operation and no fleet found, assign to first fleet in the list
      // (cargo operations often use cargo hold account instead of fleet account)
      if (!involvedFleetName && (groupedOperation === 'Dock/Undock/Load/Unload' || operation.includes('Cargo') || operation.includes('cargo'))) {
        // Try to match any account key with fleet names
        if (tx.accountKeys) {
          for (const acc of tx.accountKeys) {
            if (fleetAccountNames[acc]) {
              involvedFleetName = fleetAccountNames[acc];
              break;
            }
          }
        }
        // If still not found, use wallet owner's primary fleet if available
        if (!involvedFleetName && specificFleetAccounts.length > 0) {
          const primaryFleet = specificFleetAccounts[0];
          involvedFleetName = fleetAccountNames[primaryFleet] || primaryFleet.substring(0, 8);
        }
      }
      
      // Third try: categorize non-fleet operations (crafting, starbase, system ops)
      if (!involvedFleetName) {
        if (isCrafting || groupedOperation === 'Crafting' || operation.includes('Craft')) {
          involvedFleetName = 'Crafting Operations';
        } else if (operation.includes('Starbase')) {
          involvedFleetName = 'Starbase Operations';
        } else if (operation.includes('Register') || operation.includes('Deregister') || operation.includes('Update') || operation.includes('Init')) {
          involvedFleetName = 'Configuration';
        } else if (operation.includes('Profile') || operation.includes('Progression') || operation.includes('Points')) {
          involvedFleetName = 'Player Profile';
        } else if (operation.includes('Rental')) {
          involvedFleetName = 'Fleet Rentals';
        } else if (operation.includes('Sector') || operation.includes('Planet') || operation.includes('Star')) {
          involvedFleetName = 'Universe Management';
        } else {
          // Default for any other SAGE operation
          involvedFleetName = 'Other Operations';
        }
      }
      
      // Raggruppa tutte le crafting sotto 'Crafting' per feesByFleet/feesByOperation
      const opKey = isCrafting ? 'Crafting' : groupedOperation;
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
        feesByFleet[involvedFleetName].operations[opKey].details.push({
          action: craftingAction,
          // force type to action so UI can distinguish start/claim; keep label separately
          type: craftingAction,
          displayType: craftingType || 'Crafting',
          fee: tx.fee,
          material: craftingMaterial,
          txid: tx.signature,
          fleet: involvedFleetName,
          // Include normalized decode details so the frontend can show recipe/process/item
          decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
          decodedData: decodedRecipe ? decodedRecipe.data : undefined
        });
        // Debug: log when a normalized decode was attached to a detail
      }
      // Aggregazione per operazione
      if (!feesByOperation[opKey]) {
        feesByOperation[opKey] = { count: 0, totalFee: 0, avgFee: 0, details: [] };
      }
      feesByOperation[opKey].count++;
      feesByOperation[opKey].totalFee += tx.fee;
      if (isCrafting) {
        feesByOperation[opKey].details.push({
          action: craftingAction,
          type: craftingAction,
          displayType: craftingType || 'Crafting',
          fee: tx.fee,
          material: craftingMaterial,
          txid: tx.signature,
          fleet: involvedFleetName,
          decodedKind: decodedRecipe ? decodedRecipe.kind : undefined,
          decodedData: decodedRecipe ? decodedRecipe.data : undefined
        });
      }
      // Dettaglio crafting solo nel summary unfold
      if (isCrafting) {
        tx.craftingMaterial = craftingMaterial;
        // Attach decoded recipe/process/item to the transaction for UI inspection
        if (decodedRecipe) tx.decodedRecipe = decodedRecipe;
      }
      processedTransactions.push(tx);
      totalFees24h += tx.fee;
      if (!tx.programIds.includes(SAGE_PROGRAM_ID)) continue;
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
    
    // Log sintetici per crafting details phase
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const processedInBatch = Math.min(BATCH_SIZE, allTransactions.length - i);
    const totalProcessedSoFar = Math.min(i + BATCH_SIZE, allTransactions.length);
    const remainingTxs = allTransactions.length - totalProcessedSoFar;
    const batchTimeElapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
    const txPerSec = processedInBatch > 0 ? (processedInBatch / (Number(batchTimeElapsed) || 1)).toFixed(1) : '0.0';
    const sageOpCount = processedTransactions.filter(t => t.programIds.includes(SAGE_PROGRAM_ID)).length;
    const craftingOpCount = Object.keys(feesByOperation).includes('Crafting') ? feesByOperation['Crafting'].count : 0;
    
    console.log(`[crafting-details] Batch ${batchNum}: processed ${processedInBatch} tx in ${batchTimeElapsed}s (${txPerSec} tx/s), remaining: ${remainingTxs}, SAGE ops: ${sageOpCount}, Crafting ops: ${craftingOpCount}`);
    
    // Build partial result per batch
    const partialResult = {
      type: 'progress',
      stage: 'transactions',
      message: `Processing batch ${batchNum} (${txPerSec} tx/s, delay: ${currentDelay}ms)`,
      processed: totalProcessedSoFar,
      total: totalSigs,
      percentage: ((totalProcessedSoFar / totalSigs) * 100).toFixed(1),
      batchTime: batchTimeElapsed,
      currentDelay,
      walletAddress: walletPubkey,
      period: `Last ${hours} hours`,
      totalFees24h,
      sageFees24h,
      transactionCount24h: sageOpCount,
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

  // Pair crafting Start+Complete transactions (within 30s window)
  const craftingPairs: Map<string, { start: any; complete: any | null }> = new Map();
  for (const tx of processedTransactions) {
    const hasCreate = tx.instructions?.includes('CreateCraftingProcess');
    const hasClose = tx.instructions?.includes('CloseCraftingProcess');
    const hasBurn = tx.instructions?.includes('BurnConsumableIngredient') || tx.instructions?.includes('BurnCraftingConsumables');
    const hasClaim = tx.instructions?.includes('ClaimRecipeOutput') || tx.instructions?.includes('ClaimCraftingOutputs');
    
    const fleetName = (tx as any).involvedFleetName || ((tx as any).involvedFleets && (tx as any).involvedFleets[0]) || 'unknown';
    
    if (hasCreate) {
      const key = `craft_${tx.blockTime || 0}_${fleetName}`;
      craftingPairs.set(key, { start: tx, complete: null });
    } else if (hasClose && (hasBurn || hasClaim)) {
      // Find matching start within 30s
      for (const [k, pair] of Array.from(craftingPairs.entries()).reverse()) {
        const pairFleetName = (pair.start as any).involvedFleetName || ((pair.start as any).involvedFleets && (pair.start as any).involvedFleets[0]) || 'unknown';
        if (!pair.complete && pair.start && pairFleetName === fleetName) {
          const timeDelta = Math.abs((tx.blockTime || 0) - (pair.start.blockTime || 0));
          if (timeDelta < 30) {
            pair.complete = tx;
            break;
          }
        }
      }
    }
  }

  // Merge paired crafting transactions
  const pairedSignatures = new Set<string>();
  const mergedTransactions: any[] = [];
  for (const [key, pair] of craftingPairs.entries()) {
    if (pair.start && pair.complete) {
      pairedSignatures.add(pair.start.signature);
      pairedSignatures.add(pair.complete.signature);
      mergedTransactions.push({
        ...pair.start,
        signature: `${pair.start.signature}+${pair.complete.signature}`,
        fee: pair.start.fee + pair.complete.fee,
        instructions: [...(pair.start.instructions || []), ...(pair.complete.instructions || [])],
        pairedTxs: [pair.start.signature, pair.complete.signature],
        isPaired: true
      });
    } else if (pair.start) {
      mergedTransactions.push(pair.start);
    }
  }
  for (const tx of processedTransactions) {
    if (!pairedSignatures.has(tx.signature)) {
      mergedTransactions.push(tx);
    }
  }
  processedTransactions = mergedTransactions;

  // Aggregazione e ordinamento finale
  processedTransactions.sort((a,b) => (b.blockTime||0) - (a.blockTime||0));
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
