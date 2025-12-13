import fetch from 'node-fetch';
const server = process.env.SERVER || 'http://localhost:3000';
const wallet = process.argv[2] || 'BkgMA5eLR45wJeCsAMk51U7V9QGKkFj1b2ccWceinJ3y';
(async () => {
  try {
    console.log('Fetching wallet detailed payload for', wallet);
    const res = await fetch(`${server}/api/wallet-sage-fees-detailed`, { method: 'POST', body: JSON.stringify({ walletPubkey: wallet }), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      console.error('Failed to fetch wallet details', await res.text());
      process.exit(1);
    }
    const data = await res.json();
    const txs = data.transactions || data.allTransactions || data.transactions || [];
    console.log('Total txs in payload:', txs.length);
    const picks = [];
    for (const t of txs) {
      const sig = t.signature || t.txid || t.signature;
      if (sig) picks.push(sig);
      if (picks.length >= 2) break;
    }
    if (picks.length === 0) {
      console.error('No signatures found in payload');
      process.exit(1);
    }
    for (const sig of picks) {
      console.log('\n=== TX DETAIL for', sig, '===');
      const dres = await fetch(`${server}/api/tx-details/${sig}`);
      if (!dres.ok) {
        console.error('Failed to fetch tx-details for', sig, await dres.text());
        continue;
      }
      const det = await dres.json();
      console.log(JSON.stringify(det, null, 2));
    }
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
