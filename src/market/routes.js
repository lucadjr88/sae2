import express from 'express';
import NodeCache from 'node-cache';
import { Connection, PublicKey } from '@solana/web3.js';
import { GmClientService, GmOrderbookService } from '@staratlas/factory';
// Program IDs
const GALACTIC_MARKETPLACE_PROGRAM_ID = 'traderDnaR5w6Tcoi3NFm53i48FTDNbGjBSZwWXDRrg';
const ATLAS_MINT = 'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx';
export function createMarketRouter(rpcEndpoint) {
    const router = express.Router();
    const cache = new NodeCache({ stdTTL: 60 });
    const connection = new Connection(rpcEndpoint, 'confirmed');
    const programId = new PublicKey(GALACTIC_MARKETPLACE_PROGRAM_ID);
    const gmClientService = new GmClientService();
    let gmOrderbookService = null;
    function initializeOrderbookService() {
        try {
            gmOrderbookService = new GmOrderbookService(connection, programId, 60);
            gmOrderbookService.initialize()
                .then(() => {
                console.log('✅ Market: GmOrderbookService initialized');
            })
                .catch((error) => {
                console.error('❌ Market: Error initializing GmOrderbookService:', error);
            });
        }
        catch (error) {
            console.error('❌ Market: Error constructing GmOrderbookService:', error);
        }
    }
    // Init in background, never await
    initializeOrderbookService();
    // GET /api/market/items - Galaxy NFTs
    router.get('/items', async (_req, res) => {
        try {
            const cached = cache.get('items');
            if (cached)
                return res.json(cached);
            const response = await fetch('https://galaxy.staratlas.com/nfts');
            const items = await response.json();
            cache.set('items', items);
            res.json(items);
        }
        catch (error) {
            console.error('Market /items error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero items' });
        }
    });
    // GET /api/market/currencies - Registered currencies
    router.get('/currencies', async (_req, res) => {
        try {
            const cached = cache.get('currencies');
            if (cached)
                return res.json(cached);
            const currencies = await gmClientService.getRegisteredCurrencies(connection, programId, false);
            cache.set('currencies', currencies);
            res.json(currencies);
        }
        catch (error) {
            console.error('Market /currencies error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero currencies' });
        }
    });
    // GET /api/market/orders - All open orders
    router.get('/orders', async (_req, res) => {
        try {
            const cached = cache.get('all_orders');
            if (cached)
                return res.json(cached);
            const orders = await gmClientService.getAllOpenOrders(connection, programId);
            cache.set('all_orders', orders);
            res.json(orders);
        }
        catch (error) {
            console.error('Market /orders error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero ordini' });
        }
    });
    // GET /api/market/orders/:mint - Orders for specific mint
    router.get('/orders/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const cacheKey = `orders_${mint}`;
            const cached = cache.get(cacheKey);
            if (cached)
                return res.json(cached);
            const orders = await gmClientService.getOpenOrdersForAsset(connection, new PublicKey(mint), programId);
            cache.set(cacheKey, orders);
            res.json(orders);
        }
        catch (error) {
            console.error('Market /orders/:mint error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero ordini per item' });
        }
    });
    // GET /api/market/orderbook/:mint - Orderbook for mint
    router.get('/orderbook/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const cacheKey = `orderbook_${mint}`;
            const cached = cache.get(cacheKey);
            if (cached)
                return res.json(cached);
            if (!gmOrderbookService) {
                return res.status(503).json({
                    error: 'GmOrderbookService non disponibile',
                    message: 'Usa /api/market/orders/:mint come alternativa'
                });
            }
            const buy = gmOrderbookService.getBuyOrdersByCurrencyAndItem(ATLAS_MINT, mint);
            const sell = gmOrderbookService.getSellOrdersByCurrencyAndItem(ATLAS_MINT, mint);
            const payload = { buy, sell };
            cache.set(cacheKey, payload);
            res.json(payload);
        }
        catch (error) {
            console.error('Market /orderbook/:mint error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero orderbook' });
        }
    });
    // GET /api/market/price/:mint - Best bid/ask + mid
    router.get('/price/:mint', async (req, res) => {
        try {
            const { mint } = req.params;
            const cacheKey = `price_${mint}`;
            const cached = cache.get(cacheKey);
            if (cached)
                return res.json(cached);
            const orders = await gmClientService.getOpenOrdersForAsset(connection, new PublicKey(mint), programId);
            const buyOrders = orders
                .filter((o) => o.orderType === 'buy')
                .sort((a, b) => b.uiPrice - a.uiPrice);
            const sellOrders = orders
                .filter((o) => o.orderType === 'sell')
                .sort((a, b) => a.uiPrice - b.uiPrice);
            const bestBid = buyOrders[0]?.uiPrice ?? null;
            const bestAsk = sellOrders[0]?.uiPrice ?? null;
            const priceData = {
                mint,
                bestBid,
                bestAsk,
                spread: bestBid && bestAsk ? bestAsk - bestBid : null,
                midPrice: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null,
                buyOrderCount: buyOrders.length,
                sellOrderCount: sellOrders.length,
                totalBuyVolume: buyOrders.reduce((sum, o) => sum + o.orderQtyRemaining, 0),
                totalSellVolume: sellOrders.reduce((sum, o) => sum + o.orderQtyRemaining, 0)
            };
            cache.set(cacheKey, priceData);
            res.json(priceData);
        }
        catch (error) {
            console.error('Market /price/:mint error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel calcolo prezzo' });
        }
    });
    // GET /api/market/market-summary - Aggregated stats
    router.get('/market-summary', async (_req, res) => {
        try {
            const cached = cache.get('market_summary');
            if (cached)
                return res.json(cached);
            const [orders, currencies] = await Promise.all([
                gmClientService.getAllOpenOrders(connection, programId),
                gmClientService.getRegisteredCurrencies(connection, programId, false)
            ]);
            const buyOrders = orders.filter((o) => o.orderType === 'buy');
            const sellOrders = orders.filter((o) => o.orderType === 'sell');
            const totalBuyVolume = buyOrders.reduce((sum, o) => sum + (o.uiPrice * o.orderQtyRemaining), 0);
            const totalSellVolume = sellOrders.reduce((sum, o) => sum + (o.uiPrice * o.orderQtyRemaining), 0);
            const summary = {
                timestamp: Date.now(),
                totalOrders: orders.length,
                buyOrders: buyOrders.length,
                sellOrders: sellOrders.length,
                totalBuyVolume,
                totalSellVolume,
                uniqueAssets: [...new Set(orders.map((o) => o.orderMint))].length,
                currencies: currencies.length
            };
            cache.set('market_summary', summary, 30);
            res.json(summary);
        }
        catch (error) {
            console.error('Market /market-summary error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel calcolo summary' });
        }
    });
    // GET /api/market/items-with-prices - Items enriched with market data
    router.get('/items-with-prices', async (_req, res) => {
        try {
            const cached = cache.get('items_with_prices');
            if (cached)
                return res.json(cached);
            const [itemsResponse, orders] = await Promise.all([
                fetch('https://galaxy.staratlas.com/nfts'),
                gmClientService.getAllOpenOrders(connection, programId)
            ]);
            const items = (await itemsResponse.json());
            const priceMap = {};
            orders.forEach((order) => {
                if (!priceMap[order.orderMint]) {
                    priceMap[order.orderMint] = { buyOrders: [], sellOrders: [] };
                }
                if (order.orderType === 'buy')
                    priceMap[order.orderMint].buyOrders.push(order);
                else
                    priceMap[order.orderMint].sellOrders.push(order);
            });
            const enrichedItems = items.map((item) => {
                const prices = priceMap[item.mint];
                if (!prices)
                    return { ...item, marketData: null };
                const buyOrders = prices.buyOrders.sort((a, b) => b.uiPrice - a.uiPrice);
                const sellOrders = prices.sellOrders.sort((a, b) => a.uiPrice - b.uiPrice);
                return {
                    ...item,
                    marketData: {
                        bestBid: buyOrders[0]?.uiPrice ?? null,
                        bestAsk: sellOrders[0]?.uiPrice ?? null,
                        midPrice: buyOrders[0] && sellOrders[0] ? (buyOrders[0].uiPrice + sellOrders[0].uiPrice) / 2 : null,
                        buyOrderCount: buyOrders.length,
                        sellOrderCount: sellOrders.length
                    }
                };
            });
            cache.set('items_with_prices', enrichedItems, 60);
            res.json(enrichedItems);
        }
        catch (error) {
            console.error('Market /items-with-prices error:', error?.message || error);
            res.status(500).json({ error: 'Errore nel recupero items con prezzi' });
        }
    });
    return router;
}
