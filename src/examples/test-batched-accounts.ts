import { resolveMints } from '../utils/metaplex-metadata.js';
import { getRpcUrls } from '../utils/rpc-pool.js';

async function main() {
  console.log('[test] RPC pool URLs:', getRpcUrls());

  // Example mints to resolve. These include a well-known token and a random pubkey.
  const mints = [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1', // USDC
    'So11111111111111111111111111111111111111112', // wSOL (system)
    '11111111111111111111111111111111' // invalid placeholder
  ];

  console.log('[test] Resolving mints (batched)...', mints);
  const res = await resolveMints(mints);
  console.log('[test] Results:');
  for (const m of mints) {
    console.log(`- ${m} =>`, res[m]);
  }
}

main().catch(err => {
  console.error('[test] Error:', err);
  process.exit(1);
});
