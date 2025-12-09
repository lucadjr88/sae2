import { Connection } from '@solana/web3.js';
const endpoint = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=746b2d69-ddf7-4f2a-8a81-ff88b195679a';
const conn = new Connection(endpoint, 'confirmed');
const sig = process.argv[2];
if (!sig) {
  console.error('Usage: node tools/inspect-tx.js <signature>');
  process.exit(2);
}

try {
  const tx = await conn.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx) {
    console.error('Transaction not found');
    process.exit(1);
  }
  console.log('message.accountKeys:');
  try {
    const keys = tx.transaction.message.accountKeys || [];
    console.log(JSON.stringify(keys, null, 2));
  } catch (e) {
    console.log('No message.accountKeys field, falling back to accountKeys in meta');
    try {
      console.log(JSON.stringify(tx.meta?.accountKeys || tx.accountKeys || [], null, 2));
    } catch (e2) {
      console.log('No account key list available');
    }
  }
  console.log('\nInstructions:');
  console.log(JSON.stringify(tx.transaction.message.instructions, null, 2));
  console.log('\nMeta.accountKeys (if present):');
  console.log(JSON.stringify(tx.meta?.accountKeys || tx.meta?.accountKeys || [], null, 2));
} catch (e) {
  console.error('Error:', e);
  process.exit(1);
}
