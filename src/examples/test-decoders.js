import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
// Simple file-backed logger to ensure logs are persisted for this runner
const LOG_FILE = path.join(process.cwd(), 'cache', 'test-decoders.log');
function appendLogLine(line) {
    try {
        fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
    }
    catch (e) { }
}
// Monkey-patch console to also append to log file for persistent capture
const __orig_console_log = console.log.bind(console);
const __orig_console_error = console.error.bind(console);
const __orig_console_warn = console.warn.bind(console);
console.log = (...args) => { __orig_console_log(...args); appendLogLine(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
console.error = (...args) => { __orig_console_error(...args); appendLogLine('[ERROR] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
console.warn = (...args) => { __orig_console_warn(...args); appendLogLine('[WARN] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
import { pickNextRpcConnection, tryAcquireRpc, releaseRpc, getRpcUrls } from '../utils/rpc-pool.js';
import { PublicKey } from '@solana/web3.js';
import { decodeRecipe, decodeCraftingProcess, decodeCraftableItem } from '../decoders/crafting-decoder.js';
import { decodeAccountWithRust } from '../decoders/rust-wrapper.js';
const readdir = promisify(fs.readdir);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const CACHE_DIR = process.env.DECODE_CACHE_DIR || path.join(process.cwd(), 'cache', 'decoder-accounts');
const TX_CACHE_DIR = path.join(process.cwd(), 'cache', 'transactions');
const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
const BUILD_TAG = 'pda-seed-v1';
async function ensureCacheDir() {
    try {
        console.log('[test-decoders][debug] ensureCacheDir ->', CACHE_DIR);
        await mkdir(CACHE_DIR, { recursive: true });
        console.log('[test-decoders][debug] cache dir ensured');
    }
    catch (e) {
        console.error('[test-decoders][debug] ensureCacheDir error', String(e));
    }
}
async function listCachedFiles() {
    try {
        console.log('[test-decoders][debug] listing cache dir', CACHE_DIR);
        const files = await readdir(CACHE_DIR);
        const matched = files.filter(f => f.endsWith('.base64') || f.endsWith('.hex'));
        console.log('[test-decoders][debug] cached files found:', matched.length);
        if (matched.length > 0) {
            console.log('[test-decoders][debug] first cached files:', matched.slice(0, 10));
        }
        return matched;
    }
    catch (e) {
        console.error('[test-decoders][debug] listCachedFiles error', String(e));
        return [];
    }
}
async function collectCandidatePubkeys() {
    // Scan transaction cache for accountKeys
    try {
        console.log('[test-decoders][debug] scanning tx cache dir:', TX_CACHE_DIR);
        const files = await readdir(TX_CACHE_DIR);
        const set = new Set();
        for (const f of files) {
            if (!f.endsWith('.json'))
                continue;
            try {
                const full = path.join(TX_CACHE_DIR, f);
                console.log('[test-decoders][debug] reading tx cache file', full);
                const j = JSON.parse(await readFile(full, 'utf8'));
                const txs = j?.data?.transactions || j?.transactions || [];
                for (const t of txs) {
                    const keys = t.accountKeys || t.transaction?.message?.accountKeys || [];
                    for (const k of keys)
                        set.add(k);
                }
            }
            catch (e) {
                console.warn('[test-decoders][debug] skipping file', f, String(e));
            }
        }
        const arr = Array.from(set);
        console.log('[test-decoders][debug] candidate pubkeys collected:', arr.length);
        // limit to a reasonable number to avoid overloading RPC in one go
        return arr.slice(0, 64);
    }
    catch (e) {
        console.error('[test-decoders][debug] collectCandidatePubkeys error', String(e));
        return [];
    }
}
function deriveSagePdas(ids) {
    const seedsToTry = [
        'recipe',
        'recipe_v1',
        'process',
        'crafting_process',
        'craftable',
        'craftable_item',
        'item'
    ];
    const out = new Set();
    try {
        const prog = new PublicKey(SAGE_PROGRAM_ID);
        for (const id of ids) {
            let pk;
            try {
                pk = new PublicKey(id);
            }
            catch (e) {
                continue;
            }
            // try seeds that combine a text seed + the id
            for (const s of seedsToTry) {
                try {
                    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(s), pk.toBuffer()], prog);
                    out.add(pda.toString());
                }
                catch (e) { }
                try {
                    const [pda2] = PublicKey.findProgramAddressSync([pk.toBuffer(), Buffer.from(s)], prog);
                    out.add(pda2.toString());
                }
                catch (e) { }
            }
            // also try the id-only PDA
            try {
                const [p] = PublicKey.findProgramAddressSync([pk.toBuffer()], prog);
                out.add(p.toString());
            }
            catch (e) { }
        }
    }
    catch (e) {
        console.error('[test-decoders][debug] deriveSagePdas error', String(e));
    }
    console.log('[test-decoders][debug] derived PDAs count:', out.size);
    return Array.from(out).slice(0, 256);
}
async function batchFetch(pubkeys, batchSize = 12) {
    const all = [];
    for (let i = 0; i < pubkeys.length; i += batchSize) {
        const batch = pubkeys.slice(i, i + batchSize);
        console.log('[test-decoders][debug] fetching batch', i / batchSize, 'size=', batch.length);
        const res = await fetchAndCacheAccounts(batch);
        all.push(...res);
        // small delay to avoid hammering RPC endpoints (optional)
        await new Promise(r => setTimeout(r, 120));
    }
    return all;
}
async function fetchAndCacheAccounts(pubkeys) {
    if (pubkeys.length === 0)
        return [];
    const picked = pickNextRpcConnection();
    if (!picked || !picked.connection) {
        console.warn('[test-decoders] No healthy RPC connection available from pool');
        console.warn('[test-decoders] rpc urls:', getRpcUrls());
        return [];
    }
    const conn = picked.connection;
    const idx = picked.index;
    const results = [];
    // tryAcquireRpc for concurrency accounting
    if (!tryAcquireRpc(idx)) {
        console.warn('[test-decoders] Could not acquire RPC slot, try again later');
    }
    try {
        console.log('[test-decoders][debug] fetching', pubkeys.length, 'accounts via rpc index', idx);
        // getMultipleAccountsInfo accepts PublicKey[]
        const pks = pubkeys.map(s => new PublicKey(s));
        const infos = await conn.getMultipleAccountsInfo(pks, 'confirmed');
        for (let i = 0; i < pubkeys.length; i++) {
            const info = infos[i];
            if (!info || !info.data) {
                results.push({ pubkey: pubkeys[i], data: null });
                console.log('[test-decoders][debug] account missing:', pubkeys[i]);
                continue;
            }
            const b = Buffer.from(info.data);
            const filePath = path.join(CACHE_DIR, `${pubkeys[i]}.base64`);
            try {
                await writeFile(filePath, b.toString('base64'), 'utf8');
            }
            catch (e) { }
            console.log('[test-decoders][debug] cached account', pubkeys[i], '->', filePath, 'bytes=', b.length);
            results.push({ pubkey: pubkeys[i], data: b });
        }
    }
    catch (err) {
        console.error('[test-decoders] getMultipleAccountsInfo error', String(err));
    }
    finally {
        releaseRpc(idx, { success: true });
    }
    return results;
}
function bufferFromFileContent(filePath) {
    try {
        console.log('[test-decoders][debug] reading cached file', filePath);
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw)
            return null;
        // detect hex vs base64
        if (/^[0-9a-fA-F]+$/.test(raw))
            return Buffer.from(raw, 'hex');
        return Buffer.from(raw, 'base64');
    }
    catch (e) {
        console.error('[test-decoders][debug] bufferFromFileContent error', String(e));
        return null;
    }
}
const SKIP_SEED = process.env.NO_SEED === '1' || process.argv.includes('--no-seed');
// CLI flags: --limit N to limit accounts tested, --all to test entire cache
let LIMIT = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
        const n = parseInt(argv[i + 1], 10);
        if (!Number.isNaN(n) && n > 0)
            LIMIT = n;
    }
    if (a === '--all')
        LIMIT = null;
}
async function run() {
    console.log('[test-decoders] START');
    console.log('[test-decoders] BUILD_TAG=', BUILD_TAG);
    console.log('[test-decoders][debug] cwd=', process.cwd());
    console.log('[test-decoders][debug] nodeVersion=', process.version);
    console.log('[test-decoders] RPC pool URLs:', getRpcUrls());
    await ensureCacheDir();
    const existing = await listCachedFiles();
    let testedAccounts = [];
    if (existing.length === 0 && !SKIP_SEED) {
        console.log('[test-decoders] No cached decoder accounts found — seeding from transaction cache via RPC');
        const candidates = await collectCandidatePubkeys();
        if (candidates.length === 0) {
            console.error('[test-decoders] No candidate pubkeys found in transaction cache. Aborting.');
            process.exit(2);
        }
        // Derive likely SAGE PDAs for the candidate pubkeys and fetch in batches
        console.log('[test-decoders][debug] seed pubkeys (candidates):', candidates.length);
        const derived = deriveSagePdas(candidates);
        console.log('[test-decoders][debug] derived PDAs to fetch:', derived.length);
        // Combine candidates + derived PDAs, unique, and limit to a reasonable total
        const combined = Array.from(new Set([...candidates, ...derived]));
        console.log('[test-decoders][debug] combined unique keys to fetch:', combined.length);
        const toFetch = combined.slice(0, 128);
        const fetched = await batchFetch(toFetch, 12);
        for (const r of fetched)
            if (r.data)
                testedAccounts.push(r.pubkey);
    }
    else {
        // Use existing cached files
        console.log('[test-decoders] Using existing cache, files=', existing.length);
        // sort for deterministic ordering
        const sorted = existing.slice().sort();
        const filesToUse = (LIMIT && LIMIT > 0) ? sorted.slice(0, LIMIT) : sorted;
        if (LIMIT && LIMIT > 0)
            console.log('[test-decoders] Applying limit:', LIMIT);
        for (const f of filesToUse) {
            const pk = f.replace(/\.(base64|hex)$/, '');
            testedAccounts.push(pk);
        }
    }
    if (testedAccounts.length === 0) {
        console.error('[test-decoders] No accounts available to test');
        process.exit(1);
    }
    const summary = { total: 0, recipe: 0, process: 0, item: 0, rust: 0 };
    for (const pk of testedAccounts) {
        const fp = path.join(CACHE_DIR, `${pk}.base64`);
        const buf = bufferFromFileContent(fp);
        summary.total++;
        if (!buf) {
            console.log(`[test-decoders] ${pk} -> no data (file missing or empty)`);
            continue;
        }
        console.log('[test-decoders][debug] running decoders for', pk, 'bytes=', buf.length);
        const rust = decodeAccountWithRust(buf);
        if (rust)
            summary.rust++;
        const r = decodeRecipe(buf);
        const p = decodeCraftingProcess(buf);
        const it = decodeCraftableItem(buf);
        if (r)
            summary.recipe++;
        if (p)
            summary.process++;
        if (it)
            summary.item++;
        console.log('---');
        console.log(pk);
        console.log('rust:', rust ? 'OK' : 'null');
        if (r)
            console.log('Recipe decoded:', JSON.stringify(r, null, 2));
        if (p)
            console.log('Process decoded:', JSON.stringify(p, null, 2));
        if (it)
            console.log('CraftableItem decoded:', JSON.stringify(it, null, 2));
        if (!r && !p && !it && !rust)
            console.log('No decoder produced output for this account.');
    }
    console.log('=== Summary ===');
    console.log(`Total tested: ${summary.total}`);
    console.log(`Rust decodes: ${summary.rust}`);
    console.log(`Recipe decodes: ${summary.recipe}`);
    console.log(`Process decodes: ${summary.process}`);
    console.log(`CraftableItem decodes: ${summary.item}`);
    process.exit(0);
}
const isCli = path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname);
if (isCli) {
    run().catch(err => { console.error('[test-decoders] Fatal', err); process.exit(3); });
}
export default {};
