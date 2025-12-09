// ...existing code...


import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { getGameInfo } from './examples/01-game.js';
import { getPlayerProfile } from './examples/02-profile.js';
import { getFleets } from './examples/03-fleets.js';
import { getPlanets } from './examples/04-planets.js';
import { getShipsForFleet } from './examples/05-compose-fleet.js';
import { getFleetTransactions } from './examples/fleet-transactions.js';
import { getWalletSageTransactions } from './examples/wallet-sage-transactions.js';
import { getWalletSageFeesDetailed } from './examples/wallet-sage-fees-detailed.js';
import { getCacheDataOnly, getCacheWithTimestamp, setCache } from './utils/persist-cache.js';
import { decodeSageInstruction, decodeSageInstructionFromLogs } from './decoders/sage-crafting-decoder.js';
import { SAGE_STARBASED_INSTRUCTIONS, CRAFTING_INSTRUCTIONS } from './decoders/universal-decoder.js';
import fetch from 'node-fetch';
import fs from 'fs';
import { getRpcMetrics, pickNextRpcConnection, tryAcquireRpc, releaseRpc, markRpcFailure, markRpcSuccess } from './utils/rpc-pool.js';
import { getGlobalRpcPoolManager } from './utils/rpc/rpc-pool-manager.js';
import { RpcPoolConnection } from './utils/rpc/pool-connection.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { nlog } from './utils/log-normalizer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Config
let RPC_ENDPOINT: string = process.env.RPC_ENDPOINT || '';
let RPC_WEBSOCKET: string = process.env.RPC_WEBSOCKET || '';
try {
  const rpcPoolRaw = fs.readFileSync(path.join(__dirname, '../public/rpc-pool.json'), 'utf8');
  const rpcPool = JSON.parse(rpcPoolRaw);
  if (rpcPool && rpcPool.length > 0) {
    RPC_ENDPOINT = rpcPool[0].url;
    // Per ora websocket non usato, si può estendere in futuro
  }
} catch (err) {
  console.warn('⚠️ Impossibile caricare rpc-pool.json, uso endpoint di default:', err);
  RPC_ENDPOINT = RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=746b2d69-ddf7-4f2a-8a81-ff88b195679a';
  RPC_WEBSOCKET = RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=746b2d69-ddf7-4f2a-8a81-ff88b195679a';
}
const WALLET_PATH = process.env.WALLET_PATH || path.join(__dirname, '../id.json');

// Initialize RPC pool singleton at server startup
const rpcPoolManager = getGlobalRpcPoolManager();
console.log(`RPC Pool initialized with ${rpcPoolManager.getPoolSize()} endpoints`);

// Create a shared RPC pool connection for all requests
const defaultServerConnection = new Connection(RPC_ENDPOINT, 'confirmed');
const globalPoolConnection = new RpcPoolConnection(defaultServerConnection, rpcPoolManager);

console.log('SA Explorer Server Configuration:');
console.log('   RPC Endpoint:', RPC_ENDPOINT.replace(/api-key=[^&]+/, 'api-key=***'));
console.log('   Wallet Path:', WALLET_PATH);
console.log('   Port:', PORT);

// Homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Debug endpoint: return local test_result.json to force UI rendering of known dataset
app.get('/api/debug/test-result', (_req, res) => {
  try {
    const testPath = path.join(__dirname, '../test_result.json');
    if (!fs.existsSync(testPath)) {
      return res.status(404).json({ error: 'test_result.json not found on server' });
    }
    const raw = fs.readFileSync(testPath, 'utf8');
    const parsed = JSON.parse(raw);
    return res.json(parsed);
  } catch (err: any) {
    console.error('❌ /api/debug/test-result error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// API: 01 - Game Info
app.get('/api/game', async (req, res) => {
  try {
    const result = await getGameInfo(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// API: 02 - Player Profile
app.post('/api/profile', async (req, res) => {
  const { profileId } = req.body;
  if (!profileId) {
    return res.status(400).json({ error: 'profileId required' });
  }
  try {
    const refresh = (req.query.refresh === 'true') || (req.body && req.body.refresh === true);
    if (!refresh) {
      const cached = await getCacheDataOnly<any>('profile', profileId);
      if (cached) {
        res.setHeader('X-Cache-Hit', 'disk');
        return res.json(cached);
      }
    }
    const result = await getPlayerProfile(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH, profileId);
    await setCache('profile', profileId, result);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: 03 - Fleets
app.post('/api/fleets', async (req, res) => {
  const { profileId } = req.body;
  console.log(`[api/fleets] Received request at ${new Date().toISOString()} with body:`, { profileId });
  if (!profileId) {
    return res.status(400).json({ error: 'profileId required' });
  }
  try {
    const refresh = (req.query.refresh === 'true') || (req.body && req.body.refresh === true);
    if (!refresh) {
      const cached = await getCacheDataOnly<any>('fleets', profileId);
      if (cached) {
        res.setHeader('X-Cache-Hit', 'disk');
        // If cache exists but walletAuthority is missing, refresh to attempt derivation again
        if (cached.walletAuthority == null) {
          console.log(`[api/fleets] Cache hit but walletAuthority missing for ${profileId}, forcing refresh`);
        } else {
          return res.json(cached);
        }
      }
    }
    const result = await getFleets(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH, profileId);
    await setCache('fleets', profileId, result);
    res.json(result);
  } catch (err: any) {
    console.error('❌ /api/fleets error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: err.message, details: err.stack });
  }
});

// API: 04 - Planets
app.post('/api/planets', async (req, res) => {
  const { x, y } = req.body;
  if (x === undefined || y === undefined) {
    return res.status(400).json({ error: 'x and y coordinates required' });
  }
  try {
    const result = await getPlanets(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH, parseInt(x), parseInt(y));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: 05 - Ships for Fleet Composition
app.post('/api/compose-fleet', async (req, res) => {
  const { profileId, x, y } = req.body;
  if (!profileId || x === undefined || y === undefined) {
    return res.status(400).json({ error: 'profileId, x, and y required' });
  }
  try {
    const result = await getShipsForFleet(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH, profileId, parseInt(x), parseInt(y));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: 06 - Fleet Transactions
app.post('/api/transactions', async (req, res) => {
  const { accountPubkey, limit } = req.body;
  if (!accountPubkey) {
    return res.status(400).json({ error: 'accountPubkey required' });
  }
  try {
    const result = await getFleetTransactions(RPC_ENDPOINT, RPC_WEBSOCKET, accountPubkey, limit || 50);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: 07 - Wallet SAGE Transactions & Fees
app.post('/api/wallet-sage-fees', async (req, res) => {
  const { walletPubkey, limit } = req.body;
  if (!walletPubkey) {
    return res.status(400).json({ error: 'walletPubkey required' });
  }
  try {
    const result = await getWalletSageTransactions(RPC_ENDPOINT, RPC_WEBSOCKET, walletPubkey, limit || 100);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming detailed 24h SAGE fees with progressive updates
app.post('/api/wallet-sage-fees-stream', async (req, res) => {
  const { walletPubkey, fleetAccounts, fleetNames, fleetRentalStatus, hours } = req.body;
  console.log(`[api/wallet-sage-fees-stream] Received request at ${new Date().toISOString()} with walletPubkey=${walletPubkey ? walletPubkey.substring(0,8) : 'undefined'}`);
  if (!walletPubkey) {
    return res.status(400).json({ error: 'walletPubkey required' });
  }
  
  // Check for cached results first
  const refresh = (req.query.refresh === 'true') || (req.body && req.body.refresh === true);
  const update = (req.query.update === 'true') || (req.body && req.body.update === true);
  const keyPayload = JSON.stringify({ a: fleetAccounts || [], n: fleetNames || {}, r: fleetRentalStatus || {}, h: hours || 24 });
  const cacheKey = `${walletPubkey}__${keyPayload}`;
  
  // Helper to get cache hash for debugging
  const cacheHash = crypto.createHash('sha256').update(cacheKey).digest('hex');
  console.log(`[stream] Cache key hash: ${cacheHash.substring(0, 16)}...`);
  
  console.log(`[stream] Request for wallet ${walletPubkey.substring(0, 8)}... refresh=${refresh}, update=${update}`);
  
  // For update mode, retrieve cached data to use as base
  let cachedData = null;
  let lastProcessedSignature = null;
  if (update) {
    const cached = await getCacheWithTimestamp<any>('wallet-fees-detailed', cacheKey);
    if (cached) {
      const cacheAgeMs = Date.now() - cached.savedAt;
      const { getWalletSageFeesDetailedStreaming } = await import('./examples/wallet-sage-fees-streaming.js');
      const sixHoursMs = 6 * 60 * 60 * 1000;
      if (cacheAgeMs < sixHoursMs) {
        console.log(`[stream] Update mode: cache is fresh (${(cacheAgeMs / 60000).toFixed(1)}min), will fetch only new transactions`);
        cachedData = cached.data;
        // Extract the most recent signature from cached transactions
        if (cachedData.allTransactions && cachedData.allTransactions.length > 0) {
          lastProcessedSignature = cachedData.allTransactions[0].signature;
          console.log(`[stream] Last processed signature: ${lastProcessedSignature.substring(0, 8)}...`);
        } else {
          console.log('[stream] Legacy cache detected (missing allTransactions). Performing full fetch this time to upgrade format.');
        }
      } else {
        console.log(`[stream] Update mode: cache too old (${(cacheAgeMs / 3600000).toFixed(1)}h), doing full refresh`);
        // Fall through to full refresh
      }
    } else {
      console.log(`[stream] Update mode: no cache found, doing full fetch`);
    }
  }
  
  if (!refresh && !update) {
    const cached = await getCacheWithTimestamp<any>('wallet-fees-detailed', cacheKey);
    if (cached) {
      const cacheAgeMs = Date.now() - cached.savedAt;
      const cacheAgeMin = (cacheAgeMs / 60000).toFixed(1);
      console.log(`[stream] ✅ Cache HIT! Age: ${cacheAgeMin} minutes`);
      
      // Return cached data via SSE format (single complete message)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Cache-Hit', 'disk');
      res.setHeader('X-Cache-Timestamp', String(cached.savedAt));
      res.flushHeaders();
      
      res.write(`data: ${JSON.stringify({ type: 'complete', ...cached.data, fromCache: true })}\n\n`);
      res.end();
      return;
    } else {
      console.log(`[stream] ❌ Cache MISS - processing fresh data`);
    }
  } else if (refresh) {
    console.log(`[stream] Refresh requested - bypassing cache`);
  }
  
  // Set up SSE headers for fresh data
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  const sendUpdate = (data: any) => {
    try {
      nlog(`[stream] -> sendUpdate type=${data.type || 'unknown'} stage=${data.stage || ''} processed=${data.processed || ''}`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.error('[stream] Failed to write SSE chunk', e);
    }
    // Force flush to ensure message is sent immediately
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };
  
  // Incremental cache callback - saves progress after each batch
  const saveProgress = async (partialResult: any) => {
    try {
      await setCache('wallet-fees-detailed', cacheKey, partialResult);
      nlog(`[stream] 📦 Incremental cache saved (${partialResult.transactionCount24h || 0} tx processed)`);
    } catch (err) {
      console.error('[stream] Failed to save incremental cache:', err);
    }
  };
  
  try {
    const { getWalletSageFeesDetailedStreaming } = await import('./examples/wallet-sage-fees-streaming.js');
    
    const finalResult = await getWalletSageFeesDetailedStreaming(
      RPC_ENDPOINT,
      RPC_WEBSOCKET,
      walletPubkey,
      fleetAccounts || [],
      fleetNames || {},
      fleetRentalStatus || {},
      hours || 24,
      sendUpdate,
      saveProgress,
      cachedData,
      lastProcessedSignature
    );
    
    // Save to cache
    console.log(`[stream] 💾 Saving to cache for wallet ${walletPubkey.substring(0, 8)}...`);
    await setCache('wallet-fees-detailed', cacheKey, finalResult);
    console.log(`[stream] ✅ Cache saved successfully`);
    
    // Small delay to ensure final message is received before closing
    await new Promise(resolve => setTimeout(resolve, 100));
    res.end();
  } catch (err: any) {
    console.error('❌ /api/wallet-sage-fees-stream error:', err.message);
    sendUpdate({ error: err.message });
    res.end();
  }
});

// Cache wipe endpoint
app.post('/api/cache/wipe', async (req, res) => {
  const { profileId } = req.body;
  if (!profileId) {
    return res.status(400).json({ error: 'profileId required' });
  }
  
  try {
    console.log(`[cache] Wiping cache for profile: ${profileId}`);
    // TODO: Implement cache deletion by profile pattern
    // For now, just acknowledge - cache will be overwritten on next fetch
    res.json({ success: true, message: 'Cache wipe acknowledged' });
  } catch (err: any) {
    console.error('Cache wipe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Detailed 24h SAGE fees with fleet breakdown (legacy non-streaming)
app.post('/api/wallet-sage-fees-detailed', async (req, res) => {
  const { walletPubkey, fleetAccounts, fleetNames, fleetRentalStatus, hours } = req.body;
  if (!walletPubkey) {
    return res.status(400).json({ error: 'walletPubkey required' });
  }
  try {
    const refresh = (req.query.refresh === 'true') || (req.body && req.body.refresh === true);
    const keyPayload = JSON.stringify({ a: fleetAccounts || [], n: fleetNames || {}, r: fleetRentalStatus || {}, h: hours || 24 });
    // Use persist cache keyed by wallet + request fingerprint
    const cacheKey = `${walletPubkey}__${keyPayload}`;
    if (!refresh) {
      const cached = await getCacheWithTimestamp<any>('wallet-fees-detailed', cacheKey);
      if (cached) {
        res.setHeader('X-Cache-Hit', 'disk');
        res.setHeader('X-Cache-Timestamp', String(cached.savedAt));
        return res.json(cached.data);
      }
    }

    const result = await getWalletSageFeesDetailed(
      RPC_ENDPOINT,
      RPC_WEBSOCKET,
      walletPubkey,
      fleetAccounts || [],
      fleetNames || {},  // This maps to fleetAccountNames parameter
      fleetRentalStatus || {},  // Pass rental status
      hours || 24,
      { refresh },
      globalPoolConnection  // Pass the shared pool connection
    );
    await setCache('wallet-fees-detailed', cacheKey, result);
    res.json(result);
  } catch (err: any) {
    console.error('❌ /api/wallet-sage-fees-detailed error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: err.message, details: err.stack });
  }
});

// Diagnostics: Fleet account/name/rental map for a profile
app.post('/api/diagnostics/fleet-map', async (req, res) => {
  const { profileId } = req.body;
  if (!profileId) {
    return res.status(400).json({ error: 'profileId required' });
  }

  
  try {
    const { fleets, walletAuthority } = await getFleets(RPC_ENDPOINT, RPC_WEBSOCKET, WALLET_PATH, profileId);
    const map: { [account: string]: { name: string; isRented: boolean } } = {};
    const rows = fleets.map((f: any) => {
      const name = f.callsign;
      const isRented = !!f.isRented;
      const accounts = [
        f.key,
        f.data?.fleetShips,
        f.data?.fuelTank,
        f.data?.ammoBank,
        f.data?.cargoHold,
      ].filter((x: string | undefined) => !!x);
      accounts.forEach((acc: string) => { map[acc] = { name, isRented }; });
      return {
        name,
        key: f.key,
        fleetShips: f.data?.fleetShips,
        fuelTank: f.data?.fuelTank,
        ammoBank: f.data?.ammoBank,
        cargoHold: f.data?.cargoHold,
        owningProfile: f.data?.owningProfile?.toString?.() || null,
        subProfile: f.data?.subProfile?.toString?.() || null,
        isRented,
      };
    });
    res.json({ success: true, walletAuthority, rows, map });
  } catch (err: any) {
    console.error('❌ /api/diagnostics/fleet-map error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// CoinGecko prices proxy
app.get('/api/prices', async (req, res) => {
  try {
    const cgRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,solana,star-atlas,star-atlas-dao&vs_currencies=usd');
    const prices = cgRes.ok ? await cgRes.json() : {};
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// WPAC price and icon proxy
app.get('/api/wpac', async (req, res) => {
  try {
    const boomRes = await fetch('https://coinboom.net/coin/pactus');
    if (!boomRes.ok) return res.status(502).json({ error: 'Failed to fetch WPAC from coinboom.net' });
    const boomText = await boomRes.text();
    // Extract price using regex
    const iconMatch = boomText.match(/(https:\/\/storage\.coinboom\.net\/images\/[a-zA-Z0-9\-]+\.webp)/);
    // Use DOM-like regex to extract the price from the div with 'Wrapped PAC Price USD' and the next div with the price
    let wpacPrice = null;
    const priceDivMatch = boomText.match(/<span[^>]*>Wrapped PAC Price USD<\/span><div[^>]*style="font-weight: 600;">\$([0-9]+\.[0-9]+)/);
    if (priceDivMatch) {
      wpacPrice = parseFloat(priceDivMatch[1]);
    }
    const wpacIcon = iconMatch ? iconMatch[1] : null;
    res.json({ price: wpacPrice, icon: wpacIcon });
  } catch (err) {
    res.status(500).json({ error: 'WPAC fetch error', details: err instanceof Error ? err.message : String(err) });
  }
});

// API: Decodifica dettagli transazione Solana (SAGE crafting, human-friendly)
app.get('/api/tx-details/:txid', async (req, res) => {
    const txid = req.params.txid;
    try {
      // Use RPC pool with round-robin, health checks, and rate limiting
      let tx: any = null;
      let rpcIndex = -1;
      let attempts = 0;
      const maxAttempts = 5;
      let pick: { connection: Connection | null; index: number; url?: string } | null = null;
      
      while (!tx && attempts < maxAttempts) {
        attempts++;
        pick = pickNextRpcConnection();
        
        if (!pick || !pick.connection || pick.index < 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        rpcIndex = pick.index;
        if (!tryAcquireRpc(rpcIndex)) {
          continue;
        }
        
        const rpcStartTime = Date.now();
        
        try {
          const txPromise = pick.connection.getParsedTransaction(txid, { 
            commitment: 'confirmed', 
            maxSupportedTransactionVersion: 0 
          });
          
          const timeoutPromise = new Promise<null>((resolve) => 
            setTimeout(() => resolve(null), 8000)
          );
          
          tx = await Promise.race([txPromise, timeoutPromise]);
          const latency = Date.now() - rpcStartTime;
          
          if (tx === null) {
            releaseRpc(rpcIndex, { success: false, errorType: 'timeout', latencyMs: latency });
            markRpcFailure(rpcIndex, new Error('timeout'));
            continue;
          }
          
          releaseRpc(rpcIndex, { success: true, latencyMs: latency });
          markRpcSuccess(rpcIndex);
          break;
          
        } catch (err: any) {
          const latency = Date.now() - rpcStartTime;
          const errorType = err?.message?.includes('429') ? '429' : 
                           err?.message?.includes('402') ? '402' :
                           err?.message?.includes('timeout') ? 'timeout' : 'other';
          
          releaseRpc(rpcIndex, { success: false, errorType, latencyMs: latency });
          markRpcFailure(rpcIndex, err);
          
          if (errorType === '429') {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      }
      
      if (!tx) {
        // Final fallback: try default RPC endpoint directly with a longer timeout
        try {
          const defaultConn = new Connection(RPC_ENDPOINT);
          const txPromise = defaultConn.getParsedTransaction(txid, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000));
          tx = await Promise.race([txPromise, timeoutPromise]);
        } catch {}
        if (!tx) {
          return res.status(404).json({ error: 'Transaction not found or all RPCs unavailable' });
        }
      }
      
      const connection = pick?.connection || new Connection(RPC_ENDPOINT);
      const MATERIALS: Record<string, string> = {
        'RfZkpkTYoud6ewWbTrKjQEtRQEJ1n4WkWdIofxRMUjAQ': 'Hydrogen',
        'HYDR4EPHJcDPcaLYUcNCtrXUdt1PnaN4MvE655pevBYp': 'Hydrogen', // Recipe item variant
        'Fsox7imqcJo2ZrARpTfq4ZHsPQ1peVnvaPwtVB4hokHo': 'Carbon',
        '4FVBwPR1GuuhXwPaFWGQwm1osYQVnvKUu76jcFbGwCoC': 'Copper',
        '6aeaH8q7unhosrg3rn3eqi3pUz1DxDyU2aQvGPF2s6dg': 'Iron',
        '2cKBVnG5xh4jS4Vo7713RhrejrKbLK7L3e8DePAd4nw9': 'Nickel',
        'BWm75a4GoJfBS2NvNV8e8LprdUEDh94AMB9xkpopJECC': 'Silicon',
        '5CifeGtRNtAw5GDW7TSJZsGhEbmJxaAHf5KcqEA1DF3r': 'Gold',
        'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr': 'Platinum',
        'AjVrjRvmz3bquxntsBkM7GLZrCPutrtfLYXT4Lxn7MAE': 'Titanium',
        'MASS9GqtJz6ABisAxcUn3FeR4phMqH1XfG6LPKJePog': 'Biomass',
        'foodQJAztMzX1DKpLaiounNe2BDMds5RNuPC6jsNrDG': 'Food',
        'fueL3hBZjLLLJHiFH9cqZoozTG3XQZ53diwFPwbzNim': 'Fuel', // Recipe item variant (Hydrogen)
        'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5': 'CraftingProgram',
        'Cargo2VNTPPTi9c1vq1Jw5d3BWUNr18MjRtSupAghKEk': 'CargoProgram',
        // aggiungi altri materiali se necessario
      };
      // Importo i decoder
      // Importo tutti i decoder disponibili
      const decoders: Record<string, (data: Buffer | Uint8Array) => any | null> = {};
      try {
        const crafting = await import('./decoders/crafting-decoder.js');
        decoders['recipe'] = crafting.decodeRecipe;
        decoders['process'] = crafting.decodeCraftingProcess;
        decoders['item'] = crafting.decodeCraftableItem;
      } catch {}
      try {
        const rust = await import('./decoders/rust-wrapper.js');
        decoders['rust'] = rust.decodeAccountWithRust;
      } catch {}
      let actions: any[] = [];
      const instructions = tx.transaction.message.instructions as any[];
      const logMessages = tx.meta?.logMessages || [];
      
      // Parse log messages to extract instruction type and details
      let instructionType: string | null = null;
      let moveDetails: any = null;
      try {
        for (const log of logMessages) {
          // Extract instruction type: "Program log: Instruction: FleetStateHandler"
          const instrMatch = log.match(/Program log: Instruction: (\w+)/);
          if (instrMatch) {
            instructionType = instrMatch[1];
          }
          // Extract MoveSubwarp details with coordinates and fuel
          const subwarpMatch = log.match(/Current state: MoveSubwarp\(MoveSubwarp \{ from_sector: \[([^\]]+)\], to_sector: \[([^\]]+)\], current_sector: \[([^\]]+)\], departure_time: (\d+), arrival_time: (\d+), fuel_expenditure: (\d+)/);
          if (subwarpMatch) {
            moveDetails = {
              type: 'MoveSubwarp',
              from_sector: subwarpMatch[1],
              to_sector: subwarpMatch[2],
              current_sector: subwarpMatch[3],
              departure_time: parseInt(subwarpMatch[4]),
              arrival_time: parseInt(subwarpMatch[5]),
              fuel_expenditure: parseInt(subwarpMatch[6])
            };
          }
        }
      } catch (e) {
        console.warn('[tx-details] Failed to parse log messages:', e);
      }

      // Extract fleet account and name from transaction
      const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
      let fleetAccount: string | null = null;
      let fleetName: string | null = null;
      try {
        const accountKeys = (tx.transaction.message as any).accountKeys || [];
        for (const key of accountKeys) {
          const pubkeyStr = typeof key === 'string' ? key : (key.pubkey?.toString?.() || key.toString?.());
          if (!pubkeyStr) continue;
          
          // Skip known non-fleet accounts
          if (pubkeyStr === SAGE_PROGRAM_ID) continue;
          if (pubkeyStr === 'ComputeBudget111111111111111111111111111111') continue;
          if (pubkeyStr === '11111111111111111111111111111111') continue;
          
          try {
            const accountInfo = await connection.getAccountInfo(new PublicKey(pubkeyStr));
            if (!accountInfo) continue;
            
            // Fleet accounts are 536 bytes and owned by SAGE program
            if (accountInfo.data.length === 536 && accountInfo.owner.toString() === SAGE_PROGRAM_ID) {
              fleetAccount = pubkeyStr;
              
              // Extract fleetLabel from correct offset:
              // Discriminator(8) + version(1) + game_id(32) + owner_profile(32) + 
              // fleet_ships(32) + sub_profile(33) + sub_profile_invalidator(32) + faction(1) = 170
              // fleet_label is at bytes 170-201 (32 bytes)
              const labelBytes = accountInfo.data.slice(170, 202);
              // Convert to string and trim null bytes
              const label = Buffer.from(labelBytes).toString('utf8').replace(/\0/g, '').trim();
              if (label) {
                fleetName = label;
              }
              break;
            }
          } catch (e) {
            // Skip invalid accounts
          }
        }
      } catch (e) {
        console.warn('[tx-details] Failed to extract fleet account:', e);
      }
      
      // Only print verbose transaction debug when explicitly enabled to avoid flooding logs
      if (process.env.DEBUG_TX === '1') {
        console.log('--- DEBUG TRANSACTION ---');
        console.log('TXID:', txid);
        console.log('Instructions:', JSON.stringify(instructions, null, 2));
        console.log('LogMessages:', JSON.stringify(logMessages, null, 2));
      }

      // Helper to convert byte array mint to base58 pubkey
      function bytesToBase58(bytes: number[] | Uint8Array): string {
        try {
          const pk = new PublicKey(bytes);
          const base58 = pk.toBase58();
          return base58;
        } catch (e: any) {
          console.warn('[bytesToBase58] Failed to convert bytes to base58:', e?.message || e);
          return '';
        }
      }

      // Helper per scaricare e decodificare account
      async function decodeAccount(pubkey: string) {
        try {
          const { PublicKey } = await import('@solana/web3.js');
          
          let acc: any = null;
          let attempts = 0;
          const maxAttempts = 3;
          
          const withTimeout = async <T>(p: Promise<T>, ms = 6000): Promise<T | null> => {
            const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
            const result = await Promise.race([p, timeoutPromise]);
            return result as T | null;
          };
          
          while (!acc && attempts < maxAttempts) {
            attempts++;
            
            try {
              const pick = pickNextRpcConnection();
              if (pick && pick.connection && pick.index >= 0 && tryAcquireRpc(pick.index)) {
                const start = Date.now();
                
                try {
                  acc = await withTimeout(pick.connection.getAccountInfo(new PublicKey(pubkey)), 6000);
                  const latency = Date.now() - start;
                  
                  if (acc) {
                    releaseRpc(pick.index, { success: true, latencyMs: latency });
                    markRpcSuccess(pick.index);
                    break;
                  } else {
                    releaseRpc(pick.index, { success: false, errorType: 'timeout', latencyMs: latency });
                    markRpcFailure(pick.index, new Error('rpc-timeout'));
                  }
                } catch (e: any) {
                  const latency = Date.now() - start;
                  const errorType = e?.message?.includes('429') ? '429' : 
                                   e?.message?.includes('402') ? '402' : 'other';
                  releaseRpc(pick.index, { success: false, errorType, latencyMs: latency });
                  markRpcFailure(pick.index, e);
                  
                  if (errorType === '429') {
                    await new Promise(resolve => setTimeout(resolve, 1500));
                  }
                }
              } else {
                await new Promise(resolve => setTimeout(resolve, 300));
              }
            } catch (e) {
              // silent fallback
            }
          }
          
          // Fallback to connection from successful tx fetch if pool failed
          if (!acc && connection) {
            try {
              acc = await withTimeout(connection.getAccountInfo(new PublicKey(pubkey)), 6000);
            } catch (e) {
              // silent
            }
          }
          if (!acc || !acc.data) {
            //console.log(`[decodeAccount] No data for account: ${pubkey}`);
            return null;
          }
          // Prefer non-rust decoders first but always run the Rust decoder to collect its raw output
          let primaryResult: any = null;
          const rustDecoder = (decoders as any)['rust'];
          for (const [name, decoder] of Object.entries(decoders)) {
            if (name === 'rust') continue; // skip rust in the primary loop
            try {
              const result = decoder(acc.data);
              if (result) {
                //console.log(`[decodeAccount] Decoded ${name} for account: ${pubkey}`);
                primaryResult = { type: name, ...result };
                break; // keep first non-rust match
              }
            } catch (e) {
              //console.log(`[decodeAccount] Error in decoder ${name} for account ${pubkey}:`, e);
            }
          }

          // Always attempt Rust decoder (if available) to capture its raw output for debugging
          let rustOut: any = null;
          if (typeof rustDecoder === 'function') {
            try {
              const r = rustDecoder(acc.data);
              if (r) rustOut = r;
            } catch (e) {
              //console.log(`[decodeAccount] Rust decoder error for account ${pubkey}:`, e);
            }
          }

          if (primaryResult) {
            // attach rust raw output if present
            if (rustOut) {
              try {
                if (rustOut.raw) primaryResult.rust_raw = rustOut.raw;
                else primaryResult.rust_raw = JSON.stringify(rustOut);
              } catch (e) {
                primaryResult.rust_raw = String(rustOut);
              }
            }
            return primaryResult;
          }

          // No primary decoder matched — if rust produced something, return that
          if (rustOut) {
            try {
              return { type: 'rust', rust: rustOut };
            } catch (e) {
              return { type: 'rust', rust_raw: String(rustOut) };
            }
          }

          //console.log(`[decodeAccount] No decoder match for account: ${pubkey}`);
          return null;
        } catch (e) {
          //console.log(`[decodeAccount] Error decoding account ${pubkey}:`, e);
          return null;
        }
      }

      // Build a list of all account pubkeys mentioned in the transaction message
      const messageAccountKeys: string[] = [];
      try {
        const msgKeys = (tx.transaction.message as any).accountKeys || (tx.transaction.message as any).accountKeys;
        if (Array.isArray(msgKeys)) {
          for (const k of msgKeys) {
            if (!k) continue;
            if (typeof k === 'string') messageAccountKeys.push(k);
            else if (k.pubkey) messageAccountKeys.push(k.pubkey.toString());
            else if (k.toString) messageAccountKeys.push(k.toString());
          }
        }
      } catch (e) {
        // ignore
      }

      // Cache for decoded accounts to avoid repeated getAccountInfo calls
      const decodedAccountCache: Record<string, any> = {};

      for (const ix of instructions) {
        ////console.log(`[tx-details] Instruction:`, JSON.stringify(ix));
        // SAGE2HA... = SAGE crafting
        if (ix.programId?.toString() === 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE') {
          let decodedAccounts: any[] = [];
          let qty: number | null = null;
          let material: string | null = null;
          let materialMint: string | null = null;
          const candidates: string[] = [];
          if (ix.accounts && Array.isArray(ix.accounts)) {
            for (const acc of ix.accounts) {
              const pubkey = typeof acc === 'string' ? acc : acc.pubkey?.toString?.() || acc?.toString?.();
              if (pubkey) candidates.push(pubkey);
            }
          }
          for (const k of messageAccountKeys) {
            if (!candidates.includes(k)) candidates.push(k);
          }
          const MAX_CANDIDATES = 24;
          if (candidates.length > MAX_CANDIDATES) candidates.splice(MAX_CANDIDATES);

          for (const pubkey of candidates) {
            try {
              if (decodedAccountCache[pubkey]) {
                decodedAccounts.push({ pubkey, ...decodedAccountCache[pubkey] });
                continue;
              }
              const decoded = await decodeAccount(pubkey);
              if (decoded) {
                function findBigIntQuantity(obj: any, depth = 0): bigint | null {
                  if (!obj || depth > 6) return null;
                  try {
                    if (typeof obj === 'bigint') return obj;
                    if (typeof obj === 'number' && Number.isFinite(obj)) {
                      try { return BigInt(String(Math.trunc(obj))); } catch (e) {}
                    }
                    if (typeof obj === 'string') {
                      const m = obj.match(/^\s*([0-9]+)\s*$/);
                      if (m) return BigInt(m[1]);
                    }
                  } catch (e) {}
                  if (Array.isArray(obj)) {
                    for (const it of obj) {
                      const r = findBigIntQuantity(it, depth+1);
                      if (r) return r;
                    }
                  }
                  if (typeof obj === 'object') {
                    const keys = Object.keys(obj);
                    const prefer = ['quantity','amount','qty','outputs','output','count','num','tokenAmount','uiTokenAmount'];
                    for (const k of prefer) {
                      if (k in obj) {
                        const val = obj[k];
                        if (val && typeof val === 'object' && (val.amount || val.uiTokenAmount || val.tokenAmount)) {
                          const candidate = val.amount || (val.tokenAmount && val.tokenAmount.amount) || (val.uiTokenAmount && val.uiTokenAmount.amount);
                          if (candidate != null) {
                            try { return BigInt(String(candidate)); } catch (e) {}
                          }
                        }
                        try {
                          if (val != null) {
                            const r = findBigIntQuantity(val, depth+1);
                            if (r) return r;
                          }
                        } catch (e) {}
                      }
                    }
                    for (const k of keys) {
                      try {
                        const r = findBigIntQuantity(obj[k], depth+1);
                        if (r) return r;
                      } catch (e) {}
                    }
                  }
                  return null;
                }

                const normalizedDecoded = { ...decoded };
                // IMPORTANT: Only extract quantity from CraftingProcess accounts, NOT from Recipe or Item accounts
                // Recipe accounts have different field semantics (value, usage_count, etc.) that shouldn't be 
                // interpreted as crafting operation quantity
                let qBig: bigint | null = null;
                const decodedType = decoded?.type || decoded?.kind || '';
                const isProcessAccount = decodedType.toLowerCase().includes('process') || 
                                         (decoded && decoded.crafting_id != null && decoded.authority != null);
                const isRecipeOrItem = decodedType.toLowerCase().includes('recipe') || 
                                       decodedType.toLowerCase().includes('item') ||
                                       decodedType.toLowerCase().includes('domain');
                
                // ALWAYS remove quantity/quantity_bigint from Recipe, Item, and Domain accounts
                if (isRecipeOrItem && !isProcessAccount) {
                  delete normalizedDecoded.quantity;
                  delete normalizedDecoded.quantity_bigint;
                }
                
                if (isProcessAccount && !isRecipeOrItem) {
                  try {
                    // For process accounts, look for the quantity field specifically
                    qBig = decoded.quantity != null ? BigInt(String(decoded.quantity)) :
                           decoded.data?.Process?.quantity != null ? BigInt(String(decoded.data.Process.quantity)) :
                           decoded.value?.quantity != null ? BigInt(String(decoded.value.quantity)) :
                           null;
                  } catch (e) { qBig = null; }
                  if (qBig) {
                    const qStr = qBig.toString();
                    normalizedDecoded.quantity = qStr;
                    normalizedDecoded.quantity_bigint = qBig;
                  }
                }
                decodedAccountCache[pubkey] = normalizedDecoded;
                decodedAccounts.push({ pubkey, ...normalizedDecoded });
              }
            } catch (e) {}
          }
          // Collect all candidate burned materials from token balance diffs
          let burnedMaterials: any[] = [];
          try {
            const preBalances = tx.meta?.preTokenBalances || [];
            const postBalances = tx.meta?.postTokenBalances || [];
            const preMap: Record<string, any> = {};
            for (const p of preBalances) {
              if (!p) continue;
              const key = `${p.owner || ''}:${p.mint || ''}`;
              preMap[key] = p;
            }
            for (const p of postBalances) {
              if (!p || !p.mint) continue;
              if (!MATERIALS[p.mint]) continue;
              const materialName = MATERIALS[p.mint];
              const key = `${p.owner || ''}:${p.mint}`;
              const pre = preMap[key];
              const preAmt = pre?.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
              const postAmt = p.uiTokenAmount?.amount ? BigInt(p.uiTokenAmount.amount) : 0n;
              const delta = postAmt - preAmt;
              // Burned materials should reflect a decrease in balance
              if (delta < 0n) {
                // Food/Fuel are outputs, not burned inputs
                if (materialName === 'Food' || materialName === 'Fuel') continue;
                burnedMaterials.push({
                  mint: p.mint,
                  material: materialName,
                  amount: (-delta).toString(),
                  owner: p.owner,
                  source: 'balance-diff',
                  preAmt: preAmt.toString(),
                  postAmt: postAmt.toString()
                });
              }
            }
          } catch (e) {}
          // Collect all candidate claimed items (outputs) from token balance diffs
          let claimedItems: any[] = [];
          try {
            const preBalances = tx.meta?.preTokenBalances || [];
            const postBalances = tx.meta?.postTokenBalances || [];
            const preMap: Record<string, any> = {};
            for (const p of preBalances) {
              if (!p) continue;
              const key = `${p.owner || ''}:${p.mint || ''}`;
              preMap[key] = p;
            }
            for (const p of postBalances) {
              if (!p || !p.mint) continue;
              if (!MATERIALS[p.mint]) continue;
              const key = `${p.owner || ''}:${p.mint}`;
              const pre = preMap[key];
              const preAmt = pre?.uiTokenAmount?.amount ? BigInt(pre.uiTokenAmount.amount) : 0n;
              const postAmt = p.uiTokenAmount?.amount ? BigInt(p.uiTokenAmount.amount) : 0n;
              const delta = postAmt - preAmt;
              // Claimed items should reflect an increase in balance
              if (delta > 0n) {
                claimedItems.push({
                  mint: p.mint,
                  material: MATERIALS[p.mint],
                  item: MATERIALS[p.mint],
                  amount: delta.toString(),
                  owner: p.owner,
                  source: 'balance-diff',
                  preAmt: preAmt.toString(),
                  postAmt: postAmt.toString()
                });
              }
            }
          } catch (e) {}
          
          // IMPORTANTE: Filtra i claimedItems che corrispondono a burnedMaterials
          // Se la stessa quantità di token è sia bruciata che "aumentata",
          // è solo un movimento di burning (da source wallet a crafting vault),
          // NON è un claim. Non va contato due volte.
          // Il claim reale avviene in una transazione separata ore dopo.
          try {
            const filteredClaimedItems: typeof claimedItems = [];
            for (const claimed of claimedItems) {
              // Controlla se esiste un burn della STESSA quantità dello STESSO token
              const correspondingBurn = burnedMaterials.find((burned) =>
                burned.mint === claimed.mint &&
                burned.amount === claimed.amount
              );
              // Includi come claimed SOLO se NON c'è un burn corrispondere
              // (Un burn corrispondere significa che è uno spostamento di burning, non un claim)
              if (!correspondingBurn) {
                filteredClaimedItems.push(claimed);
              }
            }
            claimedItems = filteredClaimedItems;
          } catch (e) {}
          
          // Also collect from inner instructions SPL token transfers
          try {
            const inners = tx.meta?.innerInstructions || [];
            for (const inner of inners || []) {
              const insts = inner.instructions || [];
              for (const inst of insts) {
                const parsed = (inst as any).parsed;
                const parsedInfo = parsed?.info || (inst as any).info || parsed;
                if (!parsedInfo) continue;
                const potentialAmount = parsedInfo.amount || (parsedInfo.tokenAmount && parsedInfo.tokenAmount.amount) || (parsedInfo.uiTokenAmount && parsedInfo.uiTokenAmount.amount);
                const potentialMint = parsedInfo.mint || parsedInfo.mintAddress || parsedInfo.tokenMint;
                if (potentialAmount && potentialMint && MATERIALS[potentialMint]) {
                  const a = BigInt(String(potentialAmount));
                  if (a > 0n) {
                    const materialName = MATERIALS[potentialMint];
                    const parsedType = typeof parsed?.type === 'string' ? parsed.type.toLowerCase() : '';
                    const isNonBurnable = materialName === 'Food' || materialName === 'Fuel';
                    const isBurnIx = parsedType.includes('burn');
                    const owner = parsedInfo.authority || parsedInfo.source || parsedInfo.owner;

                    if (isBurnIx && !isNonBurnable) {
                      burnedMaterials.push({
                        mint: potentialMint,
                        material: materialName,
                        amount: a.toString(),
                        owner: owner || undefined,
                        source: 'inner-instruction',
                        parsedInfo
                      });
                    } else {
                      claimedItems.push({
                        mint: potentialMint,
                        material: materialName,
                        item: materialName,
                        amount: a.toString(),
                        owner: owner || undefined,
                        source: 'inner-instruction',
                        parsedInfo
                      });
                    }
                  }
                }
              }
            }
          } catch (e) {}
          // Remove non-burnable outputs accidentally marked as burns
          burnedMaterials = burnedMaterials.filter(b => b.material !== 'Food' && b.material !== 'Fuel');
          // Fallback: extract materials from decoded recipe_items if no token transfers found
          if (burnedMaterials.length === 0) {
            try {
              for (const da of decodedAccounts) {
                if (!da || da.type !== 'recipe') continue;
                const recipeValue = da.value || (da.kind === 'Recipe' && da.value ? da.value : null);
                if (!recipeValue || !recipeValue.recipe_items) continue;
                for (const item of recipeValue.recipe_items) {
                  if (!item || !item.mint) continue;
                  const mintBase58 = bytesToBase58(item.mint);
                  if (mintBase58 && MATERIALS[mintBase58]) {
                    burnedMaterials.push({
                      mint: mintBase58,
                      material: MATERIALS[mintBase58],
                      amount: (item.amount || 0).toString(),
                      source: 'recipe-items'
                    });
                  }
                }
              }
            } catch (e) {
              console.warn('[tx-details] Failed to extract recipe_items:', e);
            }
          }
          // Compose recipe/process decoded
          const recipeDecoded = decodedAccounts.find(a => a.type === 'recipe');
          const processDecoded = decodedAccounts.find(a => a.type === 'process');
          // Derive a human-friendly recipe name from decoded recipe/item mints
          let recipeName: string | null = null;
          try {
            // Check if any decoded account references a known material mint (e.g., Food)
            const knownMint = decodedAccounts.find(a => a.mint && MATERIALS[a.mint]);
            if (knownMint) {
              recipeName = MATERIALS[knownMint.mint];
            } else if (recipeDecoded && recipeDecoded.value && Array.isArray(recipeDecoded.value.recipe_items)) {
              // Scan recipe_items for known material mints (convert byte arrays to base58)
              for (const it of recipeDecoded.value.recipe_items) {
                if (!it || !it.mint) continue;
                const mintBase58 = bytesToBase58(it.mint);
                if (mintBase58 && MATERIALS[mintBase58]) {
                  recipeName = MATERIALS[mintBase58];
                  break;
                }
              }
            }
            // Fallback: if burnedMaterials populated, use first material name
            if (!recipeName && burnedMaterials.length > 0) {
              recipeName = burnedMaterials[0].material;
            }
          } catch (e) {
            recipeName = null;
          }
          const craftingGroupKey = recipeDecoded?.pubkey || recipeName || materialMint || null;
          let actionQuantity: string | null = null;
          try {
            // For crafting operations with claimed items (outputs), use the claimed item amount
            // This represents what was produced, not what was consumed
            if (claimedItems && claimedItems.length > 0) {
              actionQuantity = claimedItems[0].amount;
            } else if (burnedMaterials && burnedMaterials.length > 0) {
              // If no claimed items, use burned materials amount (what was consumed)
              actionQuantity = burnedMaterials[0].amount;
            } else {
              // Fallback: search ONLY CraftingProcess accounts for quantity field
              // IMPORTANT: Do NOT use quantity from Recipe accounts - those have different semantics
              for (const da of decodedAccounts) {
                if (!da || da.type !== 'process') continue;
                // Look in the CraftingProcess decoded data
                if (da.quantity != null) { actionQuantity = String(da.quantity); break; }
                if (da.quantity_bigint != null) { actionQuantity = String(da.quantity_bigint); break; }
                // Check nested data structures
                const maybeQuantity = da.value?.quantity || da.data?.Process?.quantity || da.decoded?.quantity;
                if (maybeQuantity != null) { actionQuantity = String(maybeQuantity); break; }
              }
            }
          } catch (e) { actionQuantity = null; }
          const isClaimStage = (claimedItems && claimedItems.length > 0);
          const isBurnStage = (burnedMaterials && burnedMaterials.length > 0);
          const lowerInstr = (instructionType || '').toLowerCase();
          const logMsgsLower = (logMessages || []).map((l: string) => (l || '').toLowerCase());
          const hasClaimInstr = logMsgsLower.some((l: string) => l.includes('claimcraftingoutputs') || l.includes('claimrecipeoutput'));
          const hasBurnInstr = logMsgsLower.some((l: string) => l.includes('burncraftingconsumables') || l.includes('burnconsumableingredient'));
          let actionName: 'crafting_start' | 'crafting_claim';
          if (hasClaimInstr) {
            actionName = 'crafting_claim';
          } else if (hasBurnInstr) {
            actionName = 'crafting_start';
          } else if (lowerInstr.includes('claim') || lowerInstr.includes('complete')) {
            actionName = 'crafting_claim';
          } else if (lowerInstr.includes('start') || lowerInstr.includes('deposit')) {
            actionName = 'crafting_start';
          } else {
            actionName = isClaimStage ? 'crafting_claim' : 'crafting_start';
          }

          actions.push({
            action: actionName,
            material,
            materialMint,
            recipeName,
            craftingGroupKey,
            quantity: actionQuantity != null ? actionQuantity : qty,
            recipe: recipeDecoded || null,
            process: processDecoded || null,
            decodedAccounts,
            burnedMaterials,
            claimedItems,
            instructionType,
            moveDetails,
            fleetAccount,
            fleetName
          });
        }
        // CRAFT2RP... = Crafting program
        if (ix.programId?.toString() === 'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5') {
          let decodedAccounts: any[] = [];
          if (ix.accounts) {
            for (const acc of ix.accounts) {
              const pubkey = typeof acc === 'string' ? acc : acc.pubkey?.toString();
              if (pubkey) {
                const decoded = await decodeAccount(pubkey);
                if (decoded) decodedAccounts.push({ pubkey, ...decoded });
              }
            }
          }
          //console.log(`[tx-details] Crafting program decodedAccounts:`, decodedAccounts);
          actions.push({
            action: 'CRAFT2RP_crafting',
            decodedAccounts
          });
        }
      }

      // Build a frontend-friendly summary object so the UI can display details
      // The frontend expects fields like `material`, `quantity`, `recipe`, `process`, `details`.
      function summarizeDecoded(obj: any) {
        if (!obj) return null;
        if (typeof obj === 'string' || typeof obj === 'number') return String(obj);
        try {
          // Common property names used by decoders
          return obj.recipe_pubkey || obj.recipeId || obj.recipe || obj.mint || obj.id || obj.name || JSON.stringify(obj).slice(0, 160);
        } catch (e) {
          return String(obj);
        }
      }

      let decodedSummary: any = { txid };
      if (actions && actions.length > 0) {
        // Prefer SAGE2HA crafting actions, otherwise take the first available
        const sageAction = actions.find(a => a && a.action && a.action.toString && a.action.toString().toLowerCase().includes('sage')) || actions[0];
        
        // Safety check: if sageAction is null/undefined, create empty object
        if (!sageAction) {
          decodedSummary = { txid, material: null, quantity: null, recipe: null, process: null, details: null, actions };
          res.json(decodedSummary);
          return;
        }
        
        decodedSummary.material = sageAction.material || null;
        decodedSummary.materialMint = sageAction.materialMint || null;
        decodedSummary.recipeName = sageAction.recipeName || null;
        decodedSummary.instructionType = sageAction.instructionType || null;
        decodedSummary.moveDetails = sageAction.moveDetails || null;
        decodedSummary.fleetAccount = sageAction.fleetAccount || null;
        decodedSummary.fleetName = sageAction.fleetName || null;
        decodedSummary.claimedItems = sageAction.claimedItems || [];
        decodedSummary.burnedMaterials = sageAction.burnedMaterials || [];
        
        // Prefer an explicit normalized quantity from decodedAccounts (string or bigint),
        // which preserves large values returned by the Rust decoder.
        let explicitQty: string | null = null;
        try {
          if (sageAction.decodedAccounts && Array.isArray(sageAction.decodedAccounts)) {
            // IMPORTANT: For crafting operations, prefer quantity from CraftingProcess accounts
            // NEVER extract quantity from Recipe accounts - they have different field semantics
            let processAccounts = sageAction.decodedAccounts.filter((da: any) => 
              da && (da.type === 'process' || da.kind === 'Process' || da.crafting_id != null)
            );
            
            // Search Process accounts first
            for (const da of processAccounts) {
              if (!da) continue;
              if (da.quantity != null) {
                explicitQty = String(da.quantity);
                break;
              }
              if (da.quantity_bigint != null) {
                explicitQty = String(da.quantity_bigint);
                break;
              }
              // nested rust.decoded.quantity
              const nested = da.rust || da.decoded || null;
              if (nested && nested.quantity != null) { explicitQty = String(nested.quantity); break; }
            }
            
            // If still not found, search other account types (but NOT Recipe accounts)
            if (!explicitQty) {
              let otherAccounts = sageAction.decodedAccounts.filter((da: any) => 
                da && da.type !== 'recipe' && !da.kind?.includes?.('Recipe')
              );
              for (const da of otherAccounts) {
                if (!da) continue;
                if (da.quantity != null) {
                  explicitQty = String(da.quantity);
                  break;
                }
                if (da.quantity_bigint != null) {
                  explicitQty = String(da.quantity_bigint);
                  break;
                }
              }
            }
          }
        } catch (e) {
          explicitQty = null;
        }

        // Prefer the action-derived quantity (already based on claimed/burned materials)
        if (sageAction.quantity != null) {
          decodedSummary.quantity = String(sageAction.quantity);
        } else if (explicitQty) {
          // Fallback to explicitly extracted quantities when action quantity is missing
          decodedSummary.quantity = explicitQty;
        } else {
          decodedSummary.quantity = null;
        }
        // Ensure quantity is always represented as a string for the frontend
        try {
          if (decodedSummary.quantity != null) {
            decodedSummary.quantity = String(decodedSummary.quantity);
          }
        } catch (e) {
          // ignore formatting errors
        }
        // recipe / process may be objects — summarize to short strings
        decodedSummary.recipe = summarizeDecoded(sageAction.recipe) || null;
        decodedSummary.process = summarizeDecoded(sageAction.process) || null;
        // Compose a compact details string from decodedAccounts if present
        try {
          if (sageAction.decodedAccounts && Array.isArray(sageAction.decodedAccounts) && sageAction.decodedAccounts.length > 0) {
            const parts = sageAction.decodedAccounts.map((d: any) => {
              const t = d.type || d.decodedKind || '';
              const pk = d.pubkey || d.pubkey?.toString?.() || '';
              const summary = summarizeDecoded(d);
              return `${t}${pk ? ' ' + (pk.substring ? pk.substring(0,8) + '...' : pk) : ''}${summary ? ' ' + summary : ''}`.trim();
            });
            decodedSummary.details = parts.join(' | ');
          } else if (sageAction.decodedAccounts) {
            decodedSummary.details = summarizeDecoded(sageAction.decodedAccounts);
          } else {
            decodedSummary.details = null;
          }
        } catch (e) {
          decodedSummary.details = null;
        }
        // Also attach full actions array for debugging if needed
        decodedSummary.actions = actions;
        // Removed aggressive fallback that scraped quantity from serialized decodedAccounts; it caused inflated values
        // Include the message account keys for debugging (helps find missing recipe/process accounts)
        decodedSummary.messageAccountKeys = messageAccountKeys;
      } else {
        decodedSummary = { txid, material: null, quantity: null, recipe: null, process: null, details: null, actions };
      }

      // Convert BigInt to string before sending JSON response
      const sanitized = JSON.parse(JSON.stringify(decodedSummary, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      ));
      res.json(sanitized);
    } catch (err: any) {
      console.error('[api/tx-details] Error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to fetch transaction details' });
    }
});

// Helper function to convert BigInt to string in objects for JSON serialization
function replaceBigInt(key: string, value: any): any {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

// API: Decode SAGE/Crafting instruction using official decoders
app.get('/api/decode-instruction/:instruction', (_req, res) => {
  try {
    const instruction = _req.params.instruction;
    const decoded = decodeSageInstruction(instruction);
    
    if (!decoded) {
      return res.status(404).json({
        success: false,
        instruction,
        message: 'Unknown instruction',
        available_categories: Object.keys(SAGE_STARBASED_INSTRUCTIONS)
          .map((k: string) => SAGE_STARBASED_INSTRUCTIONS[k as keyof typeof SAGE_STARBASED_INSTRUCTIONS])
          .reduce((acc: any, curr: any) => {
            if (!acc[curr.category]) acc[curr.category] = [];
            acc[curr.category].push(curr.instructionType);
            return acc;
          }, {})
      });
    }
    
    res.json({
      success: true,
      instruction,
      decoded,
      description: (SAGE_STARBASED_INSTRUCTIONS[instruction as keyof typeof SAGE_STARBASED_INSTRUCTIONS] || 
                   CRAFTING_INSTRUCTIONS[instruction as keyof typeof CRAFTING_INSTRUCTIONS])?.description || 'No description'
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: List all supported instructions and categories
app.get('/api/decoders/info', (_req, res) => {
  try {
    const categories: Record<string, string[]> = {};
    
    for (const [name, details] of Object.entries(SAGE_STARBASED_INSTRUCTIONS)) {
      if (name === 'Unknown') continue;
      const cat = (details as any).category || 'unknown';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(name);
    }
    
    res.json({
      success: true,
      total_instructions: Object.keys(SAGE_STARBASED_INSTRUCTIONS).length - 1, // -1 for Unknown
      categories,
      source: 'Official Star Atlas Carbon Decoders',
      programs: {
        'SAGE-Starbased': 'SAGEQbkxz47ynfSeJ2cgvhy26yEQ6w57RPUAGuk76a1',
        'Crafting': 'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5'
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ SA Explorer running on http://localhost:${PORT}`);
  console.log(`   Access from network: http://staratlasexplorer.duckdns.org:${PORT}\n`);
});

// Debug: RPC metrics (top-level)
app.get('/api/rpc-metrics', (_req, res) => {
  try {
    const metrics = getRpcMetrics();
    res.json({ success: true, metrics });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Extract material/token actions for a list of transaction signatures
app.post('/api/extract-material-actions', async (req, res) => {
  const { signatures } = req.body;
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return res.status(400).json({ error: 'signatures (array) required' });
  }
  try {
    const { extractSageMaterialActions } = await import('./utils/extract-instructions.js');
    const { pickNextRpcConnection } = await import('./utils/rpc-pool.js');
    const actions = await extractSageMaterialActions(pickNextRpcConnection, signatures);
    res.json({ success: true, actions });
  } catch (err) {
    const errorMsg = (err && typeof err === 'object' && 'message' in err) ? (err as any).message : String(err);
    console.error('/api/extract-material-actions error:', errorMsg);
    res.status(500).json({ error: errorMsg });
  }
});