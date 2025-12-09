import NodeCache from 'node-cache';
import { PublicKey } from '@solana/web3.js';
import { pickNextRpcConnection, tryAcquireRpc, releaseRpc } from './rpc-pool.js';
const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, checkperiod: 120 }); // 24h TTL
function getMetadataPDA(mint) {
    const [pda] = PublicKey.findProgramAddressSync([
        Buffer.from('metadata'),
        METAPLEX_PROGRAM_ID.toBuffer(),
        new PublicKey(mint).toBuffer()
    ], METAPLEX_PROGRAM_ID);
    return pda;
}
async function fetchAccountInfoWithPool(pda) {
    // pick an RPC connection from pool
    const picked = pickNextRpcConnection();
    if (!picked || !picked.connection || picked.index < 0)
        return null;
    const idx = picked.index;
    // Try to acquire capacity
    const acquired = tryAcquireRpc(idx);
    if (!acquired)
        return null;
    const start = Date.now();
    try {
        const acc = await picked.connection.getAccountInfo(pda);
        const latency = Date.now() - start;
        releaseRpc(idx, { success: !!acc, latencyMs: latency, errorType: acc ? undefined : 'other' });
        if (!acc)
            return null;
        return { data: acc.data };
    }
    catch (e) {
        const latency = Date.now() - start;
        releaseRpc(idx, { success: false, latencyMs: latency, errorType: e?.status?.toString?.() || 'other' });
        return null;
    }
}
export async function resolveMintMetadata(mint) {
    if (!mint)
        return null;
    const cached = cache.get(mint);
    if (cached)
        return cached;
    try {
        // Try to use official Metaplex parser if available (optional dependency).
        try {
            // @ts-ignore - dynamic import of optional dependency
            const mpl = await import('@metaplex-foundation/mpl-token-metadata');
            const mlib = mpl;
            if (mlib) {
                try {
                    const pda = getMetadataPDA(mint);
                    const acc = await fetchAccountInfoWithPool(pda);
                    if (acc && acc.data) {
                        const buf = Buffer.from(acc.data);
                        if (mlib.Metadata && typeof mlib.Metadata.deserialize === 'function') {
                            const [meta] = mlib.Metadata.deserialize(buf);
                            const name = (meta.data?.name || '').replace(/\0/g, '').trim();
                            const symbol = (meta.data?.symbol || '').replace(/\0/g, '').trim();
                            const uri = (meta.data?.uri || '').replace(/\0/g, '').trim();
                            const result = { name: name || undefined, symbol: symbol || undefined, uri: uri || undefined };
                            cache.set(mint, result);
                            return result;
                        }
                        if (typeof mlib.decodeMetadata === 'function') {
                            const meta = mlib.decodeMetadata(buf);
                            const name = (meta.data?.name || '').replace(/\0/g, '').trim();
                            const symbol = (meta.data?.symbol || '').replace(/\0/g, '').trim();
                            const uri = (meta.data?.uri || '').replace(/\0/g, '').trim();
                            const result = { name: name || undefined, symbol: symbol || undefined, uri: uri || undefined };
                            cache.set(mint, result);
                            return result;
                        }
                    }
                }
                catch (e) {
                    // Fall through to manual parsing on any error from the library
                }
            }
        }
        catch (e) {
            // optional dependency not installed — continue with manual parser
        }
        const pda = getMetadataPDA(mint);
        const acc = await fetchAccountInfoWithPool(pda);
        if (!acc || !acc.data)
            return null;
        const buf = Buffer.from(acc.data);
        let off = 0;
        try {
            // Key (u8)
            const key = buf.readUInt8(off);
            off += 1;
            // update authority pubkey
            off += 32;
            // mint pubkey
            off += 32;
            // Data: name (string), symbol (string), uri (string), seller_fee_basis_points (u16), creators (option)
            const nameLen = buf.readUInt32LE(off);
            off += 4;
            const name = buf.slice(off, off + nameLen).toString('utf8').replace(/\0/g, '').trim();
            off += nameLen;
            const symbolLen = buf.readUInt32LE(off);
            off += 4;
            const symbol = buf.slice(off, off + symbolLen).toString('utf8').replace(/\0/g, '').trim();
            off += symbolLen;
            const uriLen = buf.readUInt32LE(off);
            off += 4;
            const uri = buf.slice(off, off + uriLen).toString('utf8').replace(/\0/g, '').trim();
            off += uriLen;
            const result = { name: name || undefined, symbol: symbol || undefined, uri: uri || undefined };
            cache.set(mint, result);
            return result;
        }
        catch (e) {
            return null;
        }
    }
    catch (e) {
        return null;
    }
}
export async function resolveMints(mints) {
    const out = {};
    if (!mints || mints.length === 0)
        return out;
    // First check cache and prepare list of PDAs to fetch
    const toFetch = [];
    for (const m of mints) {
        const c = cache.get(m);
        if (c)
            out[m] = c;
        else
            toFetch.push({ mint: m, pda: getMetadataPDA(m) });
    }
    if (toFetch.length === 0)
        return out;
    // Try to use mpl parser if available
    let mpl = null;
    try {
        mpl = await import('@metaplex-foundation/mpl-token-metadata');
    }
    catch (e) {
        mpl = null;
    }
    // Batch PDAs to avoid too large RPC payloads
    const BATCH = 100;
    for (let i = 0; i < toFetch.length; i += BATCH) {
        const batch = toFetch.slice(i, i + BATCH);
        const pdas = batch.map(b => b.pda);
        // fetch using rpc-pool batched helper
        const picked = pickNextRpcConnection();
        if (!picked || !picked.connection || picked.index < 0) {
            // unable to pick RPC -> fallback to individual resolves
            for (const b of batch) {
                try {
                    const md = await resolveMintMetadata(b.mint);
                    out[b.mint] = md;
                }
                catch (e) {
                    out[b.mint] = null;
                }
            }
            continue;
        }
        const idx = picked.index;
        if (!tryAcquireRpc(idx)) {
            // can't acquire, fallback to individual
            for (const b of batch) {
                try {
                    const md = await resolveMintMetadata(b.mint);
                    out[b.mint] = md;
                }
                catch (e) {
                    out[b.mint] = null;
                }
            }
            continue;
        }
        const start = Date.now();
        try {
            // getMultipleAccountsInfo expects PublicKey[]
            // @ts-ignore
            const accounts = await picked.connection.getMultipleAccountsInfo(pdas);
            const latency = Date.now() - start;
            releaseRpc(idx, { success: !!accounts, latencyMs: latency });
            for (let j = 0; j < batch.length; j++) {
                const b = batch[j];
                const acc = accounts && accounts[j] ? accounts[j] : null;
                if (!acc || !acc.data) {
                    out[b.mint] = null;
                    continue;
                }
                const buf = Buffer.from(acc.data);
                let parsed = null;
                // try mpl if available
                if (mpl) {
                    try {
                        if (mpl.Metadata && typeof mpl.Metadata.deserialize === 'function') {
                            const [meta] = mpl.Metadata.deserialize(buf);
                            parsed = {
                                name: (meta.data?.name || '').replace(/\0/g, '').trim() || undefined,
                                symbol: (meta.data?.symbol || '').replace(/\0/g, '').trim() || undefined,
                                uri: (meta.data?.uri || '').replace(/\0/g, '').trim() || undefined
                            };
                        }
                        else if (typeof mpl.decodeMetadata === 'function') {
                            const meta = mpl.decodeMetadata(buf);
                            parsed = {
                                name: (meta.data?.name || '').replace(/\0/g, '').trim() || undefined,
                                symbol: (meta.data?.symbol || '').replace(/\0/g, '').trim() || undefined,
                                uri: (meta.data?.uri || '').replace(/\0/g, '').trim() || undefined
                            };
                        }
                    }
                    catch (e) {
                        parsed = null;
                    }
                }
                // fallback manual parse
                if (!parsed) {
                    try {
                        let off = 0;
                        // key
                        off += 1;
                        off += 32; // update auth
                        off += 32; // mint
                        const nameLen = buf.readUInt32LE(off);
                        off += 4;
                        const name = buf.slice(off, off + nameLen).toString('utf8').replace(/\0/g, '').trim();
                        off += nameLen;
                        const symbolLen = buf.readUInt32LE(off);
                        off += 4;
                        const symbol = buf.slice(off, off + symbolLen).toString('utf8').replace(/\0/g, '').trim();
                        off += symbolLen;
                        const uriLen = buf.readUInt32LE(off);
                        off += 4;
                        const uri = buf.slice(off, off + uriLen).toString('utf8').replace(/\0/g, '').trim();
                        off += uriLen;
                        parsed = { name: name || undefined, symbol: symbol || undefined, uri: uri || undefined };
                    }
                    catch (e) {
                        parsed = null;
                    }
                }
                out[b.mint] = parsed;
                if (parsed)
                    cache.set(b.mint, parsed);
            }
        }
        catch (e) {
            const latency = Date.now() - start;
            releaseRpc(idx, { success: false, latencyMs: latency, errorType: e?.status?.toString?.() || 'other' });
            // fallback per item
            for (const b of batch) {
                try {
                    const md = await resolveMintMetadata(b.mint);
                    out[b.mint] = md;
                }
                catch (err) {
                    out[b.mint] = null;
                }
            }
        }
    }
    // ensure all requested mints have an entry
    for (const m of mints)
        if (!(m in out))
            out[m] = null;
    return out;
}
export default { resolveMintMetadata, resolveMints };
