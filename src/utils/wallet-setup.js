import { Keypair } from "@solana/web3.js";
import fs from 'fs';
/**
 * Loads a Keypair from a file, or generates a temporary one if the file doesn't exist
 * @param walletPath - the path to the wallet file
 * @returns the Keypair
 */
export function loadKeypair(walletPath) {
    // If wallet path doesn't exist, generate a temporary keypair
    // This allows the server to run in read-only mode without requiring a wallet file
    if (!fs.existsSync(walletPath)) {
        console.info('ℹ️  Using ephemeral provider keypair; analysis wallet is derived per profile request');
        return Keypair.generate();
    }
    try {
        const secretKey = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
        console.log(`✅ Loaded wallet: ${keypair.publicKey.toBase58()}`);
        return keypair;
    }
    catch (error) {
        console.error(`❌ Error loading wallet from ${walletPath}:`, error.message);
        console.warn('⚠️  Generating temporary keypair (read-only mode)');
        return Keypair.generate();
    }
}
