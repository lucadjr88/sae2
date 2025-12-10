import fetch from 'node-fetch';
const server = process.env.SERVER || 'http://localhost:3000';
const wallet = process.argv[2] || 'BkgMA5eLR45wJeCsAMk51U7V9QGKkFj1b2ccWceinJ3y';
(async () => {
  try {
    console.log('Requesting detailed wallet fees (non-streaming) for', wallet);
    const res = await fetch(`${server}/api/wallet-sage-fees-detailed`, { method: 'POST', body: JSON.stringify({ walletPubkey: wallet }), headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      console.error('Failed to fetch wallet details', await res.text());
      process.exit(1);
    }
    const data = await res.json();
    const txs = data.transactions || data.allTransactions || data.transactions || [];
    console.log('Total transactions in payload:', txs.length);
    const limit = Math.min(txs.length, 100);
    let counts = { total: limit, materialOnly: 0, recipeFound: 0, quantityFound: 0, processFound: 0 };
    for (let i = 0; i < limit; i++) {
      const sig = txs[i].signature || txs[i].txid || txs[i].signature;
      if (!sig) continue;
      const detRes = await fetch(`${server}/api/tx-details/${sig}`);
      const det = await detRes.json();
      const hasRecipe = !!det.recipe;
      const hasQuantity = det.quantity != null;
      const hasProcess = !!det.process;
      if (!hasRecipe && !hasQuantity && !hasProcess && det.material) counts.materialOnly++;
      if (hasRecipe) counts.recipeFound++;
      if (hasQuantity) counts.quantityFound++;
      if (hasProcess) counts.processFound++;
      if ((i+1) % 10 === 0) console.log(`Processed ${i+1}/${limit}`);
    }
    console.log('Summary:', counts);
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  }
})();
