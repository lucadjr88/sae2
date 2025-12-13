import fs from 'fs';

const fetchFn = global.fetch;
if (!fetchFn) {
  console.error('Global fetch not available');
  process.exit(1);
}

const url = process.argv[2] || 'http://localhost:3000/api/fleets';
const outFile = process.argv[3] || 'fleets_after_delete.json';
const profileId = process.argv[4] || '4PsiXxqZZkRynC96UMZDQ6yDuMTWB1zmn4hr84vQwaz8';

async function main(){
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  const text = await res.text();
  fs.writeFileSync(outFile, text, 'utf8');
  console.log('Saved', outFile, 'status', res.status);
}

main().catch(e=>{ console.error(e); process.exit(1); });
