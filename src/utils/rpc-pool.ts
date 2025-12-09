import { getGlobalRpcPoolManager } from './rpc/rpc-pool-manager.js';

export function getRpcPoolSize() {
  return getGlobalRpcPoolManager().getPoolSize();
}

export function getRpcConnectionForIndex(i: number) {
  return getGlobalRpcPoolManager().getConnectionForIndex(i);
}

export function pickNextRpcConnection() {
  return getGlobalRpcPoolManager().pickNextRpc();
}

export function getRpcUrls() {
  return getGlobalRpcPoolManager().getPoolUrls();
}

export function tryAcquireRpc(index: number) {
  return getGlobalRpcPoolManager().tryAcquireRpc(index);
}

export function releaseRpc(index: number, opts?: { success?: boolean; latencyMs?: number; errorType?: string }) {
  return getGlobalRpcPoolManager().releaseRpc(index, opts);
}

export async function probeRpc(index: number, timeoutMs = 5000) {
  return getGlobalRpcPoolManager().probeRpc(index, timeoutMs);
}

export function markRpcFailure(index: number, err?: any) {
  return getGlobalRpcPoolManager().markRpcFailure(index);
}

export function markRpcSuccess(index: number) {
  return getGlobalRpcPoolManager().markRpcSuccess(index);
}

export function recordRpcProcessed(index: number, count: number = 1) {
  return getGlobalRpcPoolManager().recordRpcProcessed(index, count);
}

export function getRpcMetrics() {
  return getGlobalRpcPoolManager().getRpcMetrics();
}
