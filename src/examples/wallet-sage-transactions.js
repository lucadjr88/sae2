import { getAccountTransactions } from './account-transactions.js';
export async function getWalletSageTransactions(rpcEndpoint, rpcWebsocket, walletPubkey, limit = 100, opts) {
    const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
    const result = await getAccountTransactions(rpcEndpoint, rpcWebsocket, walletPubkey, limit, undefined, 5000, opts);
    const allTransactions = result.transactions;
    // Filter SAGE transactions
    const sageTransactions = allTransactions.filter(tx => tx.programIds.includes(SAGE_PROGRAM_ID));
    // Calculate fees by program
    const feesByProgram = {};
    let totalFees = 0;
    let totalSageFees = 0;
    allTransactions.forEach(tx => {
        totalFees += tx.fee;
        if (tx.programIds.includes(SAGE_PROGRAM_ID)) {
            totalSageFees += tx.fee;
        }
        tx.programIds.forEach(programId => {
            if (!feesByProgram[programId]) {
                feesByProgram[programId] = { count: 0, totalFee: 0 };
            }
            feesByProgram[programId].count++;
            feesByProgram[programId].totalFee += tx.fee / tx.programIds.length; // Divide fee among programs
        });
    });
    return {
        walletAddress: walletPubkey,
        totalTransactions: allTransactions.length,
        sageTransactions: sageTransactions.length,
        totalFees,
        totalSageFees,
        transactions: sageTransactions,
        feesByProgram
    };
    // (Parentesi graffa finale rimossa)
}
