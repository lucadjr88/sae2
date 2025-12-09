(async()=>{
  const m = await import('./log-normalizer.js');
  const lines = [
    '[stream] -> sendUpdate type=progress stage=transactions processed=1800',
    '[stream] 📦 Incremental cache saved (1782 tx processed)',
    '[crafting-details] Batch 13: processed 26 tx in 0.0s (26.0 tx/s), remaining: 0, SAGE ops: 1808, Crafting ops: 9'
  ];
  for (const l of lines) {
    console.log('IN :', l);
    console.log('OUT:', m.normalizeLog(l));
    console.log('');
  }
})();
