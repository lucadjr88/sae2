#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';
import { RpcPoolConnection } from '../dist/utils/rpc/pool-connection.js';

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

  let sigs = [];
  try {
    sigs = await poolConn.getSignaturesForAddress(new PublicKey(feePayer), { limit: SIG_LIMIT });
  } catch (e) {
    console.error('Failed to fetch signatures from pool:', e?.message || e);
    process.exit(2);
  }
  console.log('Signatures fetched (pool):', sigs.length);

  const candidateKeys = new Set();
  const checked = new Set();

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    try {
      const tx = await poolConn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const accountKeys = tx.transaction?.message?.accountKeys || tx.transaction?.message?.staticAccountKeys || [];
      for (const ak of accountKeys) {
        const pub = (typeof ak === 'string') ? ak : (ak.pubkey?.toString?.() || ak.toString?.());
        if (!pub) continue;
        if (pub === SAGE_PROGRAM_ID) continue;
        if (pub === feePayer) continue;
        if (pub === '11111111111111111111111111111111') continue;
        if (checked.has(pub)) continue;
        checked.add(pub);
        try {
          const info = await poolConn.getAccountInfo(new PublicKey(pub));
          if (!info) continue;
          if (info.owner.toString() === SAGE_PROGRAM_ID && info.data.length === 536) {
            candidateKeys.add(pub);
          }
        } catch (e) {
          // ignore per-account errors
        }
      }
    } catch (e) {
      // tolerate per-tx errors
    }
  }

  console.log('Potential fleet accounts found:', candidateKeys.size);

  const fleets = [];
  const profilePk = profileId;
  for (const k of candidateKeys) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(k));
      if (!info) continue;
      // owner profile at bytes 41..73
      const ownerBytes = info.data.slice(41, 73);
      let owner = null;
      try { owner = new PublicKey(ownerBytes).toString(); } catch (e) { owner = null; }
      // fleet label at bytes 170..201
      const labelBytes = info.data.slice(170, 202);
      const label = Buffer.from(labelBytes).toString('utf8').replace(/\0/g, '').trim() || '<unnamed>';
      fleets.push({ key: k, label, owner });
    } catch (e) {
      // ignore
    }
  }

  // Filter fleets that are not owned by the given profile => rented
  const rented = fleets.filter(f => f.owner && f.owner !== profilePk);

  console.log('\n=== Rented fleets interacted by fee-payer ===');
  if (rented.length === 0) {
    console.log('No rented fleets found in scanned transactions.');
  } else {
    for (const r of rented) {
      console.log('-', r.label, '| key=', r.key, '| ownerProfile=', r.owner);
    }
  }

  // Also list fleets owned by profile that fee-payer interacted with
  const owned = fleets.filter(f => f.owner === profilePk);
  console.log('\n=== Fleets owned by profile that fee-payer interacted with ===');
  for (const o of owned) console.log('-', o.label, '| key=', o.key);

  process.exit(0);
}

main();
