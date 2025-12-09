import { PublicKey } from "@solana/web3.js";
import { newConnection } from './anchor-setup.js';
const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
async function extractAllInstructions() {
    const rpcEndpoint = 'https://api.mainnet-beta.solana.com';
    const rpcWebsocket = 'wss://api.mainnet-beta.solana.com';
    const wallet = 'EEPwiA43Mxe1NdEEz2qRu6pJs2BbfJGVEJNZqPqgTPvt';
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    const pubkey = new PublicKey(wallet);
    console.log(`Fetching transactions for ${wallet}...`);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 50 });
    const instructionData = new Map();
    let sageTxCount = 0;
    for (const sig of signatures) {
        const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        if (!tx)
            continue;
        const programIds = tx.transaction.message.instructions
            .map((ix) => ix.programId?.toString())
            .filter((id) => id);
        if (!programIds.includes(SAGE_PROGRAM_ID))
            continue;
        sageTxCount++;
        const logMessages = tx.meta?.logMessages || [];
        console.log(`\n=== TX ${sageTxCount}: ${sig.signature.substring(0, 8)} ===`);
        // Print only SAGE-related logs
        const sageInvoked = logMessages.findIndex(log => log.includes(SAGE_PROGRAM_ID));
        if (sageInvoked >= 0) {
            // Print 5 lines after SAGE invocation
            for (let i = sageInvoked; i < Math.min(sageInvoked + 6, logMessages.length); i++) {
                console.log(`  ${logMessages[i]}`);
                // Try to extract instruction data from logs
                const line = logMessages[i];
                // Look for common patterns
                if (line.includes('Instruction:')) {
                    const match = line.match(/Instruction: (.+)/);
                    if (match) {
                        const ixName = match[1].trim();
                        instructionData.set(ixName, (instructionData.get(ixName) || 0) + 1);
                    }
                }
                // Look for data logs that might contain instruction discriminator
                if (line.includes('Program log:') || line.includes('Program data:')) {
                    const dataMatch = line.match(/(?:log|data): (.+)/);
                    if (dataMatch) {
                        const data = dataMatch[1].trim();
                        instructionData.set(data, (instructionData.get(data) || 0) + 1);
                    }
                }
            }
        }
        if (sageTxCount >= 10)
            break; // Limit to first 10 SAGE transactions for debugging
    }
    console.log(`\n=== INSTRUCTION DATA FOUND ===\n`);
    const sorted = Array.from(instructionData.entries()).sort((a, b) => b[1] - a[1]);
    sorted.forEach(([name, count]) => {
        console.log(`  ${name}: ${count} times`);
    });
}
extractAllInstructions().catch(console.error);
