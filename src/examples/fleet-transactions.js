import { getAccountTransactions } from './account-transactions.js';
export async function getFleetTransactions(rpcEndpoint, rpcWebsocket, fleetAccountPubkey, limit = 50, opts) {
    const result = await getAccountTransactions(rpcEndpoint, rpcWebsocket, fleetAccountPubkey, limit || 50, undefined, 5000, opts);
    return {
        fleetAccount: fleetAccountPubkey,
        totalTransactions: result.transactions.length,
        transactions: result.transactions
    };
    // (Parentesi graffa finale rimossa)
}
