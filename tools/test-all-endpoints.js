/**
 * RPC Endpoint Tester
 * Tests all endpoints to verify which are actually working
 */

import { Connection, PublicKey } from '@solana/web3.js';

const ENDPOINTS = [
  { name: "helius-main", url: "https://mainnet.helius-rpc.com/?api-key=746b2d69-ddf7-4f2a-8a81-ff88b195679a" },
  { name: "onfinality-http", url: "https://solana.api.onfinality.io/rpc?apikey=03b093ba-6ada-4de4-92c3-02ec50a67e94" },
  { name: "drpc-http", url: "https://lb.drpc.live/solana/Ao_KB5dDik_SvZXE8ruGKzcSQox2x9cR8JUyQmlfqV1j" },
  { name: "quicknode-main", url: "https://solana-mainnet.quicknode.pro/8f3f3f5b1b6e4e2b8e8f3f5b1b6e4e2b8e8f3f5b/" },
  { name: "getblock-http", url: "https://go.getblock.io/d30d542dce8a4e25b3a1a6bd5ad95d0e" },
  { name: "publicnode-main", url: "https://solana-rpc.publicnode.com" },
  { name: "shyft-demo", url: "https://rpc.shyft.to/?api_key=demo" },
  { name: "ankr-main", url: "https://rpc.ankr.com/solana" },
  { name: "syndica-guest", url: "https://solana-api.syndica.io/api-token-guest" },
  { name: "metaplex-main", url: "https://api.metaplex.solana.com" },
  { name: "serum-main", url: "https://solana-api.projectserum.com" },
  { name: "alchemy-demo", url: "https://solana-mainnet.g.alchemy.com/v2/demo" },
  { name: "rpcpool-free", url: "https://free.rpcpool.com" },
  { name: "getblock-us", url: "https://go.getblock.us/86aac42ad4484f3c813079afc201451c" },
  { name: "blockeden-main", url: "https://api.blockeden.xyz/solana/KeCh6p22EX5AeRHxMSmc" },
  { name: "lavenderfive-main", url: "https://solana.lavenderfive.com/" },
  { name: "leorpc-main", url: "https://solana.leorpc.com/?api_key=FREE" },
  { name: "pocket-main", url: "https://solana.api.pocket.network/" },
  { name: "vibe-main", url: "https://public.rpc.solanavibestation.com/" }
];

const TEST_WALLET = "9ynTDJrA8EHqmSskLdooeptY7z4U4qrDUT1uQjEqKVJY";
const TIMEOUT_MS = 5000;

async function testEndpoint(endpoint) {
  const startTime = Date.now();
  try {
    const conn = new Connection(endpoint.url, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true
    });

    // Test 1: Get version (lightweight)
    const versionPromise = conn.getVersion();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
    );
    
    const version = await Promise.race([versionPromise, timeoutPromise]);
    const latency1 = Date.now() - startTime;

    // Test 2: Get signatures (realistic workload)
    const start2 = Date.now();
    const sigPromise = conn.getSignaturesForAddress(
      new PublicKey(TEST_WALLET), 
      { limit: 5 }
    );
    const timeout2 = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
    );
    
    const signatures = await Promise.race([sigPromise, timeout2]);
    const latency2 = Date.now() - start2;

    return {
      name: endpoint.name,
      status: '✅ WORKING',
      version: version['solana-core'],
      latency: {
        version: latency1,
        signatures: latency2,
        avg: Math.round((latency1 + latency2) / 2)
      },
      signatures: signatures.length,
      error: null
    };

  } catch (err) {
    const latency = Date.now() - startTime;
    const message = err.message || String(err);
    
    // Classify error
    let status = '❌ FAILED';
    let errorType = 'unknown';
    
    if (message.includes('429') || message.includes('rate limit')) {
      status = '⚠️ RATE_LIMIT';
      errorType = '429';
    } else if (message.includes('402') || message.includes('payment') || message.includes('insufficient')) {
      status = '💰 NO_CREDITS';
      errorType = '402';
    } else if (message.includes('Timeout') || message.includes('timeout')) {
      status = '⏱️ TIMEOUT';
      errorType = 'timeout';
    } else if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
      status = '🔌 DNS_FAIL';
      errorType = 'dns';
    } else if (message.includes('403') || message.includes('Forbidden')) {
      status = '🚫 FORBIDDEN';
      errorType = '403';
    }

    return {
      name: endpoint.name,
      status,
      version: null,
      latency: { avg: latency },
      signatures: 0,
      error: errorType,
      message: message.substring(0, 100)
    };
  }
}

