import fs from 'fs';

const url = process.argv[2] || 'http://localhost:3000/api/wallet-sage-fees-stream';
const outFile = process.argv[3] || 'sse_output_profile_delete.txt';
const profileId = process.argv[4] || '4PsiXxqZZkRynC96UMZDQ6yDuMTWB1zmn4hr84vQwaz8';
const walletPubkey = process.argv[5] || null;

const body = {
  profileId,
  walletPubkey: walletPubkey,
  fleetAccounts: [],
  fleetNames: {},
  fleetRentalStatus: {},
  hours: 24
};

async function main() {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error('HTTP error', res.status, await res.text());
      process.exit(1);
    }
    const file = fs.createWriteStream(outFile, { flags: 'w' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    console.log('Streaming SSE to', outFile);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      file.write(chunk);
      process.stdout.write('.');
    }
    file.end();
    console.log('\nStream ended');
  } catch (e) {
    console.error('Stream failed:', e);
    process.exit(1);
  }
}

main();
