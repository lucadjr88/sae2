#!/usr/bin/env ts-node
import fs from 'fs';
import path from 'path';
import { newConnection } from '../utils/anchor-setup.js';
import { PublicKey } from '@solana/web3.js';
async function loadRpc() {
    try {
        const rpcPoolRaw = fs.readFileSync(path.join(process.cwd(), 'public', 'rpc-pool.json'), 'utf8');
        const rpcPool = JSON.parse(rpcPoolRaw);
        if (rpcPool && rpcPool.length > 0)
            return rpcPool[0].url;
    }
    catch (e) {
        // ignore
    }
    return process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
}
const MATERIAL_MINTS = {
    // Extend with project's known material mints (placeholders)
    'FUEL_MINT_PUBKEY': 'Fuel',
    'AMMO_MINT_PUBKEY': 'Ammo',
    'FOOD_MINT_PUBKEY': 'Food'
};
function short(s, len = 8) {
    if (!s)
        return '';
    return s.length > len ? s.substring(0, len) + '...' : s;
}
function detectMaterialFromParsed(parsed) {
    if (!parsed)
        return undefined;
    const fields = [];
    if (parsed.info) {
        Object.values(parsed.info).forEach(v => { if (typeof v === 'string')
            fields.push(v); });
    }
    for (const f of fields) {
        if (typeof f !== 'string')
            continue;
        if (/fuel/i.test(f))
            return 'Fuel';
        if (/ore/i.test(f))
            return 'Ore';
        if (/tool/i.test(f))
            return 'Tool';
        if (/component/i.test(f))
            return 'Component';
        if (/food/i.test(f))
            return 'Food';
        if (/ammo/i.test(f))
            return 'Ammo';
        if (MATERIAL_MINTS[f])
            return MATERIAL_MINTS[f];
    }
    return undefined;
}
async function main() {
    const sig = process.argv[2];
    if (!sig) {
        console.error('Usage: ts-node src/examples/inspect-transaction.ts <signature>');
        process.exit(1);
    }
    const rpc = await loadRpc();
    console.log('Using RPC:', rpc.replace(/api-key=[^&]+/, 'api-key=***'));
    const conn = newConnection(rpc);
    console.log('Fetching parsed transaction for', sig);
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) {
        console.error('Transaction not found');
        process.exit(2);
    }
    console.log('\n--- Basic tx info ---');
    console.log('slot:', tx.slot, 'blockTime:', tx.blockTime);
    const sigs = tx?.transaction?.signatures || tx?.signatures || [];
    console.log('signatures:', sigs);
    console.log('\n--- Message instructions ---');
    const msgIxs = (tx.transaction.message.instructions || []);
    msgIxs.forEach((ix, idx) => {
        console.log(`[#${idx}] program: ${ix.program} (${ix.programId?.toString?.() || ix.programId}), parsed: ${!!ix.parsed}`);
        if (ix.parsed) {
            console.log('   parsed.info:', ix.parsed.info ? JSON.stringify(ix.parsed.info) : ix.parsed);
            const mat = detectMaterialFromParsed(ix.parsed);
            if (mat)
                console.log('   -> detected material:', mat);
        }
        else {
            console.log('   raw data:', short(ix.data));
        }
    });
    console.log('\n--- Inner Instructions ---');
    const inner = (tx.meta?.innerInstructions || []);
    for (const blk of inner) {
        console.log('  index:', blk.index);
        for (const iin of (blk.instructions || [])) {
            const parsed = iin.parsed;
            console.log('   program:', iin.program, 'parsed:', !!parsed);
            if (parsed) {
                console.log('     parsed.info keys:', Object.keys(parsed.info || {}));
                const mat = detectMaterialFromParsed(parsed);
                if (mat)
                    console.log('     -> detected material:', mat);
            }
            else {
                console.log('     raw data:', short(iin.data));
            }
        }
    }
    console.log('\n--- Token transfers / pre/post balances ---');
    try {
        const pre = tx.meta?.preTokenBalances || [];
        const post = tx.meta?.postTokenBalances || [];
        if (pre.length || post.length) {
            console.log('preTokenBalances:');
            pre.forEach((p) => console.log(' ', p.mint, 'owner:', p.owner, 'uiTokenAmount:', p.uiTokenAmount));
            console.log('postTokenBalances:');
            post.forEach((p) => console.log(' ', p.mint, 'owner:', p.owner, 'uiTokenAmount:', p.uiTokenAmount));
        }
    }
    catch (e) { }
    console.log('\n--- Log Messages ---');
    const logs = tx.meta?.logMessages || [];
    logs.forEach((l) => console.log(' ', l));
    console.log('\n--- Quick heuristic summary ---');
    // Heuristics: search logs for SAGE specific op names
    const opCandidates = [];
    for (const l of logs) {
        const m = l.match(/Instruction:\s*(\w+)/i) || l.match(/ix([A-Z][a-zA-Z]+)/);
        if (m)
            opCandidates.push(m[1] || m[0]);
        if (/craft/i.test(l))
            opCandidates.push('craft');
        if (/process/i.test(l))
            opCandidates.push('process');
        if (/mint/i.test(l))
            opCandidates.push('mint');
    }
    console.log('Detected candidate ops from logs:', Array.from(new Set(opCandidates)).join(', '));
    // Heuristic: inspect inner instruction parsed infos for mint addresses
    const mintsFound = new Set();
    for (const blk of inner) {
        for (const iin of (blk.instructions || [])) {
            const info = iin?.parsed?.info || {};
            const fields = [info.mint, info.destination, info.source, info.authority];
            for (const f of fields)
                if (typeof f === 'string')
                    mintsFound.add(f);
        }
    }
    if (mintsFound.size) {
        console.log('Candidate mints found in inner instructions:');
        for (const m of mintsFound)
            console.log(' ', m, '->', MATERIAL_MINTS[m] || 'unknown');
    }
    // Try to fetch Metaplex metadata PDA for mints found and print readable strings
    const METAPLEX_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    async function tryMetadata(mint) {
        try {
            const mintPk = new PublicKey(mint);
            const [pda] = await PublicKey.findProgramAddress([
                Buffer.from('metadata'),
                new PublicKey(METAPLEX_PROGRAM).toBuffer(),
                mintPk.toBuffer()
            ], new PublicKey(METAPLEX_PROGRAM));
            const acct = await conn.getAccountInfo(pda);
            if (!acct || !acct.data)
                return undefined;
            const buf = Buffer.from(acct.data);
            // extract printable ascii sequences
            const strs = [];
            let cur = '';
            for (let i = 0; i < buf.length; i++) {
                const c = buf[i];
                if (c >= 32 && c <= 126) {
                    cur += String.fromCharCode(c);
                }
                else {
                    if (cur.length >= 3)
                        strs.push(cur);
                    cur = '';
                }
            }
            if (cur.length >= 3)
                strs.push(cur);
            return strs.slice(0, 6);
        }
        catch (e) {
            return undefined;
        }
    }
    console.log('\n--- On-chain metadata heuristics ---');
    for (const m of mintsFound) {
        process.stdout.write('  ' + m + ' -> ');
        const s = await tryMetadata(m);
        if (!s)
            console.log('no metadata');
        else
            console.log(s.join(' | '));
    }
    console.log('\nDone. Use the parsed fields above to map to recipes or decode instruction data with the star-atlas-decoders cookbook patterns.');
}
main().catch(err => { console.error(err); process.exit(99); });
