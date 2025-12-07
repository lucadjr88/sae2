# RPC Pool Performance Analysis

## Current Performance (from logs)

```
[RPC]   270tx   6tx/s   460ok   772fail 429:1   402:46  7/13
[batch 8/20] 210/1000 tx (3.23 tx/s) | delay=120ms
```

### Key Metrics
- **Transaction Rate**: 2-6 tx/s (avg ~3 tx/s)
- **Success Rate**: 460/1232 = 37% success rate
- **Failure Rate**: 772/1232 = 63% failure rate
- **Healthy Endpoints**: 7/13 (54%)
- **Rate Limits (429)**: 1 occurrence
- **Payment Required (402)**: 46 occurrences
- **Batch Delay**: 120ms between batches

## Identified Bottlenecks

### 1. **High Failure Rate (63%)**
- **Cause**: 402 "Payment Required" errors (46 occurrences)
- **Affected Endpoints**: Likely endpoints 6-12 (free tier)
  - shyft-demo (index 6)
  - ankr-main (index 7)
  - syndica-guest (index 8)
  - metaplex-main (index 9)
  - rpcpool-free (index 12)
- **Impact**: Wasting time on failed requests, reducing overall throughput

### 2. **Unhealthy Endpoints (6/13 down)**
- **Backoff Duration**: 60-300 seconds
- **Problem**: Once an endpoint hits 100 failures, it's marked unhealthy
- **Impact**: Only 7 endpoints available, limiting parallelism

### 3. **Low Throughput (3 tx/s vs potential 10-15 tx/s)**
- **Batch Size**: 50 transactions per batch
- **Delay**: 120ms between batches
- **Concurrency**: Not fully utilizing available endpoints
- **Problem**: Conservative delays and sequential batch processing

### 4. **Uneven Load Distribution**
```
E0:70 E1:68 E2:64 E5:68
```
- Endpoints receiving similar loads (64-70 tx each)
- But some endpoints (E3, E4, E6-12) not showing activity
- Round-robin working, but many endpoints unavailable

## Endpoint Health Status

| Index | Name | Status | Max Concurrent | Issue |
|-------|------|--------|----------------|-------|
| 0 | helius-main | ✓ Healthy | 10 | Working |
| 1 | onfinality-http | ✓ Healthy | 12 | Working |
| 2 | drpc-http | ✓ Healthy | 12 | Working |
| 3 | quicknode-main | ? Unknown | 2 | Not in logs |
| 4 | getblock-http | ? Unknown | 1 | Not in logs |
| 5 | publicnode-main | ✓ Healthy | 8 | Working |
| 6 | shyft-demo | ✗ Unhealthy | 6 | 402 errors |
| 7 | ankr-main | ✗ Unhealthy | 6 | 402 errors |
| 8 | syndica-guest | ✗ Unhealthy | 6 | 402 errors |
| 9 | metaplex-main | ✗ Unhealthy | 6 | 402 errors |
| 10 | serum-main | ? Unknown | 6 | Not tested |
| 11 | alchemy-demo | ? Unknown | 4 | Not tested |
| 12 | rpcpool-free | ✗ Unhealthy | 4 | 402 errors |

## Recommendations

### Immediate Actions (Quick Wins)

#### 1. Remove Dead Endpoints ⚡ HIGH PRIORITY
Remove endpoints returning 402 errors from `rpc-pool.json`:
- shyft-demo (demo accounts exhausted)
- ankr-main (free tier limits)
- syndica-guest (guest token expired)
- metaplex-main (no longer accepting free requests)
- rpcpool-free (free tier exhausted)

**Expected Impact**: Reduce failure rate from 63% to ~15%, increase throughput to 5-7 tx/s

#### 2. Increase Concurrent Requests ⚡ HIGH PRIORITY
Current working endpoints can handle more load:
```json
{
  "name": "helius-main",
  "maxConcurrent": 15  // was 10
},
{
  "name": "onfinality-http",
  "maxConcurrent": 18  // was 12
},
{
  "name": "drpc-http",
  "maxConcurrent": 18  // was 12
}
```

**Expected Impact**: Increase throughput to 8-10 tx/s

#### 3. Reduce Batch Delay
In `account-transactions.ts`, reduce delay:
```typescript
let currentDelay = 80; // was 120
const MIN_DELAY = 60;  // was 90
```

**Expected Impact**: Increase throughput by 30-40% → 10-12 tx/s

#### 4. Increase Batch Size
```typescript
const BATCH_SIZE = 100; // was 50
```

**Expected Impact**: Better parallelism, fewer context switches → 12-15 tx/s

### Medium-Term Actions

#### 5. Optimize Timeout Settings
Reduce timeout for faster failure detection:
```typescript
const fetchTimeoutMs = 5000; // was 8000
```

#### 6. Implement Parallel Batch Processing
Instead of sequential batch processing, process 2-3 batches in parallel.

#### 7. Add Health Probes
Periodically probe unhealthy endpoints to check if they've recovered.

### Long-Term Actions

#### 8. Upgrade to Premium RPC
Consider upgrading one of:
- Helius (paid tier: 100k+ requests/day)
- QuickNode (paid tier: unlimited requests)
- dRPC (paid tier: higher rate limits)

Cost: ~$50-100/month for high-volume usage

#### 9. Implement Request Batching at RPC Level
Use `getMultipleAccounts` and batch transaction fetches where possible.

## Expected Performance After Optimizations

| Metric | Current | After Quick Wins | After All Optimizations |
|--------|---------|------------------|-------------------------|
| tx/s | 3 | 10 | 15-20 |
| Success Rate | 37% | 85% | 95% |
| Healthy Endpoints | 7/13 | 4/8 | 4-5/5 |
| 402 Errors | 46/250 | 5/250 | 2/250 |
| Time for 1000 tx | 5.5 min | 1.7 min | 1 min |

## Testing Procedure

1. Apply quick wins (remove dead endpoints, increase concurrency)
2. Run: `node tools/test-rpc-performance.js`
3. Monitor server logs for:
   - `[RPC]` lines showing tx/s and success/failure ratio
   - `[batch X/Y]` lines showing overall rate
   - Healthy endpoint count
4. Iterate on batch size and delay values
5. Measure final throughput

## Configuration Changes Summary

### rpc-pool.json
```json
[
  {
    "name": "helius-main",
    "maxConcurrent": 15,
    "cooldownMs": 60000,
    "backoffBaseMs": 1500
  },
  {
    "name": "onfinality-http",
    "maxConcurrent": 18,
    "cooldownMs": 60000,
    "backoffBaseMs": 1000
  },
  {
    "name": "drpc-http",
    "maxConcurrent": 18,
    "cooldownMs": 60000,
    "backoffBaseMs": 1000
  },
  {
    "name": "publicnode-main",
    "maxConcurrent": 12,
    "cooldownMs": 60000,
    "backoffBaseMs": 1200
  }
]
```

### account-transactions.ts
```typescript
const BATCH_SIZE = 100;           // was 50
let currentDelay = 80;            // was 120
const MIN_DELAY = 60;             // was 90
const MAX_DELAY = 1500;           // was 2000
const BACKOFF_MULTIPLIER = 1.4;   // was 1.6
const fetchTimeoutMs = 5000;      // was 8000
```
