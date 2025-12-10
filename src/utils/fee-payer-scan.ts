import { RpcPoolConnection } from './rpc/pool-connection.js';
import { PublicKey } from '@solana/web3.js';

export async function scanFeePayerForRented(
  poolConn: RpcPoolConnection,
  feePayer: string,
  profileId: string,
  sigLimit = 1000
) {
  const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
  const signatures = await poolConn.getSignaturesForAddress(new PublicKey(feePayer), { limit: Math.min(1000, sigLimit) });

  const candidateKeys = new Set<string>();
  const checked = new Set<string>();

  for (const s of signatures) {
    try {
      const tx = await poolConn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
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
          if (info.owner.toString() === SAGE_PROGRAM_ID && info.data.length === 536) {
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

  const fleets: Array<{ key: string; label: string; owner: string | null }> = [];
  for (const k of candidateKeys) {
    try {
      const info = await poolConn.getAccountInfo(new PublicKey(k));
      if (!info) continue;
      const ownerBytes = info.data.slice(41, 73);
      let owner: string | null = null;
      try { owner = new PublicKey(ownerBytes).toString(); } catch { owner = null; }
      const labelBytes = info.data.slice(170, 202);
      const label = Buffer.from(labelBytes).toString('utf8').replace(/\0/g, '').trim() || '<unnamed>';
      fleets.push({ key: k, label, owner });
    } catch (e) {
      // ignore
    }
  }

  const rented = fleets.filter(f => f.owner && f.owner !== profileId);
  const owned = fleets.filter(f => f.owner === profileId);

  return { rented, owned, all: fleets };
}
