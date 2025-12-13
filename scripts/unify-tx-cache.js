const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(process.cwd(), 'cache', 'transaction-cache');
const FILENAME_RE = /^tx-cache-(.+?)-(\d+)h\.json$/;

function safeKey(key) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return key;
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function listCacheFiles() {
  try {
    const names = await fs.readdir(CACHE_DIR);
    return names.filter(n => FILENAME_RE.test(n));
  } catch (e) {
    return [];
  }
}

async function readCacheFile(name) {
  const p = path.join(CACHE_DIR, name);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeCacheForKey(key, hours, payload) {
  const filename = `${safeKey(`tx-cache-${key}-${hours}h`)}.json`;
  const p = path.join(CACHE_DIR, filename);
  const wrapped = { savedAt: Date.now(), data: payload };
  await fs.writeFile(p, JSON.stringify(wrapped, null, 2), 'utf8');
  return p;
}

async function unlinkIfExists(name) {
  const p = path.join(CACHE_DIR, name);
  try { await fs.unlink(p); } catch (e) { }
}

(async () => {
  console.log('Scanning cache dir:', CACHE_DIR);
  const files = await listCacheFiles();
  if (files.length === 0) return console.log('No tx-cache files found');

  // Group by wallet key (captured group 1)
  const groups = new Map();
  for (const f of files) {
    const m = f.match(FILENAME_RE);
    if (!m) continue;
    const wallet = m[1];
    const hours = parseInt(m[2], 10);
    if (!groups.has(wallet)) groups.set(wallet, []);
    groups.get(wallet).push({ file: f, hours });
  }

  for (const [wallet, items] of groups.entries()) {
    if (items.length <= 1) continue; // already unique
    console.log(`Found ${items.length} cache files for wallet ${wallet}:`, items.map(i=>i.file));

    // Read all payloads and merge tx signatures
    const allTxMap = new Map();
    let anySavedAt = 0;
    for (const it of items) {
      const raw = await readCacheFile(it.file);
      if (!raw) continue;
      const data = raw.data;
      if (!data || !Array.isArray(data.txs)) continue;
      anySavedAt = anySavedAt || raw.savedAt || Date.now();
      for (const tx of data.txs) {
        const sig = tx.signature || tx.txid || (tx.transaction && tx.transaction.signatures && tx.transaction.signatures[0]) || null;
        if (!sig) continue;
        allTxMap.set(sig, tx);
      }
    }

    const merged = Array.from(allTxMap.values()).sort((a,b) => (b.blockTime||0) - (a.blockTime||0));
    // Choose canonical hours: prefer smallest hours (closest window), else first
    const hoursCandidates = items.map(i=>i.hours).sort((a,b)=>a-b);
    const canonicalHours = hoursCandidates[0] || items[0].hours;

    // Write canonical file
    const payload = { txs: merged, fetched: Date.now() };
    const writtenPath = await writeCacheForKey(wallet, canonicalHours, payload);
    console.log('Wrote canonical cache:', writtenPath, 'txs:', merged.length);

    // Delete other files for same wallet (except canonical)
    for (const it of items) {
      const fname = it.file;
      const canonicalName = `${safeKey(`tx-cache-${wallet}-${canonicalHours}h`)}.json`;
      if (fname === canonicalName) continue;
      await unlinkIfExists(fname);
      console.log('Removed legacy cache file:', fname);
    }
  }

  console.log('Cache unification complete');
})();
