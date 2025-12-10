import { PublicKey } from "@solana/web3.js";
import { newConnection, newAnchorProvider } from '../utils/anchor-setup.js';
import { loadKeypair } from '../utils/wallet-setup.js';
const PLAYER_PROFILE_PROGRAM_ID = "pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9";
export async function getPlayerProfile(rpcEndpoint, rpcWebsocket, walletPath, profileId) {
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    const wallet = loadKeypair(walletPath);
    const provider = newAnchorProvider(connection, wallet);
    const profilePubkey = new PublicKey(profileId);
    try {
        console.log('Fetching player profile:', profileId);
        // Get the raw account info
        const accountInfo = await connection.getAccountInfo(profilePubkey);
        if (!accountInfo) {
            throw new Error('Player profile account not found');
        }
        console.log('Account info retrieved, data length:', accountInfo.data.length);
        // Player Profile account structure (from Star Atlas IDL):
        // Discriminator: 8 bytes
        // version: 1 byte (u8)
        // authKeyCount: 2 bytes (u16)
        // authKey (first key): 32 bytes (Pubkey) <- This is the wallet authority!
        // ... rest of the data
        // The authority wallet is at offset 8 + 1 + 2 = 11
        if (accountInfo.data.length < 43) {
            throw new Error('Invalid player profile account data');
        }
        const authorityBytes = accountInfo.data.slice(11, 43);
        const authority = new PublicKey(authorityBytes).toString();
        console.log('Extracted wallet authority from profile:', authority);
        return {
            profileId: profileId,
            authority: authority
        };
    }
    catch (error) {
        console.error('Error fetching profile:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to fetch player profile: ${errorMessage}`);
    }
}
