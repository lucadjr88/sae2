import { newConnection } from './anchor-setup.js';
import * as fs from 'fs';
import * as path from 'path';
let pool = [];
let meta = [];
let rrIndex = 0;
function loadPool() {
    if (pool.length > 0)
        return pool;
    try {
        const p = path.join(process.cwd(), 'public', 'rpc-pool.json');
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        pool = parsed.map(r => ({ ...r, connection: newConnection(r.url, r.ws || undefined), maxConcurrent: r.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 12), cooldownMs: r.cooldownMs || Number(process.env.RPC_COOLDOWN_MS || 60000), backoffBaseMs: r.backoffBaseMs || Number(process.env.RPC_BACKOFF_BASE_MS || 2000) }));
        meta = parsed.map(_ => ({ failures: 0, successes: 0, healthy: true, processedTxs: 0, currentConcurrent: 0, avgLatencyMs: undefined, errorCounts: { rateLimit429: 0, payment402: 0, timeout: 0, other: 0 } }));
        console.log(`[rpc-pool] Loaded ${pool.length} RPC endpoints from ${p}`);
    }
    catch (e) {
        console.warn('[rpc-pool] Could not load rpc-pool.json, falling back to single default endpoint');
        pool = [];
    }
    return pool;
}
export function getRpcPoolSize() {
    const p = loadPool();
    return p.length;
}
export function getRpcConnectionForIndex(i) {
    const p = loadPool();
    if (!p || p.length === 0)
        return null;
    const entry = p[i % p.length];
    return entry.connection || null;
}
export function pickNextRpcConnection() {
    const p = loadPool();
    if (!p || p.length === 0)
        return { connection: null, index: -1 };
    // Round-robin but prefer healthy endpoints
    const len = p.length;
    for (let attempt = 0; attempt < len; attempt++) {
        const idx = rrIndex % len;
        rrIndex = (rrIndex + 1) % len;
        const m = meta[idx];
        const e = p[idx];
        const now = Date.now();
        // skip if in backoff or unhealthy
        if (m && (!m.healthy || (m.backoffUntil && m.backoffUntil > now)))
            continue;
        // skip if concurrency limit reached
        const maxC = e.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 8);
        if (m && typeof m.currentConcurrent === 'number' && m.currentConcurrent >= maxC)
            continue;
        const entry = e;
        return { connection: entry.connection || null, index: idx, url: entry.url };
    }
    // If none healthy, signal caller to backoff instead of returning unhealthy endpoint
    return { connection: null, index: -1, url: undefined };
}
export function getRpcUrls() {
    const p = loadPool();
    return p.map(x => x.url);
}
export function tryAcquireRpc(index) {
    loadPool();
    const m = meta[index];
    const e = pool[index];
    if (!m || !e)
        return false;
    const maxC = e.maxConcurrent || Number(process.env.RPC_MAX_CONCURRENT_PER_ENDPOINT || 12);
    const now = Date.now();
    if (m.backoffUntil && m.backoffUntil > now)
        return false;
    if (!m.healthy)
        return false;
    if (m.currentConcurrent >= maxC)
        return false;
    m.currentConcurrent++;
    return true;
}
export function releaseRpc(index, opts) {
    loadPool();
    const m = meta[index];
    const e = pool[index];
    if (!m || !e)
        return;
    if (m.currentConcurrent > 0)
        m.currentConcurrent--;
    if (opts?.latencyMs) {
        // EMA with alpha = 0.2
        const alpha = 0.2;
        if (!m.avgLatencyMs)
            m.avgLatencyMs = opts.latencyMs;
        else
            m.avgLatencyMs = Math.round(alpha * opts.latencyMs + (1 - alpha) * m.avgLatencyMs);
    }
    if (opts?.success) {
        m.successes++;
        m.failures = Math.max(0, m.failures - 1);
        m.healthy = true;
        m.backoffUntil = undefined;
    }
    else {
        m.failures++;
        m.lastFailureAt = Date.now();
        // classify error
        const t = opts?.errorType || 'other';
        if (t === '429')
            m.errorCounts.rateLimit429++;
        else if (t === '402')
            m.errorCounts.payment402++;
        else if (t === 'timeout')
            m.errorCounts.timeout++;
        else
            m.errorCounts.other++;
        const threshold = Number(process.env.RPC_UNHEALTHY_THRESHOLD || 100);
        if (m.failures >= threshold) {
            m.healthy = false;
            // compute backoff: base * 2^(failures-threshold)
            const base = e.backoffBaseMs || Number(process.env.RPC_BACKOFF_BASE_MS || 2000);
            const exp = Math.min(10, m.failures - threshold);
            const backoff = base * Math.pow(2, exp);
            const cooldown = e.cooldownMs || Number(process.env.RPC_COOLDOWN_MS || 60000);
            m.backoffUntil = Date.now() + backoff + cooldown;
            console.warn(`[rpc-pool] Marking RPC index ${index} as unhealthy (failures=${m.failures}) backoffUntil=${new Date(m.backoffUntil).toISOString()}`);
        }
    }
}
export async function probeRpc(index, timeoutMs = 5000) {
    loadPool();
    const entry = pool[index];
    if (!entry || !entry.connection)
        return false;
    const conn = entry.connection;
    const p = conn.getEpochInfo();
    try {
        const res = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), timeoutMs))]);
        // success -> clear failures and backoff
        const m = meta[index];
        if (m) {
            m.failures = 0;
            m.healthy = true;
            m.backoffUntil = undefined;
        }
        return true;
    }
    catch (e) {
        return false;
    }
}
export function markRpcFailure(index, err) {
    loadPool();
    if (!meta[index])
        return;
    const m = meta[index];
    const e = pool[index];
    if (!m)
        return;
    // Increment with a high cap to avoid runaway counters
    m.failures = Math.min((m.failures || 0) + 1, 100000);
    m.lastFailureAt = Date.now();
    const threshold = Number(process.env.RPC_UNHEALTHY_THRESHOLD || 100);
    // Only transition to unhealthy once (log on transition)
    if (m.failures >= threshold && m.healthy) {
        m.healthy = false;
        // compute backoff: base * 2^(failures-threshold)
        const base = e?.backoffBaseMs || Number(process.env.RPC_BACKOFF_BASE_MS || 2000);
        const exp = Math.min(10, m.failures - threshold);
        const backoff = base * Math.pow(2, exp);
        const cooldown = e?.cooldownMs || Number(process.env.RPC_COOLDOWN_MS || 60000);
        m.backoffUntil = Date.now() + backoff + cooldown;
        console.warn(`[rpc-pool] Marking RPC index ${index} as unhealthy (failures=${m.failures}) backoffUntil=${new Date(m.backoffUntil).toISOString()}`);
    }
}
export function markRpcSuccess(index) {
    loadPool();
    if (!meta[index])
        return;
    // keep compatibility: small success increment
    meta[index].successes++;
    meta[index].failures = Math.max(0, meta[index].failures - 1);
    meta[index].healthy = true;
}
export function recordRpcProcessed(index, count = 1) {
    loadPool();
    if (!meta[index])
        return;
    meta[index].processedTxs += count;
}
export function getRpcMetrics() {
    loadPool();
    return meta.map((m, i) => ({ index: i, healthy: m.healthy, failures: m.failures, successes: m.successes, processedTxs: m.processedTxs, currentConcurrent: m.currentConcurrent, avgLatencyMs: m.avgLatencyMs, backoffUntil: m.backoffUntil, errorCounts: m.errorCounts, url: pool[i]?.url, maxConcurrent: pool[i]?.maxConcurrent, cooldownMs: pool[i]?.cooldownMs }));
}
