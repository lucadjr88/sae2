#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';
import { RpcPoolConnection } from '../dist/utils/rpc/pool-connection.js';
import { detectRentedFleets } from '../dist/utils/rental-detection.js';

async function main() {
  const [,, feePayer, profileId, rpcUrl = 'https://api.mainnet-beta.solana.com', sigLimitArg = '2000'] = process.argv;
  if (!feePayer || !profileId) {
    console.error('Usage: node tools/scan-fee-payer-rented.js <feePayerPubkey> <profileId> [rpcUrl] [sigLimit]');
    process.exit(1);
  }
  // RPC `getSignaturesForAddress` limit is 1000 per request; cap accordingly
  const SIG_LIMIT = Math.min(1000, parseInt(sigLimitArg) || 1000);
  const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
  const conn = new Connection(rpcUrl, { commitment: 'confirmed' });

  console.log('Fetching signatures for fee-payer via RPC pool', feePayer, `limit=${SIG_LIMIT}`);

  const poolConn = new RpcPoolConnection(conn);

  let res = null;
  try {
    res = await detectRentedFleets(poolConn, feePayer, profileId, SIG_LIMIT);
  } catch (e) {
    console.error('Failed to detect rented fleets:', e?.message || e);
    process.exit(2);
  }

  const fleets = res.all || [];
  const rented = res.rented || [];
  const owned = res.owned || [];

  console.log('\n=== Potential fleet accounts found (from detection) ===');
  console.log('Total scanned candidates:', fleets.length);

  console.log('\n=== Rented fleets interacted by fee-payer ===');
  if (rented.length === 0) {
    console.log('No rented fleets found in scanned transactions.');
  } else {
    for (const r of rented) {
      console.log('-', r.label, '| key=', r.key, '| ownerProfile=', r.owner);
    }
  }

  console.log('\n=== Fleets owned by profile that fee-payer interacted with ===');
  for (const o of owned) console.log('-', o.label, '| key=', o.key);

  process.exit(0);
}

main();
