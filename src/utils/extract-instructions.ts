import { decodeSageInstruction } from '../decoders/sage-crafting-decoder.js';
import { tryAcquireRpc, releaseRpc } from '../utils/rpc-pool.js';

export type SageMaterialAction = {
  txSignature: string;
  instruction: string;
  action: 'deposit' | 'burn' | 'withdraw' | 'other';
  tokenId: string;
  materialName?: string;
  amount: number;
  from?: string;
  to?: string;
};

/**
 * Estrae i dettagli materiali/token da una lista di transazioni SAGE/crafting
 * @param connection Solana Connection
 * @param signatures Array di signature di transazioni
 * @returns Array di SageMaterialAction
 */
export async function extractSageMaterialActions(
  pickNextRpcConnection: () => { connection: any, index: number },
  signatures: string[]
): Promise<SageMaterialAction[]> {
  const results: SageMaterialAction[] = [];
  for (const sig of signatures) {
    let tx = null;
    let attempts = 0;
    const maxAttempts = 5;
    while (!tx && attempts < maxAttempts) {
      attempts++;
      const picked = pickNextRpcConnection();
      const conn = picked && picked.connection ? picked.connection : null;
      const rpcIndex = picked && typeof picked.index === 'number' ? picked.index : -1;
      if (!conn) continue;
      if (rpcIndex >= 0 && !tryAcquireRpc(rpcIndex)) {
        continue;
      }
      try {
        tx = await conn.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (rpcIndex >= 0) {
          releaseRpc(rpcIndex, { success: true });
        }
      } catch (e) {
        if (rpcIndex >= 0) {
          releaseRpc(rpcIndex, { success: false });
        }
        if (attempts === maxAttempts) {
          console.warn(`[extractSageMaterialActions] Failed to fetch tx for signature: ${sig}`, e);
        }
      }
    }
    if (!tx) {
      console.warn(`[extractSageMaterialActions] No transaction found for signature: ${sig}`);
      continue;
    }
    const logMessages: string[] = tx.meta?.logMessages || [];
    if (logMessages.length === 0) {
      console.warn(`[extractSageMaterialActions] No logMessages for signature: ${sig}`);
    }
    for (const log of logMessages) {
      const decoded = decodeSageInstruction(log);
      if (decoded) {
        console.log(`[extractSageMaterialActions] Decoded log for ${sig}:`, log, decoded);
        // Cerca azione (deposit, burn, withdraw, ecc.)
        let action: 'deposit' | 'burn' | 'withdraw' | 'other' = 'other';
        if (/deposit/i.test(decoded.name || '')) action = 'deposit';
        if (/burn/i.test(decoded.name || '')) action = 'burn';
        if (/withdraw/i.test(decoded.name || '')) action = 'withdraw';
        // Cerca tokenId e quantità tra le inner instructions
        let tokenId = '';
        let amount = 0;
        let from = undefined;
        let to = undefined;
        if (tx.meta?.innerInstructions) {
          for (const inner of tx.meta.innerInstructions) {
            for (const ix of inner.instructions) {
              // Only handle ParsedInstruction, not PartiallyDecodedInstruction
              if ('parsed' in ix && ix.parsed && ix.parsed.info && ix.parsed.info.mint) {
                tokenId = ix.parsed.info.mint;
                amount = Number(ix.parsed.info.amount || 0);
                from = ix.parsed.info.source || ix.parsed.info.authority;
                to = ix.parsed.info.destination;
              }
            }
          }
        }
        results.push({
          txSignature: sig,
          instruction: decoded.name || decoded.type,
          action,
          tokenId,
          materialName: decoded.material,
          amount,
          from,
          to,
        });
      } else {
        console.log(`[extractSageMaterialActions] No match for log in ${sig}:`, log);
      }
    }
  }
  if (results.length === 0) {
    console.warn('[extractSageMaterialActions] No material actions extracted for signatures:', signatures);
  }
  return results;
}
import { Connection, PublicKey } from "@solana/web3.js";
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
  
  const instructionData = new Map<string, number>();
  let sageTxCount = 0;
  
  for (const sig of signatures) {
    const tx = await connection.getParsedTransaction(sig.signature, { 
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed'
    });
    
    if (!tx) continue;
    
    const programIds = tx.transaction.message.instructions
      .map((ix: any) => ix.programId?.toString())
      .filter((id: any) => id);
      
    if (!programIds.includes(SAGE_PROGRAM_ID)) continue;
    
    sageTxCount++;
    const logMessages: string[] = tx.meta?.logMessages || [];
    
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
    
    if (sageTxCount >= 10) break; // Limit to first 10 SAGE transactions for debugging
  }
  
  console.log(`\n=== INSTRUCTION DATA FOUND ===\n`);
  const sorted = Array.from(instructionData.entries()).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([name, count]) => {
    console.log(`  ${name}: ${count} times`);
  });
}

extractAllInstructions().catch(console.error);
