import bs58 from 'bs58';
import { decodeAccountWithRust } from './rust-wrapper.js';
const RECIPE_DISCRIMINATOR = Buffer.from([10, 162, 156, 100, 56, 193, 205, 77]);
const PROCESS_DISCRIMINATOR = Buffer.from([0x69, 0xb8, 0x05, 0x69, 0xaf, 0x70, 0x0d, 0xa9]);
const CRAFTABLE_ITEM_DISCRIMINATOR = Buffer.from([0x7c, 0xf6, 0x38, 0x08, 0x68, 0x5f, 0xf9, 0xfb]);
// Additional canonical discriminators observed in the Carbon decoder
const CRAFTING_FACILITY_DISCRIMINATOR = Buffer.from([58, 73, 35, 17, 92, 247, 49, 30]);
const RECIPE_CATEGORY_DISCRIMINATOR = Buffer.from([0xc7, 0x99, 0x8e, 0xec, 0x63, 0x1a, 0x18, 0xce]);
const DOMAIN_DISCRIMINATOR = Buffer.from([0x18, 0xd9, 0x11, 0x6a, 0x7a, 0x6a, 0x86, 0x39]);
function looksLikePubkey(buf, offset) {
    if (offset + 32 > buf.length)
        return false;
    const slice = buf.slice(offset, offset + 32);
    // not all zeros
    if (slice.every(b => b === 0))
        return false;
    // common-sense bound: pubkeys are unlikely to be ASCII letters only
    let asciiCount = 0;
    for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        if (c >= 32 && c <= 127)
            asciiCount++;
    }
    // if the slice is entirely printable ascii, it's suspicious (not raw pubkey)
    if (asciiCount === 32)
        return false;
    // Heuristic passed
    return true;
}
function scanForDiscriminator(buf, disc, maxOffset = 128) {
    const limit = Math.min(maxOffset, Math.max(0, buf.length - disc.length));
    for (let i = 0; i <= limit; i++) {
        if (buf.slice(i, i + disc.length).equals(disc))
            return i;
    }
    return -1;
}
function safeReadUInt8(buf, off) {
    if (off + 1 > buf.length)
        throw new Error('out-of-bounds');
    return buf.readUInt8(off);
}
function safeReadBigUInt64LE(buf, off) {
    if (off + 8 > buf.length)
        throw new Error('out-of-bounds');
    return buf.readBigUInt64LE(off);
}
function readPubkeyBase58(buf, offset) {
    const slice = buf.slice(offset, offset + 32);
    return bs58.encode(slice);
}
export function isRecipeAccount(data) {
    if (!data)
        return false;
    const buf = Buffer.from(data);
    if (buf.length < RECIPE_DISCRIMINATOR.length)
        return false;
    if (buf.slice(0, RECIPE_DISCRIMINATOR.length).equals(RECIPE_DISCRIMINATOR))
        return true;
    // lenient: sometimes discriminator can be absent — try heuristic
    try {
        // check that there are plausible pubkey bytes at expected offsets
        const off = RECIPE_DISCRIMINATOR.length;
        if (looksLikePubkey(buf, off) && looksLikePubkey(buf, off + 32) && looksLikePubkey(buf, off + 64))
            return true;
    }
    catch (e) { }
    return false;
}
export function decodeRecipe(data) {
    const buf = Buffer.from(data);
    if (!isRecipeAccount(buf))
        return null;
    // Require at least the fixed header size for Recipe (approx 216 bytes) after the discriminator
    if (buf.length < RECIPE_DISCRIMINATOR.length + 216)
        return null;
    // First try the Rust decoder (if available). If it returns something,
    // pass it back to the caller so the canonical decoder can be used.
    try {
        const rust = decodeAccountWithRust(data);
        if (rust)
            return rust;
    }
    catch (e) {
        // ignore and fallback to JS decoder
    }
    // First attempt: strict parse. Try scanning for discriminator in the first 128 bytes
    let off = RECIPE_DISCRIMINATOR.length;
    const foundAt = scanForDiscriminator(buf, RECIPE_DISCRIMINATOR, 128);
    if (foundAt >= 0)
        off = foundAt + RECIPE_DISCRIMINATOR.length;
    try {
        const version = buf.readUInt8(off);
        off += 1;
        const domain = readPubkeyBase58(buf, off);
        off += 32;
        const category = readPubkeyBase58(buf, off);
        off += 32;
        const creator = readPubkeyBase58(buf, off);
        off += 32;
        const duration = Number(buf.readBigInt64LE(off));
        off += 8;
        const min_duration = Number(buf.readBigInt64LE(off));
        off += 8;
        const namespace = buf.slice(off, off + 32);
        off += 32;
        const status = buf.readUInt8(off);
        off += 1;
        const fee_amount = Number(buf.readBigUInt64LE(off));
        off += 8;
        // fee_recipient is an Option<NonSystemPubkey> — Carbon seems to encode as 1 byte + 32 bytes when present
        let fee_recipient = null;
        const maybeFeeFlag = buf.readUInt8(off);
        off += 1;
        if (maybeFeeFlag === 1) {
            fee_recipient = readPubkeyBase58(buf, off);
            off += 32;
        }
        const usage_count = Number(buf.readBigUInt64LE(off));
        off += 8;
        const usage_limit = Number(buf.readBigUInt64LE(off));
        off += 8;
        // Sanity: counts shouldn't be absurd
        if (usage_count < 0 || usage_count > 1000000)
            return null;
        if (usage_limit < 0 || usage_limit > 1000000000)
            return null;
        const value = Number(buf.readBigUInt64LE(off));
        off += 8;
        const consumables_count = buf.readUInt8(off);
        off += 1;
        const non_consumables_count = buf.readUInt8(off);
        off += 1;
        const outputs_count = buf.readUInt8(off);
        off += 1;
        const total_count = buf.readUInt16LE(off);
        off += 2;
        if (total_count > 512)
            return null; // sanity guard
        const recipe_items = [];
        // Remaining data should contain `total_count` items. Each item is at least amount(8)+mint(32)=40 bytes.
        for (let i = 0; i < total_count; i++) {
            if (off + 40 > buf.length)
                break;
            const amount = Number(buf.readBigUInt64LE(off));
            off += 8;
            const mint = readPubkeyBase58(buf, off);
            off += 32;
            let key_index = undefined;
            // Some variants include a u16 key_index; if available and fits, read it.
            if (off + 2 <= buf.length) {
                // Peek but do not assume it's always present: heuristically read if remaining items space suggests it.
                try {
                    key_index = buf.readUInt16LE(off);
                    off += 2;
                }
                catch (e) {
                    key_index = undefined;
                }
            }
            recipe_items.push({ amount, mint, key_index });
        }
        // Additional sanity: ensure recipe_items length seems plausible
        if (recipe_items.length === 0 && total_count > 0)
            return null;
        return {
            version,
            domain,
            category,
            creator,
            duration,
            min_duration,
            namespace: namespace.toString('hex'),
            status,
            fee_amount,
            fee_recipient,
            usage_count,
            usage_limit,
            value,
            consumables_count,
            non_consumables_count,
            outputs_count,
            total_count,
            recipe_items
        };
    }
    catch (err) {
        // Strict parse failed — attempt a lenient parse without discriminator
    }
    try {
        // Lenient parse: try offsets starting at 0 (no discriminator) or where the discriminator might be missing
        off = 0;
        // if a discriminator is found later, prefer that offset
        const found = scanForDiscriminator(buf, RECIPE_DISCRIMINATOR, 256);
        if (found >= 0)
            off = found + RECIPE_DISCRIMINATOR.length;
        const version = safeReadUInt8(buf, off);
        off += 1;
        // require that next bytes look like pubkeys
        if (!looksLikePubkey(buf, off) || !looksLikePubkey(buf, off + 32) || !looksLikePubkey(buf, off + 64))
            return null;
        const domain = readPubkeyBase58(buf, off);
        off += 32;
        const category = readPubkeyBase58(buf, off);
        off += 32;
        const creator = readPubkeyBase58(buf, off);
        off += 32;
        const duration = Number(safeReadBigUInt64LE(buf, off));
        off += 8;
        const min_duration = Number(safeReadBigUInt64LE(buf, off));
        off += 8;
        const namespace = buf.slice(off, off + 32);
        off += 32;
        const status = safeReadUInt8(buf, off);
        off += 1;
        const fee_amount = Number(safeReadBigUInt64LE(buf, off));
        off += 8;
        let fee_recipient = null;
        if (off < buf.length) {
            const maybeFeeFlag = safeReadUInt8(buf, off);
            off += 1;
            if (maybeFeeFlag === 1 && looksLikePubkey(buf, off)) {
                fee_recipient = readPubkeyBase58(buf, off);
                off += 32;
            }
        }
        // best-effort: collect remaining items
        const recipe_items = [];
        while (off + 40 <= buf.length) {
            const amount = Number(safeReadBigUInt64LE(buf, off));
            off += 8;
            const mint = readPubkeyBase58(buf, off);
            off += 32;
            recipe_items.push({ amount, mint });
        }
        if (recipe_items.length === 0)
            return null;
        return { version, domain, category, creator, duration, min_duration, namespace: namespace.toString('hex'), status, fee_amount, fee_recipient, recipe_items };
    }
    catch (e) {
        return null;
    }
}
export function decodeCraftingProcess(data) {
    const buf = Buffer.from(data);
    // require at least the minimal CraftingProcess fixed-size bytes (without discriminator)
    if (buf.length < 165)
        return null;
    let off = 0;
    if (buf.slice(0, PROCESS_DISCRIMINATOR.length).equals(PROCESS_DISCRIMINATOR)) {
        off = PROCESS_DISCRIMINATOR.length;
    }
    else {
        // try to find discriminator within the first 256 bytes; if found, use it; otherwise allow lenient parse
        const found = scanForDiscriminator(buf, PROCESS_DISCRIMINATOR, 256);
        if (found >= 0) {
            off = found + PROCESS_DISCRIMINATOR.length;
        }
        else {
            off = 0;
        }
    }
    // ensure there are enough bytes for the fixed-size CraftingProcess layout
    if (off + 165 > buf.length)
        return null;
    // Try Rust decoder first
    try {
        const rust = decodeAccountWithRust(data);
        if (rust)
            return rust;
    }
    catch (e) { }
    try {
        const version = buf.readUInt8(off);
        off += 1;
        const crafting_id = Number(buf.readBigUInt64LE(off));
        off += 8;
        const authority = readPubkeyBase58(buf, off);
        off += 32;
        const recipe = readPubkeyBase58(buf, off);
        off += 32;
        const crafting_facility = readPubkeyBase58(buf, off);
        off += 32;
        const inputs_checksum = buf.slice(off, off + 16).toString('hex');
        off += 16;
        const outputs_checksum = buf.slice(off, off + 16).toString('hex');
        off += 16;
        // basic checksum sanity: ensure slices were available
        if (inputs_checksum.length !== 32 || outputs_checksum.length !== 32)
            return null;
        const quantity = Number(buf.readBigUInt64LE(off));
        off += 8;
        const status = buf.readUInt8(off);
        off += 1;
        const start_time = Number(buf.readBigInt64LE(off));
        off += 8;
        const end_time = Number(buf.readBigInt64LE(off));
        off += 8;
        const deny_permissionless_claiming = buf.readUInt8(off);
        off += 1;
        const use_local_time = buf.readUInt8(off);
        off += 1;
        const bump = buf.readUInt8(off);
        off += 1;
        return {
            version,
            crafting_id,
            authority,
            recipe,
            crafting_facility,
            inputs_checksum,
            outputs_checksum,
            quantity,
            status,
            start_time,
            end_time,
            deny_permissionless_claiming,
            use_local_time,
            bump
        };
    }
    catch (e) {
        // lenient fallback: give up if strict parse fails
        return null;
    }
}
export function decodeCraftableItem(data) {
    const buf = Buffer.from(data);
    if (buf.length < CRAFTABLE_ITEM_DISCRIMINATOR.length)
        return null;
    let off = 0;
    if (buf.slice(0, CRAFTABLE_ITEM_DISCRIMINATOR.length).equals(CRAFTABLE_ITEM_DISCRIMINATOR)) {
        off = CRAFTABLE_ITEM_DISCRIMINATOR.length;
    }
    else {
        off = 0; // lenient: allow missing discriminator
    }
    // Try Rust decoder first
    try {
        const rust = decodeAccountWithRust(data);
        if (rust)
            return rust;
    }
    catch (e) { }
    try {
        const version = buf.readUInt8(off);
        off += 1;
        const domain = readPubkeyBase58(buf, off);
        off += 32;
        const mint = readPubkeyBase58(buf, off);
        off += 32;
        const creator = readPubkeyBase58(buf, off);
        off += 32;
        const namespace = buf.slice(off, off + 32).toString('hex');
        off += 32;
        const bump = buf.readUInt8(off);
        off += 1;
        return { version, domain, mint, creator, namespace, bump };
    }
    catch (e) {
        return null;
    }
}
export default { isRecipeAccount, decodeRecipe, decodeCraftingProcess, decodeCraftableItem };
