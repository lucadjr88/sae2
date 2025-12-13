import { AnchorProvider, Wallet } from "@project-serum/anchor";
import { Commitment, Connection, Keypair } from "@solana/web3.js";

const confirmTransactionInitialTimeout = 60000;

// Exponential backoff helper for rate limits (429 errors)
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 500
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const is429 = error?.message?.includes('429') || error?.response?.status === 429;
      if (is429 && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`⏳ Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('withRetry: unreachable');
}

const providerOptions = {
    preflightCommitment: 'confirmed' as Commitment,
    commitment: 'confirmed' as Commitment,
};

/**
 * Creates a new Connection to the Solana blockchain
 * @param rpcEndpoint - the uri for an rpc endpoint
 * @param rpcWebsocket - the uri for an rpc websocket
 * @returns the Connection
 */
export function newConnection(rpcEndpoint: string, rpcWebsocket?: string): Connection {
  // Note: Connection constructor should be instantaneous (lazy initialization),
  // but some RPC providers may perform blocking verification during construction.
  // Switching to fastest endpoint (drpc-http) should mitigate this issue.
  const connection = new Connection(rpcEndpoint, {
        commitment: providerOptions.commitment,
        confirmTransactionInitialTimeout,
    wsEndpoint: rpcWebsocket || undefined,
        // Disable built-in retry by setting disableRetryOnRateLimit
        disableRetryOnRateLimit: true,
    });

    return connection;
}

/**
 * Creates a new Anchor Client for the Solana programs
 * @param connection - the Solana connection
 * @param wallet - the provider wallet
 * @returns the AnchorProvider
 */
export function newAnchorProvider(connection: Connection, wallet: Keypair): AnchorProvider {
    const provider = new AnchorProvider(
        connection,
        new Wallet(wallet),
        AnchorProvider.defaultOptions(),
    );

    return provider;
}
