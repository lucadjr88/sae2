import { getAccountTransactions } from './account-transactions.js';
import { newConnection } from '../utils/anchor-setup.js';
import OP_MAP from './op-map.js';
export async function getWalletSageFeesDetailed(rpcEndpoint, rpcWebsocket, walletPubkey, fleetAccounts, fleetAccountNames = {}, fleetRentalStatus = {}, hours = 24, opts) {
    const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    // Debug: Print all input parameters for troubleshooting
    console.log('--- DEBUG getWalletSageFeesDetailed ---');
    console.log('Fleet accounts:', fleetAccounts);
    console.log('Fleet names:', fleetAccountNames);
    console.log('Fleet rental status:', fleetRentalStatus);
    console.log('Hours:', hours);
    console.log('Wallet pubkey:', walletPubkey);
    console.log('--------------------------------------');
    // Exclude common/generic accounts that appear in all transactions
    const excludeAccounts = [
        'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE', // SAGE Program
        'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr', // Game Program  
        '11111111111111111111111111111111', // System Program
        'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    ];
    // Filter out generic accounts from fleet accounts
    const specificFleetAccounts = fleetAccounts.filter(account => account && !excludeAccounts.includes(account) && account.length > 40);
    console.log(`[DEBUG] Specific fleet accounts (after filtering): ${specificFleetAccounts.length}`);
    specificFleetAccounts.forEach((fleet, i) => console.log(`  Specific Fleet ${i}: ${fleet.substring(0, 8)}...`));
    // Compute cutoff for the analysis window
    const now = Date.now();
    const cutoffTime = now - (hours * 60 * 60 * 1000);
    // Get all transactions for wallet (paginate until cutoff - process in chunks)
    const result = await getAccountTransactions(rpcEndpoint, rpcWebsocket, walletPubkey, 5000, // Allow up to 5000 to cover 24h
    cutoffTime, 10000, // Max signatures for 24h coverage
    opts);
    const allTransactions = result.transactions;
    const totalSigs = result.totalSignaturesFetched;
    const recent24h = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp).getTime();
        return txTime >= cutoffTime && tx.programIds.includes(SAGE_PROGRAM_ID);
    });
    // Analyze by fleet and operation
    const feesByFleet = {};
    const feesByOperation = {};
    let totalFees24h = 0;
    let sageFees24h = 0;
    let unknownOperations = 0;
    // Track which fleets have rental operations
    const rentedFleets = new Set();
    // Complete SAGE instruction mapping from official IDL (SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE)
    // Source: https://github.com/staratlasmeta/star-atlas-decoders
    for (const tx of recent24h) {
        totalFees24h += tx.fee;
        if (!tx.programIds.includes(SAGE_PROGRAM_ID))
            continue;
        sageFees24h += tx.fee;
        // Determine operation using MULTIPLE sources with enhanced patterns
        let operation = 'Unknown';
        let foundMethod = 'none';
        // Debug: Print transaction signature, accountKeys, and instructions for first 10 tx
        const isFirstFewTx = recent24h.indexOf(tx) < 10;
        if (isFirstFewTx) {
            console.log('--- TX DEBUG ---');
            console.log('Signature:', tx.signature);
            console.log('AccountKeys:', tx.accountKeys);
            console.log('Instructions:', tx.instructions);
            console.log('ProgramIds:', tx.programIds);
            console.log('LogMessages:', tx.logMessages);
            console.log('----------------');
        }
        // ...existing code for operation detection and fleet matching...
        // Legacy operation and fleet detection logic
        // Method 1: Check instruction names from transaction (most reliable)
        if (tx.instructions && tx.instructions.length > 0) {
            for (const instr of tx.instructions) {
                if (OP_MAP[instr]) {
                    operation = OP_MAP[instr];
                    foundMethod = 'instruction_direct';
                    break;
                }
                for (const [key, value] of Object.entries(OP_MAP)) {
                    if (instr.toLowerCase().includes(key.toLowerCase())) {
                        operation = value;
                        foundMethod = 'instruction';
                        break;
                    }
                }
                if (operation !== 'Unknown')
                    break;
            }
        }
        // Method 2: Check log messages for instruction patterns
        if (operation === 'Unknown' && tx.logMessages) {
            for (const log of tx.logMessages) {
                const ixMatch = log.match(/Instruction:\s*(\w+)/i);
                if (ixMatch) {
                    const ixName = ixMatch[1];
                    if (OP_MAP[ixName]) {
                        operation = OP_MAP[ixName];
                        foundMethod = 'log_instruction';
                        break;
                    }
                }
                for (const [key, value] of Object.entries(OP_MAP)) {
                    if (log.includes(key)) {
                        operation = value;
                        foundMethod = 'log_direct';
                        break;
                    }
                }
                if (operation !== 'Unknown')
                    break;
            }
        }
        // Method 3: Pattern-based detection for common operations
        if (operation === 'Unknown') {
            const logsLower = (tx.logMessages || []).join(' ').toLowerCase();
            const innerText = (tx.instructions || []).join(' ').toLowerCase();
            const combinedLower = (logsLower + ' ' + innerText).trim();
            if (combinedLower.includes('craft')) {
                operation = 'Crafting';
                foundMethod = 'pattern_craft';
            }
            else if (combinedLower.includes('mine') || combinedLower.includes('mining')) {
                if (combinedLower.includes('start')) {
                    operation = 'StartMining';
                }
                else if (combinedLower.includes('stop')) {
                    operation = 'StopMining';
                }
                else {
                    operation = 'Mining';
                }
                foundMethod = 'pattern_mining';
            }
            else if (combinedLower.includes('subwarp') || combinedLower.includes('warp')) {
                if (combinedLower.includes('start') || combinedLower.includes('enter')) {
                    operation = 'StartSubwarp';
                }
                else if (combinedLower.includes('stop') || combinedLower.includes('exit') || combinedLower.includes('end')) {
                    operation = 'EndSubwarp';
                }
                else {
                    operation = 'Subwarp';
                }
                foundMethod = 'pattern_warp';
            }
            else if (combinedLower.includes('scan')) {
                if (combinedLower.includes('start')) {
                    operation = 'StartScan';
                }
                else if (combinedLower.includes('stop')) {
                    operation = 'StopScan';
                }
                else {
                    operation = 'Scan';
                }
                foundMethod = 'pattern_scan';
            }
            else if (combinedLower.includes('dock')) {
                operation = combinedLower.includes('undock') ? 'Undock' : 'Dock';
                foundMethod = 'pattern_dock';
            }
            else if (combinedLower.includes('cargo')) {
                operation = combinedLower.includes('unload') ? 'UnloadCargo' : 'LoadCargo';
                foundMethod = 'pattern_cargo';
            }
            else if (combinedLower.includes('fuel')) {
                operation = 'Refuel';
                foundMethod = 'pattern_fuel';
            }
            else if (combinedLower.includes('ammo')) {
                operation = 'Rearm';
                foundMethod = 'pattern_ammo';
            }
        }
        if (operation === 'Unknown')
            unknownOperations++;
        // ENHANCED: Find which fleet is involved using multiple strategies
        let involvedFleet = undefined;
        let involvedFleetName = undefined;
        let matchStrategy = 'none';
        const isFleetOperation = [
            'CreateFleet', 'DisbandFleet', 'Dock', 'Undock', 'StartMining', 'StopMining',
            'StartSubwarp', 'StopSubwarp', 'WarpToCoord', 'WarpLane', 'LoadCargo', 'UnloadCargo',
            'ScanSDU', 'Refuel', 'Rearm', 'AddShip', 'LoadCrew', 'UnloadCrew', 'Respawn'
        ].includes(operation);
        if (tx.accountKeys && tx.accountKeys.length > 0 && isFleetOperation) {
            for (const fleet of specificFleetAccounts) {
                if (tx.accountKeys.includes(fleet)) {
                    involvedFleet = fleet;
                    involvedFleetName = (fleetAccountNames && fleetAccountNames[fleet]) ? fleetAccountNames[fleet] : fleet.substring(0, 8);
                    matchStrategy = 'direct';
                    break;
                }
            }
        }
        if (!involvedFleet) {
            if (operation.includes('Craft') || operation.includes('craft')) {
                involvedFleetName = 'Crafting Operations';
                matchStrategy = 'category_craft';
            }
            else if (operation.includes('Starbase') || operation.includes('starbase')) {
                involvedFleetName = 'Starbase Operations';
                matchStrategy = 'category_starbase';
            }
            else if (operation.includes('Register') || operation.includes('Deregister') || operation.includes('Update')) {
                involvedFleetName = 'Configuration';
                matchStrategy = 'category_config';
            }
            else if (operation.includes('Cargo') || operation.includes('cargo')) {
                involvedFleetName = 'Cargo Management';
                matchStrategy = 'category_cargo';
            }
            else if (operation.includes('Crew') || operation.includes('crew')) {
                involvedFleetName = 'Crew Management';
                matchStrategy = 'category_crew';
            }
            else if (operation.includes('SDU') || operation.includes('Survey')) {
                involvedFleetName = 'Survey & Discovery';
                matchStrategy = 'category_survey';
            }
            else if (operation.includes('Profile') || operation.includes('Progression') || operation.includes('Points')) {
                involvedFleetName = 'Player Profile';
                matchStrategy = 'category_profile';
            }
            else if (operation.includes('Rental') || operation.includes('rental')) {
                involvedFleetName = 'Fleet Rentals';
                matchStrategy = 'category_rental';
            }
            else if (operation.includes('Sector') || operation.includes('Planet') || operation.includes('Star')) {
                involvedFleetName = 'Universe Management';
                matchStrategy = 'category_universe';
            }
            else if (operation.includes('Game') || operation.includes('game')) {
                involvedFleetName = 'Game Management';
                matchStrategy = 'category_game';
            }
            else {
                involvedFleetName = 'Other Operations';
                matchStrategy = 'category_other';
            }
        }
        // Group related operations (start/stop pairs and logistics)
        let groupedOperation = operation;
        if (operation === 'StartSubwarp' || operation === 'StopSubwarp' || operation === 'EndSubwarp') {
            groupedOperation = 'Subwarp';
        }
        else if (operation === 'StartMining' || operation === 'StopMining') {
            groupedOperation = 'Mining';
        }
        else if (operation === 'StartScan' || operation === 'StopScan') {
            groupedOperation = 'Scan';
        }
        else if (operation === 'Dock' || operation === 'Undock' || operation === 'LoadCargo' || operation === 'UnloadCargo') {
            groupedOperation = 'Cargo/Dock';
        }
        else if (operation === 'CraftStart' || operation === 'CraftClaim' || operation === 'Crafting') {
            groupedOperation = 'Crafting';
        }
        else if (operation === 'DepositTokens' || operation === 'WithdrawTokens') {
            groupedOperation = 'Token Ops';
        }
        else if (operation === 'CreateCargoPod' || operation === 'CloseCargoPod' || operation === 'DepositToPod' || operation === 'WithdrawFromPod') {
            groupedOperation = 'Cargo Pods';
        }
        // Update global operation stats with grouped operations
        if (!feesByOperation[groupedOperation]) {
            feesByOperation[groupedOperation] = { count: 0, totalFee: 0, avgFee: 0 };
        }
        const opEntry = feesByOperation[groupedOperation];
        opEntry.count++;
        opEntry.totalFee += tx.fee;
        opEntry.avgFee = opEntry.totalFee / opEntry.count;
        // Track rental operations - mark fleets with rental ops as rented
        if (operation.includes('Rental') || operation.toLowerCase().includes('rental') ||
            operation === 'AddRental' || operation === 'ChangeRental') {
            if (involvedFleet) {
                rentedFleets.add(involvedFleet);
            }
            // Also check all accounts in the transaction for fleet matches
            if (tx.accountKeys) {
                for (const fleet of specificFleetAccounts) {
                    if (tx.accountKeys.includes(fleet)) {
                        rentedFleets.add(fleet);
                        console.log(`[RENTAL] Marked fleet as rented: ${fleet.substring(0, 8)}... (operation: ${operation})`);
                    }
                }
            }
        }
        // Usa la pubkey della flotta come chiave principale (compatibilità legacy)
        // Usa il nome della flotta come chiave principale (compatibilità legacy/frontend)
        const fleetKey = involvedFleetName || 'NONE';
        if (!feesByFleet[fleetKey]) {
            feesByFleet[fleetKey] = {
                totalFee: 0,
                feePercentage: 0,
                totalOperations: 0,
                isRented: false,
                operations: {},
                fleetName: involvedFleetName || fleetKey // salva anche il nome
            };
        }
        const fleetEntry = feesByFleet[fleetKey];
        fleetEntry.totalFee += tx.fee;
        let txRented = false;
        if (involvedFleet) {
            if (fleetRentalStatus[involvedFleet])
                txRented = true;
            if (rentedFleets.has(involvedFleet))
                txRented = true;
        }
        fleetEntry.isRented = !!(fleetEntry.isRented || txRented);
        if (!fleetEntry.operations[groupedOperation]) {
            fleetEntry.operations[groupedOperation] = { count: 0, totalFee: 0, avgFee: 0, percentageOfFleet: 0 };
        }
        const fleetOp = fleetEntry.operations[groupedOperation];
        fleetOp.count++;
        fleetOp.totalFee += tx.fee;
        fleetOp.avgFee = fleetOp.totalFee / fleetOp.count;
    }
    // Compute percentages per fleet & per operation
    Object.values(feesByFleet).forEach(fleetEntry => {
        fleetEntry.feePercentage = fleetEntry.totalFee / (sageFees24h || 1);
        // Calculate total operations for this fleet
        fleetEntry.totalOperations = Object.values(fleetEntry.operations).reduce((sum, op) => sum + op.count, 0);
        Object.values(fleetEntry.operations).forEach(op => {
            op.percentageOfFleet = op.totalFee / (fleetEntry.totalFee || 1);
        });
    });
    Object.values(feesByOperation).forEach(op => {
        op.avgFee = op.totalFee / (op.count || 1);
    });
    console.log('\n📈 Enhanced Analysis Results:');
    console.log(`Total SAGE transactions processed: ${recent24h.length}`);
    console.log(`Total fees: ${totalFees24h / 1000000000} SOL`);
    console.log(`SAGE fees: ${sageFees24h / 1000000000} SOL`);
    console.log(`Unknown operations: ${unknownOperations} (${(unknownOperations / recent24h.length * 100).toFixed(1)}%)`);
    console.log('\n🔍 Operations breakdown:');
    Object.entries(feesByOperation).forEach(([op, data]) => {
        console.log(`  ${op}: ${data.count} transactions, ${(data.totalFee / 1000000000).toFixed(6)} SOL`);
    });
    console.log('\n🚀 Fleet operations:');
    Object.entries(feesByFleet).forEach(([fleet, data]) => {
        const totalOps = Object.values(data.operations).reduce((sum, op) => sum + op.count, 0);
        console.log(`  ${fleet}: ${totalOps} total operations, ${(data.totalFee / 1000000000).toFixed(6)} SOL`);
    });
    // Build final rental status, combining input map with detected rental ops
    const fleetRentalStatusFinal = { ...(fleetRentalStatus || {}) };
    for (const acc of rentedFleets) {
        fleetRentalStatusFinal[acc] = true;
    }
    const rentedFleetAccounts = Object.entries(fleetRentalStatusFinal)
        .filter(([_, v]) => !!v)
        .map(([k]) => k);
    return {
        walletAddress: walletPubkey,
        period: `Last ${hours} hours`,
        totalFees24h,
        sageFees24h,
        transactionCount24h: recent24h.length,
        totalSignaturesFetched: totalSigs,
        feesByFleet,
        feesByOperation,
        transactions: recent24h,
        unknownOperations,
        rentedFleetAccounts,
        fleetAccountNamesEcho: fleetAccountNames || {},
        fleetRentalStatusFinal
    };
    // (Parentesi graffa finale rimossa)
}
