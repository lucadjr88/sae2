// Simple global RPC call throttle to avoid 429s across modules
// Serializes calls and enforces a minimum delay between them.
const MIN_DELAY_MS = Number(process.env.RPC_MIN_DELAY_MS || 300);
let chain = Promise.resolve();
let lastAt = 0;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export async function rpcCall(fn) {
    const run = async () => {
        const now = Date.now();
        const wait = Math.max(0, MIN_DELAY_MS - (now - lastAt));
        if (wait > 0)
            await sleep(wait);
        try {
            const res = await fn();
            lastAt = Date.now();
            return res;
        }
        catch (e) {
            lastAt = Date.now();
            throw e;
        }
    };
    // Chain to ensure serialization
    chain = chain.then(run, run);
    return chain;
}
export function setRpcMinDelay(ms) {
    // Allow runtime tuning if needed
    process.env.RPC_MIN_DELAY_MS = String(ms);
}
