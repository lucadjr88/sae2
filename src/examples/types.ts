// Shared interfaces for transaction analysis

export interface TransactionInfo {
  signature: string;
  blockTime: number;
  slot: number;
  err: any;
  memo?: string;
  timestamp: string;
  status: 'success' | 'failed';
  fee: number;
  programIds: string[];
  instructions?: string[];
  logMessages?: string[];
  accountKeys?: string[];
  craftingMaterial?: string;
  decodedRecipe?: any;
  meta?: any;
}

export interface FleetOperation {
  fleetAccount: string;
  operation: string;
  count: number;
  totalFee: number;
  transactions: TransactionInfo[];
}
