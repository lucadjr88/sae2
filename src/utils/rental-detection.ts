import { RpcPoolConnection } from './rpc/pool-connection.js';
import { PublicKey } from '@solana/web3.js';
import { getCache, getCacheDataOnly, setCache } from './persist-cache.js';

export function isFleetRented(
  ownerStr: string | null,
  subStr: string | null,
  keyStr: string,
  playerProfileId: string,
  walletHeuristicKeys?: Set<string>,
  operatedByWalletKeys?: Set<string>,
  srslyHeuristicKeys?: Set<string>
) {
  const rentedBySubProfile = !!(
    subStr &&
    subStr === playerProfileId &&
    ownerStr &&
    ownerStr !== playerProfileId
  );
  const rentedByWalletHeuristic = !!(
    (walletHeuristicKeys?.has(keyStr) || operatedByWalletKeys?.has(keyStr)) &&
    (ownerStr ? (ownerStr !== playerProfileId) : true)
  );
  const rentedBySrsly = !!(
    srslyHeuristicKeys?.has(keyStr) &&
    (ownerStr ? (ownerStr !== playerProfileId) : true)
  );
  return rentedBySubProfile || rentedByWalletHeuristic || rentedBySrsly;
}

export async function detectRentedFleets(
  poolConn: RpcPoolConnection,
  feePayer: string,
  profileId: string,
  sigLimit = 1000,
  cacheTtlSeconds = 600
) {
  const cacheKey = `${feePayer}:${profileId}`;
  try {
    const cached = await getCache('rented-fleets', cacheKey);
    if (cached) return cached as any;
  } catch (e) {
    // ignore cache errors
  }

  const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
  const signatures = await poolConn.getSignaturesForAddress(new PublicKey(feePayer), { limit: Math.min(1000, sigLimit) });

  const candidateKeys = new Set<string>();
  const checked = new Set<string>();

  for (const s of signatures) {
    try {
      const tx = await poolConn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      try {
        await setCache(`wallet-txs/${feePayer}`, s.signature, tx);
      } catch (e) {
        // ignore cache write errors
      }
      const accountKeys: any[] = (tx.transaction?.message as any)?.accountKeys || (tx.transaction?.message as any)?.staticAccountKeys || [];
      for (const ak of accountKeys) {
        const pub = (typeof ak === 'string') ? ak : (ak.pubkey?.toString?.() || ak.toString?.());
        if (!pub) continue;
        if (pub === SAGE_PROGRAM_ID) continue;
        if (pub === feePayer) continue;
        if (pub === '11111111111111111111111111111111') continue;
        if (checked.has(pub)) continue;
        checked.add(pub);
        try {
          const info = await poolConn.getAccountInfo(new PublicKey(pub));
          if (!info) continue;
          if (info.owner.toString() === SAGE_PROGRAM_ID && info.data.length >= 202) {
            candidateKeys.add(pub);
          }
        } catch (e) {
          // ignore per-account errors
        }
      }
    } catch (e) {
      // tolerate per-tx errors
    }
  }

  const fleets: Array<{ key: string; label: string; owner: string | null; sub?: string | null }> = [];
  for (const k of candidateKeys) {
    try {
      const info = await poolConn.getAccountInfo(new PublicKey(k));
      if (!info) continue;
      const ownerBytes = info.data.slice(41, 73);
      const subBytes = info.data.slice(73, 105);
      let owner: string | null = null;
      let sub: string | null = null;
      try { owner = new PublicKey(ownerBytes).toString(); } catch { owner = null; }
      try { sub = new PublicKey(subBytes).toString(); } catch { sub = null; }
      const labelBytes = info.data.slice(170, 202);
      const label = Buffer.from(labelBytes).toString('utf8').replace(/\0/g, '').trim() || '<unnamed>';
      fleets.push({ key: k, label, owner, sub });
    } catch (e) {
      // ignore
    }
  }

  const rented = fleets.filter(f => f.owner && f.owner !== profileId);
  const owned = fleets.filter(f => f.owner === profileId);
  const result = { rented, owned, all: fleets };

  try {
    await setCache('rented-fleets', cacheKey, result);
  } catch (e) {
    // ignore cache write errors
  }

  return result;
}
