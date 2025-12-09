import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
const ROOT = path.join(process.cwd(), 'cache');
function safeKey(key) {
    // Keep short keys readable; hash long/complex keys
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(key))
        return key;
    return crypto.createHash('sha256').update(key).digest('hex');
}
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
export async function getCache(namespace, key) {
    const nsDir = path.join(ROOT, namespace);
    const file = path.join(nsDir, `${safeKey(key)}.json`);
    try {
        const buf = await fs.readFile(file, 'utf8');
        return JSON.parse(buf);
    }
    catch {
        return null;
    }
}
export async function setCache(namespace, key, data) {
    const nsDir = path.join(ROOT, namespace);
    await ensureDir(nsDir);
    const file = path.join(nsDir, `${safeKey(key)}.json`);
    const payload = {
        savedAt: Date.now(),
        data
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}
export async function getCacheDataOnly(namespace, key) {
    const raw = await getCache(namespace, key);
    // If caller expects only the data field
    // Accept both legacy plain-data and wrapped {savedAt,data}
    if (!raw)
        return null;
    if (typeof raw === 'object' && raw && 'data' in raw)
        return raw.data;
    return raw;
}
export async function getCacheWithTimestamp(namespace, key) {
    const raw = await getCache(namespace, key);
    if (!raw)
        return null;
    if (typeof raw === 'object' && raw && 'data' in raw && 'savedAt' in raw) {
        return { data: raw.data, savedAt: raw.savedAt };
    }
    // Legacy: no timestamp
    return { data: raw, savedAt: 0 };
}
