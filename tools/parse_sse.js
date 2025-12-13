import fs from 'fs/promises';

const inFile = process.argv[2] || 'sse_output.txt';
const outFile = process.argv[3] || 'sse_pretty.txt';

async function main(){
  try{
    const raw = await fs.readFile(inFile, 'utf8');
    // Split on 'data:' which prefixes SSE messages; keep JSON parts
    const parts = raw.split(/data:\s*/g).map(p=>p.trim()).filter(p=>p.length>0);
    const outLines = [];
    for(const p of parts){
      // Remove trailing SSE separators if present
      const msg = p.replace(/\n\n$/, '').replace(/\n$/, '');
      // If message starts with '{' try to parse JSON and pretty-print
      if(msg.startsWith('{')){
        try{
          const obj = JSON.parse(msg);
          outLines.push(JSON.stringify(obj, null, 2));
        }catch(e){
          outLines.push(msg);
        }
      } else {
        outLines.push(msg);
      }
    }
    await fs.writeFile(outFile, outLines.join('\n\n'), 'utf8');
    console.log('Wrote', outFile, 'with', outLines.length, 'messages');
  }catch(e){
    console.error('Failed to parse SSE file:', e);
    process.exit(1);
  }
}

main();
