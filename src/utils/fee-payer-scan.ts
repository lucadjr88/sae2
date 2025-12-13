import { RpcPoolConnection } from './rpc/pool-connection.js';
import { detectRentedFleets } from './rental-detection.js';

export async function scanFeePayerForRented(
  poolConn: RpcPoolConnection,
  feePayer: string,
  profileId: string,
  sigLimit = 1000
) {
  // Delegate to centralized detector (with caching)
  return detectRentedFleets(poolConn, feePayer, profileId, sigLimit);
}
