#!/usr/bin/env node
import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { spawnSync } from 'child_process';

const RPC = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=746b2d69-ddf7-4f2a-8a81-ff88b195679a';
const conn = new Connection(RPC, 'confirmed');
const cachePath = process.argv[2] || 'cache/wallet-fees-detailed/8fa559ac0fc9b30014169bcefd8ad2bc2c75508d1a6c33b29bb16d0e96fb794a.json';
const bin = process.argv[3] || './bin/carbon_crafting_decoder.exe';

(async function main(){
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const txs = raw.data.transactions || [];
    console.log('Scanning', txs.length, 'transactions from', cachePath);
    const found = [];
    for (let i = 0; i < txs.length; i++) {
      const t = txs[i];
      const keys = t.accountKeys || [];
      for (const k of keys) {
        try {
          const a = await conn.getAccountInfo(new PublicKey(k));
          if (!a || !a.data) continue;
          const hex = Buffer.from(a.data).toString('hex');
          const res = spawnSync(bin, [hex], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
          const out = (res.stdout || '').trim();
          if (out && out !== '{"decoded":null}') {
            found.push({ txIndex: i, signature: t.signature, pubkey: k, output: out });
            console.log('MATCH', found.length, 'tx', i, 'sig', t.signature, 'pubkey', k);
          }
        } catch (e) {
          // ignore per-account errors
        }
      }
      if (i % 100 === 0) process.stdout.write(`.${i}`);
      if (found.length >= 50) break;
    }
    console.log('\nScan complete. Found', found.length, 'matches');
    if (found.length > 0) console.log(JSON.stringify(found.slice(0,50), null, 2));
  } catch (e) {
    console.error('Scan failed:', e);
    process.exit(1);
  }
})();
