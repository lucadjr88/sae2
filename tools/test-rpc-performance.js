/**
 * RPC Performance Tester
 * Tests the RPC pool to analyze timing, throughput, and identify bottlenecks
 */

const WALLET = '9ynTDJrA8EHqmSskLdooeptY7z4U4qrDUT1uQjEqKVJY';
const API_URL = 'http://localhost:3000';

async function testRpcPerformance() {
  console.log('=== RPC PERFORMANCE TEST ===\n');
  
  // Test 1: Single request timing
  console.log('Test 1: Single API request timing');
  const start1 = Date.now();
  try {
    const res = await fetch(`${API_URL}/api/wallet-sage-fees-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        walletPubkey: WALLET,
        refresh: true 
      })
    });
    
    if (!res.ok) {
      console.error(`❌ Request failed: ${res.status} ${res.statusText}`);
      return;
    }
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;
    let lastProgress = 0;
    let progressData = [];
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          eventCount++;
          try {
            const data = JSON.parse(line.slice(6));
            
            if (data.status === 'progress') {
              const now = Date.now();
              const timeDiff = lastProgress ? now - lastProgress : 0;
              lastProgress = now;
              
              progressData.push({
                processed: data.processed,
                total: data.total,
                rate: data.rate,
                timeDiff,
                elapsed: (now - start1) / 1000
              });
              
              if (data.processed % 50 === 0 || data.processed === data.total) {
                console.log(`  [${data.processed}/${data.total}] ${data.rate.toFixed(2)} tx/s | interval: ${timeDiff}ms`);
              }
            } else if (data.status === 'complete') {
              console.log(`\n✓ Completed: ${data.analyzed} tx analyzed in ${((Date.now() - start1) / 1000).toFixed(1)}s`);
              console.log(`  Average rate: ${(data.analyzed / ((Date.now() - start1) / 1000)).toFixed(2)} tx/s`);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }
    
    const duration1 = Date.now() - start1;
    console.log(`\nTotal duration: ${(duration1 / 1000).toFixed(2)}s`);
    console.log(`Events received: ${eventCount}`);
    
    // Analyze progress data
    if (progressData.length > 0) {
      const intervals = progressData.filter(p => p.timeDiff > 0).map(p => p.timeDiff);
      const rates = progressData.map(p => p.rate);
      
      console.log('\n=== PERFORMANCE METRICS ===');
      console.log(`Average interval: ${(intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0)}ms`);
      console.log(`Min interval: ${Math.min(...intervals)}ms`);
      console.log(`Max interval: ${Math.max(...intervals)}ms`);
      console.log(`Average rate: ${(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)} tx/s`);
      console.log(`Peak rate: ${Math.max(...rates).toFixed(2)} tx/s`);
      console.log(`Min rate: ${Math.min(...rates).toFixed(2)} tx/s`);
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
  
  // Test 2: RPC pool metrics
  console.log('\n=== RPC POOL DIAGNOSTICS ===');
  console.log('Check server logs for:');
  console.log('  - [RPC] lines showing endpoint distribution (E0:X E1:Y E2:Z)');
  console.log('  - 429 and 402 error counts');
  console.log('  - Healthy endpoint ratio (8/13, 12/13, etc.)');
  console.log('\nRECOMMENDATIONS:');
  console.log('1. If many 429 errors: endpoints hitting rate limits → reduce concurrent requests');
  console.log('2. If many 402 errors: endpoints out of credits → remove or upgrade those endpoints');
  console.log('3. If low healthy ratio: backoff times too aggressive → reduce backoffBaseMs in config');
  console.log('4. If uneven distribution: some endpoints overloaded → adjust maxConcurrent values');
  console.log('5. If tx/s < 3: increase batch size or reduce delay between batches');
}

// Run test
testRpcPerformance().catch(console.error);
