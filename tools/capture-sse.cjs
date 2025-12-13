const fs = require('fs');
const fetch = global.fetch || require('node-fetch');
const url = 'http://localhost:3000/api/wallet-sage-fees-stream?refresh=false&update=false';
const body = JSON.stringify({ walletPubkey: '9ynTDJrA8EHqmSskLdooeptY7z4U4qrDUT1uQjEqKVJY' });

(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body,
    });

    if (!res.ok) {
      console.error('Request failed', res.status, res.statusText);
      process.exit(1);
    }

    const dest = fs.createWriteStream('sse_output.txt', { flags: 'w' });
    for await (const chunk of res.body) {
      dest.write(chunk);
    }
    dest.end();
    console.log('Stream saved to sse_output.txt');
  } catch (e) {
    console.error('Error capturing SSE:', e);
    process.exit(1);
  }
})();