async function testAllEndpoints() {
  console.log('=== RPC ENDPOINT COMPREHENSIVE TEST ===\n');
  console.log(`Testing ${ENDPOINTS.length} endpoints...\n`);

  const results = [];
  
  // Test in batches of 5 to avoid overwhelming network
  for (let i = 0; i < ENDPOINTS.length; i += 5) {
    const batch = ENDPOINTS.slice(i, i + 5);
    console.log(`Testing batch ${Math.floor(i/5) + 1}/${Math.ceil(ENDPOINTS.length/5)}...`);
    
    const batchResults = await Promise.all(
      batch.map(ep => testEndpoint(ep))
    );
    
    results.push(...batchResults);
    
    // Print immediate results
    for (const result of batchResults) {
      const latencyStr = result.latency.avg ? `${result.latency.avg}ms` : 'N/A';
      console.log(`  ${result.status.padEnd(15)} ${result.name.padEnd(20)} ${latencyStr.padStart(8)}`);
    }
    console.log('');
  }

  // Summary
  console.log('\n=== SUMMARY ===\n');
  
  const working = results.filter(r => r.status === '✅ WORKING');
  const rateLimit = results.filter(r => r.status === '⚠️ RATE_LIMIT');
  const noCredits = results.filter(r => r.status === '💰 NO_CREDITS');
  const timeout = results.filter(r => r.status === '⏱️ TIMEOUT');
  const failed = results.filter(r => r.status === '❌ FAILED' || r.status === '🔌 DNS_FAIL' || r.status === '🚫 FORBIDDEN');

  console.log(`✅ Working: ${working.length}/${ENDPOINTS.length}`);
  if (working.length > 0) {
    working.sort((a, b) => a.latency.avg - b.latency.avg);
    console.log('\n   By latency (fastest first):');
    working.forEach((r, i) => {
      console.log(`   ${(i+1).toString().padStart(2)}. ${r.name.padEnd(20)} ${r.latency.avg}ms avg (v${r.latency.version}ms + s${r.latency.signatures}ms)`);
    });
  }

  console.log(`\n⚠️  Rate Limited: ${rateLimit.length}`);
  if (rateLimit.length > 0) {
    rateLimit.forEach(r => console.log(`   - ${r.name}`));
    console.log('   → May work after cooldown period');
  }

  console.log(`\n💰 No Credits: ${noCredits.length}`);
  if (noCredits.length > 0) {
    noCredits.forEach(r => console.log(`   - ${r.name}`));
    console.log('   → Free tier exhausted or payment required');
  }

  console.log(`\n⏱️  Timeout: ${timeout.length}`);
  if (timeout.length > 0) {
    timeout.forEach(r => console.log(`   - ${r.name}`));
    console.log('   → Too slow (>5s) or unresponsive');
  }

  console.log(`\n❌ Failed: ${failed.length}`);
  if (failed.length > 0) {
    failed.forEach(r => console.log(`   - ${r.name}: ${r.error}`));
  }

  // Recommendations
  console.log('\n=== RECOMMENDATIONS ===\n');
  
  if (working.length >= 4) {
    console.log('✅ Sufficient working endpoints\n');
    
    const recommended = working.slice(0, 6);
    console.log('Recommended config (top performers):');
    console.log('```json');
    console.log('[');
    recommended.forEach((r, i) => {
      const maxConcurrent = r.latency.avg < 200 ? 18 : 
                           r.latency.avg < 400 ? 15 : 12;
      const backoffMs = r.latency.avg < 200 ? 800 : 
                        r.latency.avg < 400 ? 1200 : 1500;
      
      const ep = ENDPOINTS.find(e => e.name === r.name);
      console.log(`  {`);
      console.log(`    "name": "${r.name}",`);
      console.log(`    "url": "${ep.url}",`);
      console.log(`    "ws": null,`);
      console.log(`    "maxConcurrent": ${maxConcurrent},`);
      console.log(`    "cooldownMs": 60000,`);
      console.log(`    "backoffBaseMs": ${backoffMs}`);
      console.log(`  }${i < recommended.length - 1 ? ',' : ''}`);
    });
    console.log(']');
    console.log('```');
  } else {
    console.log('⚠️  Only ' + working.length + ' working endpoints - consider:');
    console.log('   1. Retesting rate-limited endpoints later');
    console.log('   2. Upgrading to paid RPC providers');
    console.log('   3. Using fewer endpoints with higher concurrency');
  }

  console.log('\n');

  // Export detailed results
  return results;
}

// Run test
testAllEndpoints()
  .then(results => {
    // Write results to file
    import('fs').then(fs => {
      fs.default.writeFileSync(
        './cache/endpoint-test-results.json', 
        JSON.stringify(results, null, 2)
      );
      console.log('📊 Detailed results saved to: ./cache/endpoint-test-results.json\n');
    });
  })
  .catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
