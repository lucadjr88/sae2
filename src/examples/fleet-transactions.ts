import { TransactionInfo, FleetOperation } from './types.js';
import { getAccountTransactions } from './account-transactions.js';

export async function getFleetTransactions(
  rpcEndpoint: string,
  rpcWebsocket: string,
  fleetAccountPubkey: string,
  limit: number = 50,
  opts?: { refresh?: boolean }
): Promise<{
  fleetAccount: string;
  totalTransactions: number;
  transactions: TransactionInfo[];
}> {
  const result = await getAccountTransactions(
    rpcEndpoint,
    rpcWebsocket,
    fleetAccountPubkey,
    limit || 50,
    undefined,
    5000,
    opts
  );

  return {
    fleetAccount: fleetAccountPubkey,
    totalTransactions: result.transactions.length,
    transactions: result.transactions
  };
// (Parentesi graffa finale rimossa)
}
