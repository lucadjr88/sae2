#!/usr/bin/env node
import { Connection, PublicKey } from '@solana/web3.js';

async function main() {
  const [,, profileId, rpcUrl = 'https://api.mainnet-beta.solana.com'] = process.argv;
  if (!profileId) {
    console.error('Usage: node tools/get-profile-owner.js <profileId> [rpcUrl]');
    process.exit(1);
  }
  try {
    const conn = new Connection(rpcUrl, { commitment: 'confirmed' });
    const pk = new PublicKey(profileId);
    const info = await conn.getAccountInfo(pk);
    if (!info) {
      console.error('Profile account not found on RPC');
      process.exit(2);
    }
    if (info.data.length < 43) {
      console.error('Unexpected profile account data length:', info.data.length);
      process.exit(3);
    }
    // According to Star Atlas player-profile layout the first authority key
    // is located at offset 8 (discriminator) + 1 (version) + 2 (authKeyCount) = 11
    const authorityBytes = info.data.slice(11, 43);
    const authority = new PublicKey(authorityBytes).toString();
    console.log(authority);
  }
  catch (e) {
    console.error('Error:', e instanceof Error ? e.message : String(e));
    process.exit(4);
  }
}

main();
