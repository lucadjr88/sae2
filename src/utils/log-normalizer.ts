export function normalizeLog(line: string): string {
  if (!line || typeof line !== 'string') return '';
  let s = line.trim();
  s = s.replace(/\s+/g, ' ');

  // wallet-scan
  const ws = s.match(/\[wallet-scan\].*?Batch\s*(\d+):\s*(\d+)\s*sigs,\s*total:\s*(\d+),\s*delay:\s*(\d+)ms.*RPC:\s*(\d+)\/(\d+)\s*(?:healthy,)?\s*(\d+)\s*processed,\s*(\d+)ms/i);
  if (ws) {
    const [, batch, sigs, total, delayMs, rpcOk, rpcTot, processed, avgMs] = ws as any;
    return `[wallet-scan]Bat${batch}:${sigs}s,total${total},delay${delayMs}ms|RPC:${rpcOk}/${rpcTot},${processed}/${total},${avgMs}msavg`;
  }

  // tx-analysis
  if (/^\[tx-analysis\]/i.test(s)) {
    let t = s.replace(/\bRPC\b/gi, '').replace(/\s+/g, ' ').trim();
    t = t.replace(/(\d+(?:\.\d+)?)\s*(txs|tx\/s|tx|s|ms|%|ok)/gi, (_, num, unit) => `${num}${unit}`);
    t = t.replace(/%\s*ok/gi, '%ok');
    return t;
  }

  // RPC lines: collect E* groups as slash list
  if (/^\[RPC\]/i.test(s)) {
    const tokens = s.split(' ');
    const out: string[] = [];
    const errs: string[] = [];
    for (let t of tokens) {
      if (/^\[RPC\]$/i.test(t)) { out.push('[RPC]'); continue; }
      const eMatch = t.match(/^E\d+:(\d+)$/i);
      if (eMatch) { errs.push(eMatch[1]); continue; }
      out.push(t.replace(/(\d)\s+(txs|tx\/s|tx|s|ms|ok|fail)/i, '$1$2'));
    }
    if (errs.length) out.push(errs.join('/'));
    return out.join(' ');
  }

  // stream sendUpdate
  const sendMatch = s.match(/^(\[stream\].*-> sendUpdate .*processed=)(\d+)/i);
  if (sendMatch) {
    // compress spaces and ensure processed number is attached
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
    const [, batch, processedInBatch, batchTimeElapsed, txPerSec, remaining, sageOpCount, craftingOpCount] = cd as any;
    // Format as: [crafting-details] Batch 13: proc. 26 tx in 0.0s (26.0 tx/s), rem.: 0, ops: 1808, Craft ops: 9
    const txPerSecNorm = txPerSec.replace(/\s+/g, '');
    return `[crafting-details] Batch ${batch}: proc. ${processedInBatch} tx in ${batchTimeElapsed}s (${txPerSecNorm}), rem.: ${remaining}, ops: ${sageOpCount}, Craft ops: ${craftingOpCount}`;
  }

  // generic: remove spaces between numbers and units
  return s.replace(/(\d+(?:\.\d+)?)\s*(txs|tx\/s|tx|s|ms|%|ok)/gi, (_, num, unit) => `${num}${unit}`);
}

export function nlog(...args: any[]) {
  try {
    const joined = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const normalized = normalizeLog(joined);
    console.log(normalized);
  } catch (e) {
    console.log(...args);
  }
}
