import { AnchorProvider, Wallet } from "@project-serum/anchor";
import { Connection } from "@solana/web3.js";
const confirmTransactionInitialTimeout = 60000;
// Exponential backoff helper for rate limits (429 errors)
export async function withRetry(fn, maxRetries = 3, baseDelay = 500) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            const is429 = error?.message?.includes('429') || error?.response?.status === 429;
            if (is429 && attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`⏳ Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            else {
                throw error;
            }
        }
    }
    throw new Error('withRetry: unreachable');
}
const providerOptions = {
    preflightCommitment: 'confirmed',
    commitment: 'confirmed',
};
/**
 * Creates a new Connection to the Solana blockchain
 * @param rpcEndpoint - the uri for an rpc endpoint
 * @param rpcWebsocket - the uri for an rpc websocket
 * @returns the Connection
 */
export function newConnection(rpcEndpoint, rpcWebsocket) {
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
export function newAnchorProvider(connection, wallet) {
    const provider = new AnchorProvider(connection, new Wallet(wallet), AnchorProvider.defaultOptions());
    return provider;
}
