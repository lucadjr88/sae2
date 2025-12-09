import { spawnSync } from 'child_process';
import fs from 'fs';
import { normalizeRustDecode } from './rust-normalizer.js';
/**
 * Wrapper to call an external Rust decoder binary.
 *
 * Expected behavior of the binary (not enforced here):
 * - Accept a single argument with account data encoded as hex (or via stdin),
 *   and print a JSON object describing the decoded account to stdout.
 * - The path to the binary can be configured with the env var RUST_DECODER_BIN.
 *
 * This wrapper is intentionally permissive: if the binary isn't present or
 * returns invalid data, we return null so callers can fall back to JS decoders.
 */
export function decodeAccountWithRust(data) {
    try {
        const binPath = process.env.RUST_DECODER_BIN || './bin/carbon_crafting_decoder';
        if (!fs.existsSync(binPath))
            return null;
        const hex = Buffer.from(data).toString('hex');
        const res = spawnSync(binPath, [hex], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        if (res.error)
            return null;
        const out = (res.stdout || '').trim();
        if (!out)
            return null;
        try {
            const parsed = JSON.parse(out);
            // Attempt to normalize into the unified shape { recipe, process, item }
            try {
                const normalized = normalizeRustDecode(parsed);
                if (normalized)
                    return normalized;
            }
            catch (e) {
                // fall through to returning raw parsed
            }
            return parsed;
        }
        catch (e) {
            // If output isn't JSON, return raw stdout as a string
            return { raw: out };
        }
    }
    catch (e) {
        return null;
    }
}
export default { decodeAccountWithRust };
