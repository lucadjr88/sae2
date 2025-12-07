import * as fs from 'fs';
import * as path from 'path';
import { newConnection } from '../anchor-setup.js';
import { RpcEntry, RpcMeta, IRpcPool } from './types.js';

export class RpcPoolLoader implements IRpcPool {
  private pool: RpcEntry[] = [];
  private meta: RpcMeta[] = [];
  private loaded = false;

  constructor(private configPath: string = 'public/rpc-pool.json') {}

  load(): void {
    if (this.loaded && this.pool.length > 0) return;

    try {
      const fullPath = path.join(process.cwd(), this.configPath);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const parsed = JSON.parse(raw) as Array<{
        name: string;
        url: string;
        ws?: string | null;
        maxConcurrent?: number;
        cooldownMs?: number;
        backoffBaseMs?: number;
      }>;

      this.pool = parsed.map(r => ({
        ...r,
        connection: newConnection(r.url, r.ws || undefined),
        maxConcurrent: r.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 12),
        cooldownMs: r.cooldownMs || Number(process.env.RPC_COOLDOWN_MS || 60000),
        backoffBaseMs: r.backoffBaseMs || Number(process.env.RPC_BACKOFF_BASE_MS || 2000),
      }));

      this.meta = parsed.map(_ => ({
        failures: 0,
        successes: 0,
        healthy: true,
        processedTxs: 0,
        currentConcurrent: 0,
        avgLatencyMs: undefined,
        errorCounts: { rateLimit429: 0, payment402: 0, timeout: 0, other: 0 },
      }));

      console.log(`[rpc-pool] Loaded ${this.pool.length} RPC endpoints from ${fullPath}`);
      this.loaded = true;
    } catch (e: any) {
      console.error('[rpc-pool] ERROR loading rpc-pool.json:', e.message);
      console.error('[rpc-pool] Tried path:', path.join(process.cwd(), this.configPath));
      console.error('[rpc-pool] Current working directory:', process.cwd());
      console.warn('[rpc-pool] Falling back to single default endpoint');
      this.pool = [];
      this.meta = [];
      this.loaded = true;
    }
  }

  getPool(): RpcEntry[] {
    this.load();
    return this.pool;
  }

  getMeta(): RpcMeta[] {
    this.load();
    return this.meta;
  }

  getSize(): number {
    return this.getPool().length;
  }

  getEntry(index: number): RpcEntry | null {
    const pool = this.getPool();
    if (index < 0 || index >= pool.length) return null;
    return pool[index];
  }

  getMetaAt(index: number): RpcMeta | null {
    const meta = this.getMeta();
    if (index < 0 || index >= meta.length) return null;
    return meta[index];
  }
}

export function createRpcPoolLoader(configPath?: string): RpcPoolLoader {
  return new RpcPoolLoader(configPath);
}
