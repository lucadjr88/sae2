#!/usr/bin/env node
// Simple log normalizer for wallet-scan, RPC and tx-analysis lines.
// Usage: `node tools/log-normalizer.js`

function normalizeLog(line) {
  if (!line || typeof line !== 'string') return '';
  let s = line.trim();

  // Normalize multiple spaces to single space for easier tokenization
  s = s.replace(/\s+/g, ' ');

  // 1) wallet-scan pattern
  // Example input:
  // [wallet-scan] Batch 14: 100 sigs, total: 1300, delay: 90ms | RPC: 7/10 healthy, 26 processed, 556ms avg latency
  const ws = s.match(/\[wallet-scan\].*?Batch\s*(\d+):\s*(\d+)\s*sigs,\s*total:\s*(\d+),\s*delay:\s*(\d+)ms.*RPC:\s*(\d+)\/(\d+)\s*(?:healthy,)?\s*(\d+)\s*processed,\s*(\d+)ms\s*avg\s*latency/i);
  if (ws) {
    const [, batch, sigs, total, delayMs, rpcOk, rpcTot, processed, avgMs] = ws;
    // No spaces between number and unit, abbreviate 'Batch' -> 'Bat'
    return `[wallet-scan]Bat${batch}:${sigs}s,total${total},delay${delayMs}ms|RPC:${rpcOk}/${rpcTot},${processed}/${total},${avgMs}msavg`;
  }

  // 2) RPC lines
  // Example:
  // [RPC]   49tx    75tx/s  49ok    6fail   429:5   402:0   7/10    E0:2 E1:12 E2:12 E3:5 E5:7 E6:5 E7:6
  if (/^\[RPC\]/i.test(s)) {
    // Keep tokens but remove spaces between numbers and units (e.g., '49 tx' -> '49tx')
    // Already compressed spaces; now split tokens
    const tokens = s.split(' ');
    const out = [];
    const errs = [];
    for (let t of tokens) {
      if (/^\[RPC\]$/i.test(t)) { out.push('[RPC]'); continue; }
      // collect E* errors as numeric values
      const eMatch = t.match(/^E\d+:(\d+)$/i);
      if (eMatch) { errs.push(eMatch[1]); continue; }
      // normalize number+unit tokens that might accidentally have spaces removed
      // e.g., '49tx', '75tx/s', '49ok', '6fail' or numeric codes like '429:5'
      out.push(t.replace(/(\d)\s+(txs|tx\/s|tx|s|ms|ok|fail)/i, '$1$2'));
    }
    if (errs.length) out.push(errs.join('/'));
    return out.join(' ');
  }

  // 3) tx-analysis lines
  // Example:
  // [tx-analysis]   1/1600 txs      8.0s    0.12 tx/s       7/10 RPC        92% ok  710ms
  if (/^\[tx-analysis\]/i.test(s)) {
    // Remove the word 'RPC' if present and remove spaces between numbers and common units
    let t = s.replace(/\bRPC\b/gi, '').replace(/\s+/g, ' ').trim();
    // Remove spaces between number and unit for common units
    t = t.replace(/(\d+(?:\.\d+)?)\s*(txs|tx\/s|tx|s|ms|%|ok)/gi, (_, num, unit) => `${num}${unit}`);
    // Also compress ' %ok' -> '%ok' and similar
    t = t.replace(/%\s*ok/gi, '%ok');
    t = t.replace(/txs\s+/gi, 'txs ');
    return t;
  }

  // stream sendUpdate
  const sendMatch = s.match(/^(\[stream\].*-> sendUpdate .*processed=)(\d+)/i);
  if (sendMatch) {
    return s.replace(/processed=(\d+)/i, 'processed$1').replace(/-> sendUpdate/i, '->sendUpdate').replace(/\s+/g, ' ');
  }

  // stream incremental cache saved
  const incMatch = s.match(/\[stream\].*Incremental cache saved.*\((\d+) tx processed\)/i);
  if (incMatch) {
    const n = incMatch[1];
    return s.replace(/\((\d+) tx processed\)/i, `(${n}/totale)`);
  }

  // crafting-details
  const cd = s.match(/\[crafting-details\].*Batch\s*(\d+):\s*processed\s*(\d+)\s*tx in\s*([\d\.]+)s\s*\(([^)]+)\)\s*,\s*remaining:\s*(\d+),\s*SAGE ops:\s*(\d+),\s*Crafting ops:\s*(\d+)/i);
  if (cd) {
    const [, batch, processedInBatch, batchTimeElapsed, txPerSec, remaining, sageOpCount, craftingOpCount] = cd;
    const txPerSecNorm = txPerSec.replace(/\s+/g, '');
    return `[crafting-details] Batch ${batch}: proc. ${processedInBatch} tx in ${batchTimeElapsed}s (${txPerSecNorm}), rem.: ${remaining}, ops: ${sageOpCount}, Craft ops: ${craftingOpCount}`;
  }

  // Fallback: return line with compressed spaces and removed spaces between numbers and units
  return s.replace(/(\d+(?:\.\d+)?)\s*(txs|tx\/s|tx|s|ms|%|ok)/gi, (_, num, unit) => `${num}${unit}`);
}

// If called directly, run sample inputs and print outputs.
if (process.argv[1] && process.argv[1].endsWith('log-normalizer.js')) {
  const samples = [
    '[wallet-scan] Batch 14: 100 sigs, total: 1300, delay: 90ms | RPC: 7/10 healthy, 26 processed, 556ms avg latency',
    '[RPC]   49tx    75tx/s  49ok    6fail   429:5   402:0   7/10    E0:2 E1:12 E2:12 E3:5 E5:7 E6:5 E7:6',
    '[tx-analysis]   1/1600 txs      8.0s    0.12 tx/s       7/10 RPC        92% ok  710ms',
    '[RPC]   69tx    70tx/s  69ok    4fail   429:6   402:0   7/10    E0:8 E1:12 E2:12 E3:8 E5:8 E6:11 E7:10',
    '[tx-analysis]   1/1600 txs      8.0s    0.12 tx/s       7/10 RPC        92% ok  710ms',
  ];

  for (const line of samples) {
    console.log('IN :', line);
    console.log('OUT:', normalizeLog(line));
    console.log('');
  }
}

export { normalizeLog };
