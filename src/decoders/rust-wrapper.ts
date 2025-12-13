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

export function decodeAccountWithRust(data: Buffer | Uint8Array): any | null {
  try {
    const binPath = process.env.RUST_DECODER_BIN || './bin/carbon_crafting_decoder';
    // On Windows the compiled binary may have a .exe suffix o un nome diverso.
    const candidates = [binPath, `${binPath}.exe`, `${binPath}_bin`, `${binPath}_bin.exe`];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      return null;
    }
    const hex = Buffer.from(data).toString('hex');
    const res = spawnSync(found, [hex], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    if (res.error) {
      return null;
    }
    const out = (res.stdout || '').trim();
    if (!out) {
      return null;
    }
    try {
      const parsed = JSON.parse(out);
      // Attempt to normalize into the unified shape { recipe, process, item }
        try {
          const normalized = normalizeRustDecode(parsed);
          return normalized;
        } catch (e) {
          return null;
        }
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

export default { decodeAccountWithRust };
