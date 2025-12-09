import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT = path.join(process.cwd(), 'cache');

function safeKey(key: string): string {
  // Keep short keys readable; hash long/complex keys
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(key)) return key;
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function getCache<T = any>(namespace: string, key: string): Promise<T | null> {
  const nsDir = path.join(ROOT, namespace);
  const file = path.join(nsDir, `${safeKey(key)}.json`);
  try {
    const buf = await fs.readFile(file, 'utf8');
    return JSON.parse(buf) as T;
  } catch {
    return null;
  }
}

export async function setCache(namespace: string, key: string, data: any): Promise<void> {
  const nsDir = path.join(ROOT, namespace);
  await ensureDir(nsDir);
  const file = path.join(nsDir, `${safeKey(key)}.json`);
  const payload = {
    savedAt: Date.now(),
    data
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
}

export async function getCacheDataOnly<T = any>(namespace: string, key: string): Promise<T | null> {
  const raw = await getCache(namespace, key);
  // If caller expects only the data field
  // Accept both legacy plain-data and wrapped {savedAt,data}
  if (!raw) return null;
  if (typeof raw === 'object' && raw && 'data' in (raw as any)) return (raw as any).data as T;
  return raw as T;
}

export async function getCacheWithTimestamp<T = any>(namespace: string, key: string): Promise<{ data: T; savedAt: number } | null> {
  const raw = await getCache(namespace, key);
  if (!raw) return null;
  if (typeof raw === 'object' && raw && 'data' in (raw as any) && 'savedAt' in (raw as any)) {
    return { data: (raw as any).data as T, savedAt: (raw as any).savedAt };
  }
  // Legacy: no timestamp
  return { data: raw as T, savedAt: 0 };
}
