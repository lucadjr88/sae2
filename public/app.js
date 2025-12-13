// Main application logic for SAGE Fleet Fees Analysis

// Global state
let currentProfileId = null;
let analysisStartTime = null;
let progressInterval = null;
let lastAnalysisParams = null; // Store last successful analysis parameters
const txDetailsCache = {}; // Global cache for transaction details

// Copy to clipboard helper with visual feedback
function copyToClipboard(text, event) {
  navigator.clipboard.writeText(text).then(() => {
    // Show tooltip feedback
    const btn = event.target.closest('[data-copy]');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied!';
      btn.style.color = '#10b981';
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = '';
      }, 1500);
    }
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Failed to copy to clipboard');
  });
  event.stopPropagation();
  event.preventDefault();
}

// Derive a product/recipe name for crafting without falling back to burned materials
function inferRecipeName(decoded, burns, claims) {
  // Prefer claimed items (produced outputs)
  try {
    const c = claims && claims.length ? claims[0] : null;
    const mat = c && (c.material || c.item);
    if (mat) return mat.toString();
  } catch {}
  // Then explicit recipeName provided by decoder
  try {
    if (decoded && decoded.recipeName) return decoded.recipeName.toString();
    const action0 = decoded && decoded.actions && decoded.actions[0];
    if (action0 && action0.recipeName) return action0.recipeName.toString();
    if (decoded && decoded.recipe) return decoded.recipe.toString();
  } catch {}
  // If nothing reliable, return null to avoid using burned material as name
  return null;
}

// Infer a human-friendly crafting material label from various fields
function inferMaterialLabel(entry, decoded) {
  const preferred = (entry && (entry.material || entry.recipe || entry.decodedMaterial)) || '';
  const norm = (preferred || '').toString().trim().toLowerCase();
  const candidates = new Set();
  if (norm) candidates.add(norm);
  // From decoded actions claimed items (what is produced) - prioritize over burned materials
  try {
        const claims = (decoded && (decoded.claimedItems || (decoded.actions && decoded.actions[0] && decoded.actions[0].claimedItems))) || [];
        claims.forEach(c => {
          const m = (c && (c.material || c.item)) ? (c.material || c.item).toString().toLowerCase() : '';
          if (m) candidates.add(m);
        });
      } catch {}
  
      // From decoded actions burned materials
      try {
    const burns = (decoded && (decoded.burnedMaterials || (decoded.actions && decoded.actions[0] && decoded.actions[0].burnedMaterials))) || [];
    burns.forEach(b => {
      const m = (b && b.material) ? b.material.toString().toLowerCase() : '';
      if (m) candidates.add(m);
    });
  } catch {}
  // From decoded recipe name
  try {
    const recipeName = decoded && (decoded.recipeName || decoded.material || decoded.recipe);
    if (recipeName) candidates.add(recipeName.toString().toLowerCase());
  } catch {}
  // Keyword mapping
  const map = [
    ['ammo', 'Ammo'],
    ['fuel', 'Fuel'],
    ['food', 'Food'],
    ['ore', 'Ore'],
    ['tool', 'Tool'],
    ['component', 'Component'],
    ['metal', 'Metal'],
    ['fiber', 'Fiber'],
    ['chemical', 'Chemical'],
    ['circuit', 'Circuit']
  ];
  for (const c of candidates) {
    for (const [k, v] of map) {
      if (c.includes(k)) return v;
    }
  }
  // Fallback: capitalize preferred if present
  if (preferred) return preferred.toString().charAt(0).toUpperCase() + preferred.toString().slice(1);
  return '';
}

// Map backend action/type into a friendly crafting stage label
function formatCraftingType(d) {
  // First check the action field from the backend (crafting_start/crafting_claim)
  const action = d && (d.action || d.type);
  if (action) {
    const al = action.toString().toLowerCase();
    if (al.includes('crafting_claim') || al.includes('claim')) return 'Claim Crafting';
    if (al.includes('crafting_start') || al.includes('start')) return 'Start Crafting';
  }
  
  // Fallback to type/decodedKind for older data or non-action fields
  const t = (d && (d.displayType || d.decodedKind || d.type)) || '';
  const tl = t.toString().toLowerCase();
  if (tl.includes('claim')) return 'Claim Crafting';
  if (tl.includes('burn') || tl.includes('consumable')) return 'Start Crafting';
  if (tl.includes('recipe')) return 'Crafting Recipe';
  if (tl.includes('process')) return 'Start Crafting';
  
  return action || t || 'Crafting';
}

// Helper to show/hide sidebar
function setSidebarVisible(visible) {
  const sidebar = document.getElementById('sidebar');
  const container = document.querySelector('.container');
  if (sidebar) {
    sidebar.style.display = visible ? 'flex' : 'none';
  }
  if (container) {
    if (visible) {
      container.classList.add('with-sidebar');
    } else {
      container.classList.remove('with-sidebar');
    }
  }
}

// Shared function to render crafting details rows
function renderCraftingDetailsRows(details, maxDetails = 50) {
  let html = '';
  details.slice(0, maxDetails).forEach(d => {
    let material = d.material || '';
    const feeSol = (Number(d.fee) / 1e9).toFixed(6);
    const feeUsd = window.prices && window.prices.solana ? ((Number(d.fee) / 1e9) * window.prices.solana.usd).toFixed(2) : '--';
    const txid = d.txid || d.signature || '';
    
    // If txid contains '+' it's a paired crafting operation - show both copy buttons
    let txLink = '';
    if (txid && txid.includes('+')) {
      const [tx1, tx2] = txid.split('+');
      txLink = `<span data-copy style="cursor:pointer;color:#60a5fa;text-decoration:underline;" onclick="copyToClipboard('${tx1}', event)" title="Click to copy Start tx">${tx1}...</span> + <span data-copy style="cursor:pointer;color:#60a5fa;text-decoration:underline;" onclick="copyToClipboard('${tx2}', event)" title="Click to copy Complete tx">${tx2.substring(0, 8)}...</span>`;
    } else if (txid) {
      txLink = `<span data-copy style="cursor:pointer;color:#60a5fa;text-decoration:underline;" onclick="copyToClipboard('${txid}', event)" title="Click to copy tx">${txid}...</span>`;
    }

    const detailsCellId = `details-cell-${txid}`;
    let detailsText = '';
    let decodedCached = null;
    try {
      const dd = d.decodedData || d.decodedRecipe || null;
      if (d.decodedKind && dd) {
        if (d.decodedKind === 'process') {
          const recipe = dd.recipe || dd.recipe_pubkey || dd.recipeId || '';
          const craftFac = dd.crafting_facility || dd.craftingFacility || '';
          const qty = dd.quantity != null ? `qty:${dd.quantity}` : '';
          detailsText = `process ${recipe ? '(' + (recipe.toString().substring ? recipe.toString().substring(0,8) + '...' : recipe) + ')' : ''} ${craftFac ? '@' + craftFac.toString().substring(0,8) + '...' : ''} ${qty}`.trim();
          decodedCached = { recipeName: recipe, craftingFacility: craftFac };
        } else if (d.decodedKind === 'recipe') {
          const cat = dd.category || dd.version || '';
          const items = dd.recipe_items ? (Array.isArray(dd.recipe_items) ? dd.recipe_items.map(i => i.mint ? (i.mint.substring ? i.mint.substring(0,8)+'...' : i.mint) : '').join(',') : '') : '';
          detailsText = `recipe ${cat ? '('+cat+')' : ''} ${items ? ':'+items : ''}`.trim();
          decodedCached = { recipeName: dd.recipeName || cat };
        } else if (d.decodedKind === 'item') {
          const mint = dd.mint || dd.item_mint || '';
          detailsText = `item ${mint ? '(' + (mint.toString().substring ? mint.toString().substring(0,8) + '...' : mint) + ')' : ''}`;
          decodedCached = { itemMint: mint };
        } else {
          const burns = (dd && (dd.burnedMaterials || (dd.actions && dd.actions[0] && dd.actions[0].burnedMaterials))) || [];
          const claims = (dd && (dd.claimedItems || (dd.actions && dd.actions[0] && dd.actions[0].claimedItems))) || [];
          const prod = inferRecipeName(dd, burns, claims);
          const prodLabel = prod || inferMaterialLabel({ material: '' }, dd) || '';
          detailsText = prodLabel ? prodLabel : '';
          if (!detailsText) {
            try { detailsText = JSON.stringify(dd).slice(0, 160); } catch (e) { detailsText = String(dd).substring(0,160); }
          }
          decodedCached = dd;
        }
      } else if (dd) {
        const burns = (dd && (dd.burnedMaterials || (dd.actions && dd.actions[0] && dd.actions[0].burnedMaterials))) || [];
        const claims = (dd && (dd.claimedItems || (dd.actions && dd.actions[0] && dd.actions[0].claimedItems))) || [];
        const prod = inferRecipeName(dd, burns, claims);
        const prodLabel = prod || inferMaterialLabel({ material: '' }, dd) || '';
        detailsText = prodLabel ? prodLabel : '';
        if (!detailsText) {
          try { detailsText = JSON.stringify(dd).slice(0, 160); } catch (e) { detailsText = String(dd).substring(0,160); }
        }
        decodedCached = dd;
      }
    } catch (err) {
      detailsText = '';
    }

    // Apply material inference for UI label when missing
    if (!material) {
      material = inferMaterialLabel(d, decodedCached);
    }

    html += `
        <tr>
          <td id="${detailsCellId}">${detailsText || '<span style="color:#7a8ba0">Loading...</span>'}</td>
          <td>${txLink}</td>
          <td>${feeSol} SOL <span style="color:#7dd3fc;font-size:13px;">($${feeUsd})</span></td>
        </tr>
    `;

    // Async fetch for decoded details using global cache
    if (txid) {
      setTimeout(() => {
        // Check cache first
        if (txDetailsCache[txid]) {
          updateAllDetailCells(txid, txDetailsCache[txid]);
          return;
        }
        
        fetch(`/api/tx-details/${txid}`)
          .then(res => res.ok ? res.json() : null)
          .then(async (decoded) => {
            if (!decoded) return;
            txDetailsCache[txid] = decoded; // Cache the result
            updateAllDetailCells(txid, decoded);
          })
          .catch(err => {
            const cells = document.querySelectorAll(`[id^="details-cell-${txid}"]`);
            cells.forEach(cell => {
              if (cell) cell.innerHTML = '<span style="color:#ef4444">No details available</span>';
            });
          });
      }, 0);
    }
  });
  
  if (details.length > maxDetails) {
    html += `
      <tr><td colspan="4" style="color:#7a8ba0;">...and ${details.length - maxDetails} more</td></tr>
    `;
  }
  
  return html;
}

// Helper to update a detail cell with decoded transaction data
function updateDetailCell(cellId, decoded) {
  const cell = document.getElementById(cellId);
  if (!cell) return;

  let detailsHtml = '';
  
  try {
    const action = (decoded.actions && decoded.actions[0]) || {};
    const burns = decoded.burnedMaterials || action.burnedMaterials || [];
    const claims = decoded.claimedItems || action.claimedItems || [];

    // Determine if start or claim based on action field
    const actionStr = (action && action.action) ? action.action.toString().toLowerCase() : '';
    let craftingStage = 'Crafting';
    if (actionStr.includes('claim')) craftingStage = 'Claim Crafting';
    else if (actionStr.includes('start')) craftingStage = 'Start Crafting';
    else if (claims && claims.length > 0) craftingStage = 'Claim Crafting';
    else if (burns && burns.length > 0) craftingStage = 'Start Crafting';
    
    const parts = [];
    parts.push(craftingStage);
    
    if (Array.isArray(burns) && burns.length > 0) {
      const burnList = burns.map(b => {
        const mat = b.material || '';
        const amt = b.amount != null ? b.amount : '';
        const matLabel = inferMaterialLabel({ material: mat }, decoded) || mat;
        return `${matLabel} ${amt}`;
      }).join(', ');
      parts.push(`Burn: ${burnList}`);
    }
    
    if (Array.isArray(claims) && claims.length > 0) {
      const claimList = claims.map(c => {
        const mat = c.material || c.item || '';
        const amt = c.amount != null ? c.amount : '';
        const matLabel = inferMaterialLabel({ material: mat }, decoded) || mat;
        return `${matLabel} ${amt}`;
      }).join(', ');
      parts.push(`Claim: ${claimList}`);
    }

    detailsHtml = parts.join(' • ');
    
  } catch (e) {
    console.error('Error formatting crafting details:', e);
    detailsHtml = '<span style="color:#ef4444">Failed to format decoded data</span>';
  }
  
  cell.innerHTML = detailsHtml;
}

// Helper to update all cells with the same txid across both sections
function updateAllDetailCells(txid, decoded) {
  // Update all cells with this txid (both in fleet breakdown and operation summary)
  const cells = document.querySelectorAll(`[id^="details-cell-${txid}"]`);
  cells.forEach(cell => {
    let detailsHtml = '';
    
    try {
      const action = (decoded.actions && decoded.actions[0]) || {};
      const burns = decoded.burnedMaterials || action.burnedMaterials || [];
      const claims = decoded.claimedItems || action.claimedItems || [];

      // Determine if start or claim based on action field
      const actionStr = (action && action.action) ? action.action.toString().toLowerCase() : '';
      let craftingStage = 'Crafting';
      if (actionStr.includes('claim')) craftingStage = 'Claim Crafting';
      else if (actionStr.includes('start')) craftingStage = 'Start Crafting';
      else if (claims && claims.length > 0) craftingStage = 'Claim Crafting';
      else if (burns && burns.length > 0) craftingStage = 'Start Crafting';
      
      const parts = [];
      parts.push(craftingStage);
      
      if (Array.isArray(burns) && burns.length > 0) {
        const burnList = burns.map(b => {
          const mat = b.material || '';
          const amt = b.amount != null ? b.amount : '';
          const matLabel = inferMaterialLabel({ material: mat }, decoded) || mat;
          return `${matLabel} ${amt}`;
        }).join(', ');
        parts.push(`Burn: ${burnList}`);
      }
      
      if (Array.isArray(claims) && claims.length > 0) {
        const claimList = claims.map(c => {
          const mat = c.material || c.item || '';
          const amt = c.amount != null ? c.amount : '';
          const matLabel = inferMaterialLabel({ material: mat }, decoded) || mat;
          return `${matLabel} ${amt}`;
        }).join(', ');
        parts.push(`Claim: ${claimList}`);
      }

      detailsHtml = parts.join(' • ');
      
    } catch (e) {
      console.error('Error formatting crafting details:', e);
      detailsHtml = '<span style="color:#ef4444">Failed to format decoded data</span>';
    }
    
    cell.innerHTML = detailsHtml;
  });
}

// Setup cache button click handlers
document.addEventListener('DOMContentLoaded', () => {
    // Price ticker fetch and update
    async function updatePriceTicker() {
      try {
        // Fetch CoinGecko prices via backend proxy
        const cgRes = await fetch('/api/prices');
        let prices = cgRes.ok ? await cgRes.json() : {};

        // Fetch WPAC price and icon from backend proxy
        let wpacPrice = '--';
        let wpacIcon = 'https://assets.coingecko.com/coins/images/4713/large/matic-token-icon.png';
        try {
          const boomRes = await fetch('/api/wpac');
          if (boomRes.ok) {
            const boomData = await boomRes.json();
            if (boomData.price) wpacPrice = boomData.price;
            if (boomData.icon) wpacIcon = boomData.icon;
          } else {
            console.warn('[WPAC proxy] Response not OK:', boomRes.status);
          }
        } catch (err) {
          console.error('[WPAC proxy] Fetch error:', err);
        }

        // Merge WPAC into prices
        prices['wpac'] = { usd: wpacPrice, icon: wpacIcon };
        window.prices = prices;
        renderPriceTicker(prices);
      } catch {
        renderPriceTicker(null);
      }
    }
    updatePriceTicker();
    setInterval(updatePriceTicker, 60000);
  const cacheUpdateBtn = document.getElementById('cacheUpdateBtn');
  const cacheRefreshBtn = document.getElementById('cacheRefreshBtn');
  const cacheWipeBtn = document.getElementById('cacheWipeBtn');
  
  if (cacheUpdateBtn) {
    cacheUpdateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('Cache update button clicked');
      updateCache();
    });
  }
  
  if (cacheRefreshBtn) {
    cacheRefreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('Cache refresh button clicked');
      refreshAnalysis();
    });
  }
  
  if (cacheWipeBtn) {
    cacheWipeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      console.log('Cache wipe button clicked');
      wipeAndReload();
    });
  }
});

// Helper to update progress message
function updateProgress(message) {
  const resultsDiv = document.getElementById('results');
  if (resultsDiv) {
    let elapsed = '';
    if (analysisStartTime) {
      const seconds = Math.floor((Date.now() - analysisStartTime) / 1000);
      elapsed = ` - ${seconds}s`;
    }
    resultsDiv.innerHTML = `<div class="loading">Processing transaction data, this may take up to 5 minutes depending on your tx/day...<br><span style="font-size:11px; color:#7a8ba0; margin-top:8px; display:block;">(${message}${elapsed})</span></div>`;
  }
}

// Global helper to format timestamps used across the UI
function formatTimestamp(ts) {
  if (!ts) return '';
  // If numeric blockTime in seconds
  if (typeof ts === 'number') {
    try { return new Date(ts * 1000).toLocaleString(); } catch (e) { return String(ts); }
  }
  // If ISO string or numeric string
  if (typeof ts === 'string') {
    if (/^\d+$/.test(ts)) {
      try { return new Date(Number(ts) * 1000).toLocaleString(); } catch (e) { return ts; }
    }
    try { const d = new Date(ts); return isNaN(d.getTime()) ? ts : d.toLocaleString(); } catch (_) { return ts; }
  }
  return '';
}

// Tabs handling
// Tabs handling (single Fees view only)
function showFees() {
  const fees = document.getElementById('fees-view');
  const tabFees = document.getElementById('tab-fees');
  if (fees) fees.style.display = '';
  if (tabFees) tabFees.classList.add('tab-active');
}

document.addEventListener('DOMContentLoaded', () => {
  const tf = document.getElementById('tab-fees');
  if (tf) tf.addEventListener('click', showFees);
});

function displayPartialResults(update, fleets, fleetRentalStatus) {
  const resultsDiv = document.getElementById('results');
  if (!resultsDiv) return;
  
  // Build partial HTML with available data
  const rentedFleetNames = new Set();
  try {
    fleets.forEach(f => {
      const isRented = !!(fleetRentalStatus[f.key] || fleetRentalStatus[f.data.fleetShips]);
      if (isRented) rentedFleetNames.add(f.callsign);
    });
  } catch {}
  
  // Mark rented fleets in the partial data
  Object.entries(update.feesByFleet || {}).forEach(([name, entry]) => {
    if (rentedFleetNames.has(String(name))) {
      entry.isRented = true;
    }
  });
  
  // Build simplified HTML for partial view
  let html = `
    <div style="opacity: 0.8;">
      <h2>⏳ Analysis in progress... (${update.percentage}%)</h2>
      <div class="summary">
        <div class="summary-item">
          <span class="label">Total Fees:</span>
          <span class="value">${(update.totalFees24h / 1e9).toFixed(6)} SOL</span>
                  <span class="value">${(update.totalFees24h / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((update.totalFees24h / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></span>
        </div>
        <div class="summary-item">
          <span class="label">SAGE Fees:</span>
          <span class="value">${(update.sageFees24h / 1e9).toFixed(6)} SOL</span>
                  <span class="value">${(update.sageFees24h / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((update.sageFees24h / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></span>
        </div>
        <div class="summary-item">
          <span class="label">Transactions:</span>
          <span class="value">${update.transactionCount24h || 0}</span>
        </div>
      </div>
  `;
  
  // Show fleet breakdown if available
  if (update.feesByFleet && Object.keys(update.feesByFleet).length > 0) {
    const sortedFleets = Object.entries(update.feesByFleet)
      .sort((a, b) => b[1].totalFee - a[1].totalFee);
    
    html += '<h3>Fleet Breakdown (partial)</h3><div class="fleet-list">';
    
    const totalFee = Object.values(update.feesByFleet).reduce((sum, f) => sum + (f.totalFee || 0), 0);
    sortedFleets.forEach(([fleetName, fleetData]) => {
      const isRented = !!fleetData.isRented;
      const nameClass = isRented ? 'rented-name' : '';
      const badge = isRented ? '<span class="rented-badge">RENTED</span>' : '';
      const pct = totalFee ? ((fleetData.totalFee / totalFee) * 100).toFixed(1) : '0.0';
      html += `
        <div class="fleet-item">
          <div class="fleet-header">
            <span class="fleet-name ${nameClass}">${fleetName}</span>
            ${badge}
            <span class="fleet-fee">${(fleetData.totalFee / 1e9).toFixed(6)} SOL</span>
                        <span class="fleet-fee">${(fleetData.totalFee / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((fleetData.totalFee / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></span>
            <span class="fleet-pct">${pct}%</span>
          </div>
        </div>
      `;
    });
    
    html += '</div>';
  }
  
  html += '</div>';
  resultsDiv.innerHTML = html;
  // No toggle: crafting categories are always included by default.
}

async function analyzeFees() {
  const profileId = document.getElementById('profileId').value.trim();
  const resultsDiv = document.getElementById('results');
  const btn = document.getElementById('analyzeBtn');
  
  if (!profileId) {
    alert('Inserisci un Player Profile ID!');
    return;
  }
  
  // Store profile ID globally
  currentProfileId = profileId;
  
  // Hide form and sidebar during analysis
  const formBox = document.querySelector('.form-box');
  if (formBox) formBox.style.display = 'none';
  
  setSidebarVisible(false);

  btn.disabled = true;
  btn.textContent = 'Loading...';
  
  analysisStartTime = Date.now();
  updateProgress('Initializing...');
  
  // Update timer every second independently
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (analysisStartTime) {
      const seconds = Math.floor((Date.now() - analysisStartTime) / 1000);
      const resultsDiv = document.getElementById('results');
      if (resultsDiv) {
        const loadingDiv = resultsDiv.querySelector('.loading');
        if (loadingDiv) {
          const span = loadingDiv.querySelector('span');
          if (span) {
            // Extract message without time
            const text = span.textContent;
            const messageMatch = text.match(/\((.+?)(?:\s-\s\d+s)?\)$/);
            const message = messageMatch ? messageMatch[1] : text.replace(/\(|\)/g, '').split(' - ')[0];
            span.textContent = `(${message} - ${seconds}s)`;
          }
        }
      }
    }
  }, 1000);

  try {
    // Get fleets first to derive wallet from transactions (use cache if available)
    updateProgress('Fetching fleet data...');
    console.log('Fetching fleets for profile:', profileId);
    const fleetsResponse = await fetch('/api/fleets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId })
    });
    
    if (!fleetsResponse.ok) {
      throw new Error('Failed to fetch fleets');
    }
    
    const fleetsData = await fleetsResponse.json();
    
    if (!fleetsData.walletAuthority) {
      throw new Error('Could not derive wallet from fleet transactions');
    }
    
    const walletPubkey = fleetsData.walletAuthority;
  const fleets = fleetsData.fleets;
    
    updateProgress(`Found ${fleets.length} fleets, deriving wallet...`);
    console.log('Derived wallet:', walletPubkey);
    console.log('Fleets found:', fleets.length);
    
    // Collect all fleet-related accounts
    updateProgress(`Analyzing ${fleets.length} fleet accounts...`);
    const allFleetAccounts = [];
    const fleetNames = {};
  const fleetRentalStatus = {}; // Track which fleets are rented (from backend)
    
    fleets.forEach(f => {
      // Main accounts
      allFleetAccounts.push(f.data.fleetShips);
      allFleetAccounts.push(f.key);
      
      // Fuel, ammo, cargo
      if (f.data.fuelTank) allFleetAccounts.push(f.data.fuelTank);
      if (f.data.ammoBank) allFleetAccounts.push(f.data.ammoBank);
      if (f.data.cargoHold) allFleetAccounts.push(f.data.cargoHold);
      
      // Map names
      fleetNames[f.data.fleetShips] = f.callsign;
      fleetNames[f.key] = f.callsign;
      if (f.data.fuelTank) fleetNames[f.data.fuelTank] = f.callsign;
      if (f.data.ammoBank) fleetNames[f.data.ammoBank] = f.callsign;
      if (f.data.cargoHold) fleetNames[f.data.cargoHold] = f.callsign;
      
      // Map rental status (backend authoritative flag)
      const initialRented = !!f.isRented;
      fleetRentalStatus[f.data.fleetShips] = initialRented;
      fleetRentalStatus[f.key] = initialRented;
      if (f.data.fuelTank) fleetRentalStatus[f.data.fuelTank] = initialRented;
      if (f.data.ammoBank) fleetRentalStatus[f.data.ammoBank] = initialRented;
      if (f.data.cargoHold) fleetRentalStatus[f.data.cargoHold] = initialRented;
    });

    const uniqueFleetAccounts = [...new Set(allFleetAccounts)];
    console.log('Fleet accounts collected:', uniqueFleetAccounts.length);
    
    // Get detailed fees with streaming updates
    updateProgress(`Analyzing transaction history (limit: 24h or 3000 tx per batch, 3000 max)...`);
    console.log('Starting streaming analysis...');
    
    let data = null;
    let lastProgress = null;
    let fromCache = false;
    
    // Forza la UI a usare il dataset di test
    // Use fetch with streaming response
    const response = await fetch('/api/wallet-sage-fees-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        walletPubkey, 
        fleetAccounts: uniqueFleetAccounts,
        fleetNames: fleetNames,
        fleetRentalStatus: fleetRentalStatus,
        hours: 24 
      })
    });
    
    if (!response.ok) {
      throw new Error('Streaming request failed');
    }
    
    // Check cache headers
    const cacheHit = response.headers.get('X-Cache-Hit');
    const cacheTimestamp = response.headers.get('X-Cache-Timestamp');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    console.log('[analyzeFees] Started SSE stream consumption');
    let stopReading = false;
    
    while (true) {
      if (stopReading) break;
      const { done, value } = await reader.read();
      
      if (done) break;
      console.log('[analyzeFees] Received chunk bytes:', value.length);
      
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete messages (SSE format: "data: {...}\n\n")
      const messages = buffer.split('\n\n');
      buffer = messages.pop() || ''; // Keep incomplete message in buffer
      
      for (const message of messages) {
        if (!message.trim() || !message.startsWith('data: ')) continue;
        
        const jsonStr = message.substring(6); // Remove "data: " prefix
        try {
          const update = JSON.parse(jsonStr);
          console.log('[analyzeFees] SSE message type:', update.type, 'stage:', update.stage, 'processed:', update.processed, 'total:', update.total);
          
          if (update.type === 'progress') {
            lastProgress = update;
            if (update.stage === 'signatures') {
              updateProgress(`${update.message} (${update.processed}/${update.total})`);
            } else if (update.stage === 'transactions') {
              const msg = `Processing: ${update.processed}/${update.total} tx (${update.percentage}%)`;
              updateProgress(msg);
              
              // Update UI with partial results if available
              if (update.feesByFleet && Object.keys(update.feesByFleet).length > 0) {
                displayPartialResults(update, fleets, fleetRentalStatus);
              }
            }
          } else if (update.type === 'complete') {
            data = update;
            fromCache = !!update.fromCache;
            console.log('[analyzeFees] Received complete payload. Transactions:', data.transactionCount24h, 'Signatures:', data.totalSignaturesFetched, '(limit: 3000 per batch, 3000 max)');
            // Stop reading further SSE events immediately
            try { await reader.cancel(); } catch {}
            stopReading = true;
            break;
          } else if (update.error) {
            throw new Error(update.error);
          }
        } catch (e) {
          console.error('Failed to parse SSE message:', e);
        }
      }
    }
    
    // Fallback: parse any remaining buffer for a final message
    if (!data && buffer.trim()) {
      console.warn('[analyzeFees] No complete received, trying fallback parse of remaining buffer');
      const lines = buffer.split(/\n/).filter(l => l.startsWith('data: '));
      for (const l of lines) {
        try {
          const obj = JSON.parse(l.substring(6));
          if (obj.type === 'complete') {
            data = obj;
            break;
          }
        } catch {}
      }
    }
    // Synthetic completion if still missing but we had progress
    if (!data && lastProgress) {
      console.error('[analyzeFees] Synthesizing final result from last progress update');
      data = {
        ...lastProgress,
        type: 'complete',
        synthetic: true
      };
    }
    if (!data) {
      throw new Error('Analysis failed - no data received');
    }
    console.log('[analyzeFees] Stream finished, data object present');
    
    // Save analysis parameters for future updates
    lastAnalysisParams = {
      walletPubkey,
      fleetAccounts: uniqueFleetAccounts,
      fleetNames,
      fleetRentalStatus,
      fleets
    };
    
    // Show final processing stats
    const totalSigs = data.totalSignaturesFetched || 'N/A';
    const processedTxs = data.transactionCount24h || 0;
    const cacheMsg = fromCache ? ' (from cache)' : '';
    updateProgress(`Completed: ${processedTxs}/${totalSigs} transactions${cacheMsg}`);
    
    // Update icon based on cache status
    const profileIcon = document.getElementById('profileIcon');
    const cacheTooltip = document.getElementById('cacheTooltip');
    const cacheTooltipIcon = document.getElementById('cacheTooltipIcon');
    const cacheTooltipTitle = document.getElementById('cacheTooltipTitle');
    const cacheTooltipStatus = document.getElementById('cacheTooltipStatus');
    const cacheTooltipAge = document.getElementById('cacheTooltipAge');
    
    if (profileIcon && cacheTooltip) {
      profileIcon.classList.remove('cache-fresh', 'cache-stale');
      profileIcon.title = '';
      profileIcon.style.opacity = '1';
      
      // Setup hover behavior for tooltip
      let hideTimeout = null;
      
      profileIcon.onmouseenter = () => {
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        cacheTooltip.classList.add('visible');
      };
      
      profileIcon.onmouseleave = () => {
        // Delay hiding to allow mouse to move to tooltip
        hideTimeout = setTimeout(() => {
          cacheTooltip.classList.remove('visible');
        }, 200);
      };
      
      cacheTooltip.onmouseenter = () => {
        // Cancel hide if mouse enters tooltip
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }
      };
      
      cacheTooltip.onmouseleave = () => {
        cacheTooltip.classList.remove('visible');
      };
      
      const cacheUpdateBtn = document.getElementById('cacheUpdateBtn');
      const cacheRefreshBtn = document.getElementById('cacheRefreshBtn');
      
      if (cacheHit === 'disk' && cacheTimestamp) {
        const cacheAge = Date.now() - parseInt(cacheTimestamp);
        const sixHoursMs = 6 * 60 * 60 * 1000;
        const ageMinutes = (cacheAge / 60000).toFixed(1);
        const ageHours = (cacheAge / 3600000).toFixed(1);
        
        console.log('Cache age (hours):', (cacheAge / (60 * 60 * 1000)).toFixed(2));
        
        if (cacheAge < sixHoursMs) {
          profileIcon.classList.add('cache-fresh');
          cacheTooltipIcon.textContent = '✅';
          cacheTooltipTitle.textContent = 'Cache Fresh';
          cacheTooltipStatus.textContent = 'Data loaded from cache';
          cacheTooltipAge.textContent = ageHours < 1 ? `Age: ${ageMinutes} minutes` : `Age: ${ageHours} hours`;
          // Show update button for fresh cache
          if (cacheUpdateBtn) cacheUpdateBtn.style.display = '';
          if (cacheRefreshBtn) cacheRefreshBtn.style.display = 'none';
          console.log('Icon: GREEN (fresh cache)');
        } else {
          profileIcon.classList.add('cache-stale');
          cacheTooltipIcon.textContent = '⚠️';
          cacheTooltipTitle.textContent = 'Cache Stale';
          cacheTooltipStatus.textContent = 'Cache is older than 6 hours';
          cacheTooltipAge.textContent = `Age: ${ageHours} hours`;
          // Show refresh button for stale cache
          if (cacheUpdateBtn) cacheUpdateBtn.style.display = 'none';
          if (cacheRefreshBtn) cacheRefreshBtn.style.display = '';
          console.log('Icon: RED (stale cache)');
        }
      } else {
        // Fresh data from API
        profileIcon.classList.add('cache-fresh');
        cacheTooltipIcon.textContent = '✨';
        cacheTooltipTitle.textContent = 'Fresh Data';
        cacheTooltipStatus.textContent = 'Just fetched from API';
        cacheTooltipAge.textContent = 'No cached data';
        // Hide update button, show refresh
        if (cacheUpdateBtn) cacheUpdateBtn.style.display = 'none';
        if (cacheRefreshBtn) cacheRefreshBtn.style.display = '';
        console.log('Icon: GREEN (fresh from API)');
      }
      
      // Re-enable cache buttons
      const updateBtn = document.getElementById('cacheUpdateBtn');
      const refreshBtn = document.getElementById('cacheRefreshBtn');
      const wipeBtn = document.getElementById('cacheWipeBtn');
      if (updateBtn) {
        updateBtn.disabled = false;
        updateBtn.textContent = '⚡ Update Cache';
      }
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 Force Refresh';
      }
      if (wipeBtn) {
        wipeBtn.disabled = false;
        wipeBtn.textContent = '🗑️ Wipe & Reload';
      }
    }
    
    console.log('Analysis complete. Transactions:', data.transactionCount24h, '(limit: 3000 per batch, 3000 max)');
    
    // Collect rented fleet names from fleet list (backend authoritative flags)
    const rentedFleetNames = new Set();
    try {
      fleets.forEach(f => {
        const isRented = !!(fleetRentalStatus[f.key] || fleetRentalStatus[f.data.fleetShips]);
        if (isRented) rentedFleetNames.add(f.callsign);
      });
    } catch {}
    
    console.log('Rented fleets detected from backend:', Array.from(rentedFleetNames));

    // Ensure backend results carry rental flag by fleet name
    // This is critical: feesByFleet may not include all fleets (only those with 24h ops)
    // so we propagate isRented from the fleet list to any matching name in feesByFleet
    try {
      Object.entries(data.feesByFleet || {}).forEach(([name, entry]) => {
        const isRent = rentedFleetNames.has(String(name)) || rentedFleetNames.has(String(name).trim());
        if (isRent) {
          entry.isRented = true;
        }
      });
    } catch {}

    // Display results
    displayResults(data, fleetNames, rentedFleetNames);
    
    // Show sidebar with profile info
    const sidebar = document.getElementById('sidebar');
    const sidebarProfileId = document.getElementById('sidebarProfileId');
    const container = document.querySelector('.container');
    
    if (sidebar) {
      sidebar.style.display = 'flex';
      if (sidebarProfileId) {
        sidebarProfileId.textContent = profileId.substring(0, 6) + '...';
      }
    }
    if (container) container.classList.add('with-sidebar');
    
  } catch (error) {
    console.error('Analysis error:', error);
    resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
      }
    btn.disabled = false;
    btn.textContent = 'Analyze 24h';
  }
}

async function updateCache() {
  if (!currentProfileId) return;
  
  if (!lastAnalysisParams) {
    alert('No previous analysis found. Please run "Analyze 24h" first.');
    return;
  }
  
  const resultsDiv = document.getElementById('results');
  const profileIcon = document.getElementById('profileIcon');
  const cacheTooltip = document.getElementById('cacheTooltip');
  const cacheUpdateBtn = document.getElementById('cacheUpdateBtn');
  
  // Hide tooltip and sidebar during update
  if (cacheTooltip) cacheTooltip.classList.remove('visible');
  setSidebarVisible(false);
  
  analysisStartTime = Date.now();
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  updateProgress('Updating cache (incremental)...');
  
  console.log('[updateCache] Starting cache update...');
  
  // Start timer interval
  progressInterval = setInterval(() => {
    if (analysisStartTime) {
      const seconds = Math.floor((Date.now() - analysisStartTime) / 1000);
      const resultsDiv = document.getElementById('results');
      if (resultsDiv) {
        const loadingDiv = resultsDiv.querySelector('.loading');
        if (loadingDiv) {
          const span = loadingDiv.querySelector('span');
          if (span) {
            const text = span.textContent;
            const messageMatch = text.match(/\((.+?)(?:\s-\s\d+s)?\)$/);
            const message = messageMatch ? messageMatch[1] : text.replace(/\(|\)/g, '').split(' - ')[0];
            span.textContent = `(${message} - ${seconds}s)`;
          }
        }
      }
    }
  }, 1000);
  
  if (profileIcon) {
    profileIcon.classList.remove('cache-fresh', 'cache-stale');
    profileIcon.style.opacity = '0.5';
    profileIcon.title = 'Updating...';
  }
  if (cacheUpdateBtn) {
    cacheUpdateBtn.disabled = true;
    cacheUpdateBtn.textContent = '⏳ Updating...';
  }
  
  try {
    // Use saved parameters from last analysis
    const { walletPubkey, fleetAccounts, fleetNames, fleetRentalStatus, fleets } = lastAnalysisParams;
    
    console.log('Updating cache for profile:', currentProfileId);
    console.log('Using saved parameters:', { 
      walletPubkey: walletPubkey.substring(0, 8) + '...', 
      fleetCount: fleetAccounts.length 
    });
    
    // Call streaming endpoint with update=true flag
    const response = await fetch('/api/wallet-sage-fees-stream?update=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        walletPubkey, 
        fleetAccounts,
        fleetNames,
        fleetRentalStatus,
        hours: 24,
        update: true
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch wallet fees');
    }
    
    // Process SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReading = false;
    let finalData = null;
    
    console.log('[updateCache] Starting SSE stream read');
    
    while (true) {
      if (stopReading) break;
      const { done, value } = await reader.read();
      if (done) {
        console.log('[updateCache] Reader done');
        break;
      }
      
      console.log('[updateCache] Received chunk:', value.length, 'bytes');
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const msg = line.substring(6);
        
        try {
          const update = JSON.parse(msg);
          console.log('[updateCache] Received update type:', update.type, 'stage:', update.stage);
          if (update.type === 'progress') {
            displayPartialResults(update, fleets, fleetRentalStatus);
          } else if (update.type === 'complete') {
            console.log('[updateCache] Update complete! Transactions:', update.transactionCount24h, '(limit: 3000 per batch, 3000 max)');
            finalData = update;
            try { await reader.cancel(); } catch {}
            stopReading = true;
            break;
          } else if (update.type === 'error') {
            throw new Error(update.message || 'Unknown error');
          }
        } catch (err) {
          console.error('Error parsing SSE message:', err, msg);
        }
      }
    }
    
    console.log('[updateCache] Stream ended. finalData present?', !!finalData);
    
    // Ensure we have final data
    if (!finalData) {
      console.error('[updateCache] No complete data received!');
      throw new Error('Update completed but no final data received');
    }
    
    // Build rented fleet names set from fleets
    const rentedFleetNames = new Set();
    try {
      fleets.forEach(f => {
        const isRented = !!(fleetRentalStatus[f.key] || fleetRentalStatus[f.data.fleetShips]);
        if (isRented) rentedFleetNames.add(f.callsign);
      });
    } catch (err) {
      console.warn('[updateCache] Could not build rentedFleetNames:', err);
    }
    
    // Render full results with charts
    console.log('[updateCache] Rendering final results...');
    displayResults(finalData, fleetNames, rentedFleetNames);
    
    // Update cache status icon
    if (profileIcon) {
      profileIcon.classList.remove('cache-stale');
      profileIcon.classList.add('cache-fresh');
      profileIcon.style.opacity = '1';
    }
    // Restore update button state
    if (cacheUpdateBtn) {
      cacheUpdateBtn.disabled = false;
      cacheUpdateBtn.textContent = '⚡ Update Cache';
    }
    // Show sidebar again
    setSidebarVisible(true);
    const sidebarProfileId = document.getElementById('sidebarProfileId');
    if (sidebarProfileId) {
      sidebarProfileId.textContent = currentProfileId.substring(0, 6) + '...';
    }
    
  } catch (error) {
    console.error('Update error:', error);
    resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    setSidebarVisible(true);
  }
}

async function wipeAndReload() {
  if (!currentProfileId) return;
  
  // Proceed without confirmation popup (auto-confirm)
  
  const resultsDiv = document.getElementById('results');
  const profileIcon = document.getElementById('profileIcon');
  const cacheTooltip = document.getElementById('cacheTooltip');
  const cacheWipeBtn = document.getElementById('cacheWipeBtn');
  
  // Hide tooltip and sidebar
  if (cacheTooltip) cacheTooltip.classList.remove('visible');
  setSidebarVisible(false);
  
  analysisStartTime = Date.now();
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  updateProgress('Wiping cache and reloading...');
  
  // Start timer interval
  progressInterval = setInterval(() => {
    if (analysisStartTime) {
      const seconds = Math.floor((Date.now() - analysisStartTime) / 1000);
      const resultsDiv = document.getElementById('results');
      if (resultsDiv) {
        const loadingDiv = resultsDiv.querySelector('.loading');
        if (loadingDiv) {
          const span = loadingDiv.querySelector('span');
          if (span) {
            const text = span.textContent;
            const messageMatch = text.match(/\((.+?)(?:\s-\s\d+s)?\)$/);
            const message = messageMatch ? messageMatch[1] : text.replace(/\(|\)/g, '').split(' - ')[0];
            span.textContent = `(${message} - ${seconds}s)`;
          }
        }
      }
    }
  }, 1000);
  
  if (profileIcon) {
    profileIcon.classList.remove('cache-fresh', 'cache-stale');
    profileIcon.style.opacity = '0.5';
    profileIcon.title = 'Wiping cache...';
  }
  if (cacheWipeBtn) {
    cacheWipeBtn.disabled = true;
    cacheWipeBtn.textContent = '⏳ Wiping...';
  }
  
  try {
    // Call wipe endpoint
    console.log('Wiping cache for profile:', currentProfileId);
    const wipeResponse = await fetch('/api/cache/wipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: currentProfileId })
    });
    
    if (!wipeResponse.ok) {
      throw new Error('Failed to wipe cache');
    }
    
    console.log('Cache wiped, reloading data...');
    updateProgress('Cache wiped, fetching fresh data...');
    
    // Now call refresh
    await refreshAnalysis();
    
  } catch (error) {
    console.error('Wipe error:', error);
    resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    setSidebarVisible(true);
  }
}

async function refreshAnalysis() {
  if (!currentProfileId) return;
  
  const resultsDiv = document.getElementById('results');
  const profileIcon = document.getElementById('profileIcon');
  const cacheTooltip = document.getElementById('cacheTooltip');
  const cacheRefreshBtn = document.getElementById('cacheRefreshBtn');
  
  // Hide tooltip and sidebar during refresh
  if (cacheTooltip) cacheTooltip.classList.remove('visible');
  setSidebarVisible(false);
  
  analysisStartTime = Date.now();
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  updateProgress('Refreshing fleet data...');
  
  // Start timer interval for refresh
  progressInterval = setInterval(() => {
    if (analysisStartTime) {
      const seconds = Math.floor((Date.now() - analysisStartTime) / 1000);
      const resultsDiv = document.getElementById('results');
      if (resultsDiv) {
        const loadingDiv = resultsDiv.querySelector('.loading');
        if (loadingDiv) {
          const span = loadingDiv.querySelector('span');
          if (span) {
            const text = span.textContent;
            const messageMatch = text.match(/\((.+?)(?:\s-\s\d+s)?\)$/);
            const message = messageMatch ? messageMatch[1] : text.replace(/\(|\)/g, '').split(' - ')[0];
            span.textContent = `(${message} - ${seconds}s)`;
          }
        }
      }
    }
  }, 1000);
  
  if (profileIcon) {
    profileIcon.classList.remove('cache-fresh', 'cache-stale');
    profileIcon.style.opacity = '0.5';
    profileIcon.title = 'Refreshing...';
  }
  if (cacheRefreshBtn) {
    cacheRefreshBtn.disabled = true;
    cacheRefreshBtn.textContent = '⏳ Refreshing...';
  }
  
  try {
    // Fetch with refresh flag
    console.log('Refreshing fleets for profile:', currentProfileId);
    const fleetsResponse = await fetch('/api/fleets?refresh=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: currentProfileId })
    });
    
    if (!fleetsResponse.ok) {
      throw new Error('Failed to fetch fleets');
    }
    
    const fleetsData = await fleetsResponse.json();
    const walletPubkey = fleetsData.walletAuthority;
    const fleets = fleetsData.fleets;
    
    updateProgress(`Found ${fleets.length} fleets, collecting accounts...`);
    
    // Collect fleet accounts and names
    const allFleetAccounts = [];
    const fleetNames = {};
    const fleetRentalStatus = {};
    
    fleets.forEach(f => {
      allFleetAccounts.push(f.data.fleetShips);
      allFleetAccounts.push(f.key);
      if (f.data.fuelTank) allFleetAccounts.push(f.data.fuelTank);
      if (f.data.ammoBank) allFleetAccounts.push(f.data.ammoBank);
      if (f.data.cargoHold) allFleetAccounts.push(f.data.cargoHold);
      
      fleetNames[f.data.fleetShips] = f.callsign;
      fleetNames[f.key] = f.callsign;
      if (f.data.fuelTank) fleetNames[f.data.fuelTank] = f.callsign;
      if (f.data.ammoBank) fleetNames[f.data.ammoBank] = f.callsign;
      if (f.data.cargoHold) fleetNames[f.data.cargoHold] = f.callsign;
      
      const initialRented = !!f.isRented;
      fleetRentalStatus[f.data.fleetShips] = initialRented;
      fleetRentalStatus[f.key] = initialRented;
      if (f.data.fuelTank) fleetRentalStatus[f.data.fuelTank] = initialRented;
      if (f.data.ammoBank) fleetRentalStatus[f.data.ammoBank] = initialRented;
      if (f.data.cargoHold) fleetRentalStatus[f.data.cargoHold] = initialRented;
    });
    
    const uniqueFleetAccounts = [...new Set(allFleetAccounts)];
    
    updateProgress('Fetching fresh transaction data...');
    
    // Validate walletPubkey before making request
    if (!walletPubkey) {
      throw new Error('Wallet pubkey not found in fleet data');
    }
    
    console.log('[refreshAnalysis] Sending request with wallet:', walletPubkey.substring(0, 8) + '...');
    
    // Use streaming endpoint with refresh flag
    const response = await fetch('/api/wallet-sage-fees-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        walletPubkey: walletPubkey, 
        fleetAccounts: uniqueFleetAccounts,
        fleetNames: fleetNames,
        fleetRentalStatus: fleetRentalStatus,
        hours: 24,
        refresh: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch transaction data: ${response.statusText}`);
    }
    
    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stopReading = false;
    let finalData = null;
    
    console.log('[refreshAnalysis] Starting SSE stream read');
    
    while (true) {
      if (stopReading) break;
      const { done, value } = await reader.read();
      if (done) {
        console.log('[refreshAnalysis] Reader done');
        break;
      }
      
      console.log('[refreshAnalysis] Received chunk:', value.length, 'bytes');
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop() || '';
      
      for (const msg of messages) {
        if (!msg.trim() || !msg.startsWith('data: ')) continue;
        
        try {
          const data = JSON.parse(msg.substring(6));
          console.log('[refreshAnalysis] SSE message type:', data.type);
          
          if (data.type === 'progress') {
            // Update progress with partial results
            if (data.feesByFleet) {
              displayPartialResults(data, fleets, fleetRentalStatus);
            }
            const pct = data.percentage || '0';
            const delay = data.currentDelay || '?';
            updateProgress(`${data.message || 'Processing...'} (${pct}% - delay: ${delay}ms)`);
          } else if (data.type === 'complete' || data.walletAddress) {
            console.log('[refreshAnalysis] Received COMPLETE event');
            // Final complete data - use displayResults to show full UI with charts
            finalData = data;
            const processedTxs = data.transactionCount24h || 0;
            const totalSigs = data.totalSignaturesFetched || 0;
            updateProgress(`Refreshed: ${processedTxs}/${totalSigs} transactions`);
            
            // Update icon to fresh state
            if (profileIcon) {
              profileIcon.classList.remove('cache-stale');
              profileIcon.classList.add('cache-fresh');
              profileIcon.style.opacity = '1';
              profileIcon.title = 'Fresh data. Click to refresh';
              profileIcon.onclick = (e) => {
                e.stopPropagation();
                refreshAnalysis();
              };
            }
            try { await reader.cancel(); } catch {}
            stopReading = true;
            break;
          } else if (data.error) {
            throw new Error(data.error);
          }
        } catch (err) {
          console.error('Error parsing SSE message:', err, msg);
        }
      }
    }
    
    console.log('[refreshAnalysis] Stream ended. finalData present?', !!finalData);
    
    // Ensure we have final data before showing sidebar
    if (!finalData) {
      console.error('[refreshAnalysis] No complete data received!');
      throw new Error('Analysis completed but no final data received');
    }
    
    // Build rented fleet names set from fleets
    const rentedFleetNames = new Set();
    try {
      fleets.forEach(f => {
        const isRented = !!(fleetRentalStatus[f.key] || fleetRentalStatus[f.data.fleetShips]);
        if (isRented) rentedFleetNames.add(f.callsign);
      });
    } catch (err) {
      console.warn('[refreshAnalysis] Could not build rentedFleetNames:', err);
    }
    
    // Render full results with charts
    console.log('[refreshAnalysis] Rendering final results...');
    displayResults(finalData, fleetNames, rentedFleetNames);
    
    // Show sidebar again
    setSidebarVisible(true);
    const sidebarProfileId = document.getElementById('sidebarProfileId');
    if (sidebarProfileId) {
      sidebarProfileId.textContent = currentProfileId.substring(0, 6) + '...';
    }
    
  } catch (error) {
    console.error('Refresh error:', error);
    resultsDiv.innerHTML = `<div class="error">Error: ${error.message}</div>`;
    // Show sidebar even on error
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    setSidebarVisible(true);

    // Restore cache buttons state in case they remained disabled
    try {
      const updateBtn = document.getElementById('cacheUpdateBtn');
      const refreshBtn = document.getElementById('cacheRefreshBtn');
      const wipeBtn = document.getElementById('cacheWipeBtn');
      if (updateBtn) {
        updateBtn.disabled = false;
        updateBtn.textContent = '⚡ Update Cache';
      }
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '🔄 Force Refresh';
      }
      if (wipeBtn) {
        wipeBtn.disabled = false;
        wipeBtn.textContent = '🗑️ Wipe & Reload';
      }
      const profileIcon = document.getElementById('profileIcon');
      if (profileIcon) profileIcon.style.opacity = '1';
    } catch (e) {
      console.warn('[refreshAnalysis] Could not restore cache button states:', e);
    }
  }
}

function displayResults(data, fleetNames, rentedFleetNames = new Set()) {
  console.log('Displaying results...');
  const resultsDiv = document.getElementById('results');
  
  // Prepare data for charts
  const sortedFleets = Object.entries(data.feesByFleet)
    .sort((a, b) => b[1].totalFee - a[1].totalFee)
    .slice(0, 5); // Top 5 fleets
  
  // Build sorted operation entries and ensure crafting-related categories
  // are always present in the operation chart so they are visible.
  const opEntries = Object.entries(data.feesByOperation)
    .sort((a, b) => b[1].totalFee - a[1].totalFee);
  // Default: top 10 operations
  const topN = opEntries.slice(0, 10);

  // Diagnostic: print available operation keys so we can see what arrived
  try {
    console.log('[displayResults] feesByOperation keys:', Object.keys(data.feesByOperation));
  } catch (e) {
    console.warn('[displayResults] could not log feesByOperation keys', e);
  }

  // Ensure crafting-related categories are included in the top slices.
  // Use both exact names (legacy) and a robust case-insensitive substring match ("craft").
  const ensureNames = ['Crafting', 'CraftBurn', 'CraftStart', 'CraftClaim'];
  // Add exact matches first
  ensureNames.forEach(name => {
    const idx = opEntries.findIndex(e => e[0] === name);
    if (idx !== -1 && !topN.some(e => e[0] === name)) {
      topN.push(opEntries[idx]);
    }
  });
  // Then add any operation whose name contains 'craft' (case-insensitive)
  const craftMatches = opEntries.filter(e => /craft/i.test(e[0]));
  craftMatches.forEach(match => {
    if (!topN.some(e => e[0] === match[0])) topN.push(match);
  });

  // Limit to a reasonable number of slices
  const sortedOps = topN.slice(0, 20);

  const fleetColors = ['#34d399', '#60a5fa', '#f59e0b', '#a78bfa', '#ec4899'];
  // Extended palette for up to 20 operation slices (generated palette)
  const opColors = ['#06b6d4', '#8b5cf6', '#f97316', '#10b981', '#fbbf24', '#ef4444', '#7c3aed', '#14b8a6', '#e879f9', '#60a5fa', '#06b6d4', '#f472b6', '#9ca3af', '#34d399', '#fb7185', '#60a5fa', '#fde68a', '#7dd3fc', '#a78bfa', '#34d399'];
  
  console.log('Top 5 fleets:', sortedFleets.map(([name, data]) => ({ name: fleetNames[name] || name, fee: data.totalFee })));
  console.log('Top 5 operations:', sortedOps.map(([name, data]) => ({ name, fee: data.totalFee })));
  
  const sageFees24h = data.sageFees24h;
  
  // Determine earliest transaction time from available arrays (support streaming 'allTransactions' or 'transactions')
  let firstTxTimeLabel = 'N/A';
  try {
    const txArray = (data.transactions && data.transactions.length && data.transactions) || (data.allTransactions && data.allTransactions.length && data.allTransactions) || [];
    if (txArray && txArray.length) {
      const times = txArray.map(t => {
        if (t.blockTime) return new Date(t.blockTime * 1000);
        if (t.timestamp) return new Date(t.timestamp);
        return null;
      }).filter(Boolean);
      if (times.length) {
        const earliest = new Date(Math.min(...times.map(d => d.getTime())));
        firstTxTimeLabel = earliest.toLocaleString();
      }
    }
  } catch (e) {
    console.warn('[displayResults] Could not compute first transaction time:', e);
  }

  let html = `
    <div class="analysis-period" style="margin-bottom:12px;color:#9aa6b2;font-size:14px;">Fees for operations in the last 24h from: ${firstTxTimeLabel}</div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Transactions</div>
        <div class="stat-value">${data.transactionCount24h}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Fees</div>
        <div class="stat-value highlight">${(data.sageFees24h / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((data.sageFees24h / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></div>
      </div>
    </div>

    <div class="charts-row">
      <div class="chart-card">
        <div class="chart-title">Fees by Fleet (Top 5)</div>
        <div class="chart-container">
          <canvas id="fleetChart" class="pie-chart"></canvas>
          <div class="chart-legend" id="fleetLegend"></div>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Fees by Operation (Top categories; Crafting always included)</div>
        <div class="chart-container">
          <canvas id="operationChart" class="pie-chart"></canvas>
          <div class="chart-legend" id="operationLegend"></div>
        </div>
      </div>
    </div>

  <h2 class="section-title">Fleet Breakdown</h2>
    <div id="fleetList"></div>

    <h2 class="section-title">Operations Summary</h2>
    <div id="operationList"></div>
  `;
  
  resultsDiv.innerHTML = html;
  
  // Create fleet list with fold/unfold
  createFleetList(data, fleetNames, rentedFleetNames);
  
  // Create operation list with fold/unfold
  createOperationList(data, fleetNames, rentedFleetNames);

  // Helper to format timestamp values used by the details table
  function formatTimestamp(ts) {
    if (!ts) return '';
    // If numeric blockTime in seconds
    if (typeof ts === 'number') {
      try { return new Date(ts * 1000).toLocaleString(); } catch (e) { return String(ts); }
    }
    // If ISO string
    if (typeof ts === 'string') {
      // Try parse as integer seconds
      if (/^\d+$/.test(ts)) {
        try { return new Date(Number(ts) * 1000).toLocaleString(); } catch (e) { return ts; }
      }
      return ts;
    }
    return '';
  }

  // No additional labels; rented fleets are highlighted by name only
  
  // Draw pie charts
  const totalFleetFee = sortedFleets.reduce((sum, [_, data]) => sum + (data.totalFee || 0), 0);
  drawPieChart('fleetChart', 'fleetLegend', sortedFleets.map(([name, data], index) => ({
    label: fleetNames[name] || name,
    value: data.totalFee,
    count: data.totalOperations,
    percentage: totalFleetFee ? ((data.totalFee / totalFleetFee) * 100) : 0,
    color: fleetColors[index]
  })), window.prices);

  drawPieChart('operationChart', 'operationLegend', sortedOps.map(([name, data], index) => ({
    label: name,
    value: data.totalFee,
    count: data.count,
    percentage: data.totalFee / (sageFees24h || 1),
    color: opColors[index]
  })), window.prices);
  
  console.log('Results displayed successfully');
}

function createFleetList(data, fleetNames, rentedFleetNames = new Set()) {
  const fleetListDiv = document.getElementById('fleetList');
  // Normalize rented fleet names for case-insensitive matching
  const rentedLc = new Set(Array.from(rentedFleetNames).map(n => (n || '').toString().toLowerCase()));
  
  // List of category names to exclude from Fleet Breakdown
  const categories = [
    'Starbase Operations',
    'Configuration',
    'Cargo Management',
    'Crew Management',
    'Survey & Discovery',
    'Player Profile',
    'Fleet Rentals',
    'Universe Management',
    'Game Management',
    'Other Operations'
  ];
  
  // Filter out categories, keep only actual fleets
  const sortedFleets = Object.entries(data.feesByFleet)
    .filter(([fleetAccount, fleetData]) => !categories.includes(fleetAccount))
    .sort((a, b) => {
      const aRented = !!(a[1].isRented || rentedLc.has((fleetNames[a[0]] || a[0] || '').toString().toLowerCase()));
      const bRented = !!(b[1].isRented || rentedLc.has((fleetNames[b[0]] || b[0] || '').toString().toLowerCase()));
      // Rented fleets first
      if (aRented && !bRented) return -1;
      if (!aRented && bRented) return 1;
      // Then by total fee
      return b[1].totalFee - a[1].totalFee;
    });
  
  let html = '';
  sortedFleets.forEach(([fleetAccount, fleetData]) => {
    const fleetName = fleetNames[fleetAccount] || fleetAccount;
    const fleetId = 'fleet-' + fleetAccount.substring(0, 8);
    const isRented = !!(fleetData.isRented || rentedLc.has((fleetName || '').toString().toLowerCase()));
    
    // Debug: log first 3 fleets to verify rental detection
    if (sortedFleets.indexOf([fleetAccount, fleetData]) < 3) {
      console.log(`Fleet ${fleetName}: fleetData.isRented=${fleetData.isRented}, in rentedLc=${rentedLc.has((fleetName || '').toString().toLowerCase())}, isRented=${isRented}`);
    }
    
    const nameClass = isRented ? 'fleet-name rented-name' : 'fleet-name';
    const nameInner = isRented
      ? `<span class="rented-name" style="color:#fbbf24;font-weight:800">${fleetName}</span>`
      : `${fleetName}`;
    
    html += `
      <div class="fleet-item" onclick="toggleFleet('${fleetId}')">
        <div class="fleet-header">
          <div class="${nameClass}">${nameInner}</div>
          <div class="fleet-ops">${fleetData.totalOperations} ops</div>
          <div class="fleet-pct">${((fleetData.totalFee / (data.sageFees24h || 1)) * 100).toFixed(1)}%</div>
            <div class="fleet-sol">${(fleetData.totalFee / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((fleetData.totalFee / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></div>
        </div>
        <div class="fleet-details" id="${fleetId}">
          <table class="fleet-ops-table">
    `;
    
    // Raggruppa operazioni di crafting in due categorie: Craft Fuel e Craft Food
    // (ora già fatto dal backend, basta filtrarle)
    const ops = Object.entries(fleetData.operations);
    const isCraftingCategory = fleetAccount === 'Crafting Operations';

    // Mostra altre operazioni non-crafting
    ops.sort((a, b) => b[1].totalFee - a[1].totalFee).forEach(([op, stats]) => {
      
      // Render operation summary row for non-crafting fleets
      if (!isCraftingCategory) {
        html += `
          <tr>
            <td>${op}</td>
            <td>${stats.count}x</td>
            <td>${stats.percentageOfFleet.toFixed(1)}%</td>
            <td>${(stats.totalFee / 1e9).toFixed(6)} SOL</td>
            <td style="color:#7dd3fc;font-size:13px;">$${window.prices && window.prices.solana ? ((stats.totalFee / 1e9) * window.prices.solana.usd).toFixed(2) : '--'}</td>
          </tr>
        `;
      }
      
      // Se è Crafting Operations o se l'operazione ha dettagli, mostra i dettagli
      if (stats.details && Array.isArray(stats.details) && stats.details.length > 0) {
        const maxDetails = 50;
        html += `
          <tr>
            <td colspan="5">
              <div class="op-details" style="padding-top:6px;">
                <table class="fleet-ops-table">
                  <tbody>
        `;
        html += renderCraftingDetailsRows(stats.details, maxDetails);
        html += `
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        `;
      }
    });
    
    html += `
          </table>
        </div>
      </div>
    `;
  });
  
  fleetListDiv.innerHTML = html;
}

function createOperationList(data, fleetNames, rentedFleetNames = new Set()) {
  const operationListDiv = document.getElementById('operationList');
  const rentedLc = new Set(Array.from(rentedFleetNames).map(n => (n || '').toString().toLowerCase()));
  
  // Build a map of operation -> list of fleets with that operation
  const operationFleetMap = {};
  
  Object.entries(data.feesByFleet).forEach(([fleetAccount, fleetData]) => {
    const fleetName = fleetNames[fleetAccount] || fleetAccount;
    const isRented = !!(fleetData.isRented || rentedLc.has((fleetName || '').toString().toLowerCase()));
    
    Object.entries(fleetData.operations || {}).forEach(([opName, opStats]) => {
      if (!operationFleetMap[opName]) {
        operationFleetMap[opName] = [];
      }
      operationFleetMap[opName].push({
        fleetAccount,
        fleetName,
        isRented,
        count: opStats.count,
        totalFee: opStats.totalFee,
        percentageOfFleet: opStats.percentageOfFleet
      });
    });
  });
  
  // Sort operations by total fee (from data.feesByOperation)
  // Mostra anche le Crafting Operations per dettaglio
  const sortedOperations = Object.entries(data.feesByOperation)
    .sort((a, b) => b[1].totalFee - a[1].totalFee);
  
  let html = '';
  sortedOperations.forEach(([operation, opStats]) => {
    const opId = 'op-' + operation.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20);
    const fleets = operationFleetMap[operation] || [];
    
    // Sort fleets by total fee for this operation (descending)
    fleets.sort((a, b) => b.totalFee - a.totalFee);
    
    // Calculate percentage of total fees for this operation
    const opPercentage = (opStats.totalFee / data.sageFees24h) * 100;
    
    html += `
      <div class="fleet-item" onclick="toggleFleet('${opId}')">
        <div class="fleet-header">
          <div class="fleet-name">${operation}</div>
          <div class="fleet-ops">${opStats.count} ops</div>
          <div class="fleet-pct">${opPercentage.toFixed(1)}%</div>
            <div class="fleet-sol">${(opStats.totalFee / 1e9).toFixed(6)} SOL <span style="color:#7dd3fc;font-size:13px;">($${window.prices && window.prices.solana ? ((opStats.totalFee / 1e9) * window.prices.solana.usd).toFixed(2) : '--'})</span></div>
        </div>
        <div class="fleet-details" id="${opId}">
          <table class="fleet-ops-table">
    `;
    
    // For Crafting operation, skip fleet summary row and go directly to details
    const isCrafting = /craft/i.test(operation);
    
    if (!isCrafting) {
      fleets.forEach(fleet => {
        const nameClass = fleet.isRented ? 'rented-name' : '';
        const nameStyle = fleet.isRented ? 'color:#fbbf24;font-weight:800' : '';
        const fleetNameHtml = fleet.isRented
          ? `<span class="${nameClass}" style="${nameStyle}">${fleet.fleetName}</span>`
          : fleet.fleetName;
        
        // Calculate percentage of this operation's fees from this fleet
        const fleetOpPercentage = (fleet.totalFee / opStats.totalFee) * 100;
        
        html += `
          <tr>
            <td>${fleetNameHtml}</td>
            <td>${fleet.count}x</td>
            <td>${fleetOpPercentage.toFixed(1)}%</td>
            <td>${(fleet.totalFee / 1e9).toFixed(6)} SOL</td>
            <td style="color:#7dd3fc;font-size:13px;">$${window.prices && window.prices.solana ? ((fleet.totalFee / 1e9) * window.prices.solana.usd).toFixed(2) : '--'}</td>
          </tr>
        `;
      });
    }

    // If the operation carries per-transaction details (e.g., crafting details), render them
    try {
      if (opStats.details && Array.isArray(opStats.details) && opStats.details.length > 0) {
        console.log(`[createOperationList] operation=${operation} has details count=${opStats.details.length}`);
        // Limit details shown to avoid overly long pages; show first 50 and indicate more
        const maxDetails = 50;
        html += `
          <tr>
            <td colspan="5">
              <div class="op-details" style="padding-top:6px;">
                <table class="fleet-ops-table">
                  <tbody>
        `;
        html += renderCraftingDetailsRows(opStats.details, maxDetails);
        html += `
                  </tbody>
                </table>
              </div>
            </td>
          </tr>
        `;
      }
    } catch (err) {
      console.warn('[createOperationList] could not render op details', err);
    }

    html += `
          </table>
        </div>
      </div>
    `;
  });
  
  operationListDiv.innerHTML = html;
}

function toggleFleet(fleetId) {
  const fleetItem = document.getElementById(fleetId).parentElement;
  fleetItem.classList.toggle('expanded');
}

function drawPieChart(canvasId, legendId, data, prices) {
  console.log(`Drawing pie chart: ${canvasId}`, data);
  const canvas = document.getElementById(canvasId);
  const legend = document.getElementById(legendId);

  // Destroy previous chart instance if exists
  if (canvas._chartInstance) {
    canvas._chartInstance.destroy();
    canvas._chartInstance = null;
  }

  // Prepare data for Chart.js
  const chartData = {
    labels: data.map(item => item.label),
    datasets: [{
      data: data.map(item => item.value),
      backgroundColor: data.map(item => item.color),
      borderWidth: 1
    }]
  };

  // Create pie chart
  const chartInstance = new Chart(canvas, {
    type: 'pie',
    data: chartData,
    options: {
      responsive: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          // Show only color swatch + percentage (no title, no label name)
          displayColors: true,
          callbacks: {
            title: function() {
              return '';
            },
            label: function(context) {
              try {
                const dataset = context.dataset;
                const value = context.raw || dataset.data[context.dataIndex] || 0;
                const total = dataset.data.reduce((s, v) => s + (Number(v) || 0), 0);
                const pct = total ? ((Number(value) / total) * 100).toFixed(1) + '%' : '0.0%';
                return `${pct}`;
              } catch (e) {
                return '';
              }
            }
          }
        }
      }
    }
  });
  canvas._chartInstance = chartInstance;

  // Calculate total value for percentage
  const total = data.reduce((sum, item) => sum + item.value, 0);
  // Create legend with format: Nome | Ops | % | SOL
  let legendHtml = '<table>';
  data.forEach((item, index) => {
    const percentage = total ? ((item.value / total) * 100).toFixed(1) : '0.0';
    const solValue = (item.value / 1e9).toFixed(6);
    legendHtml += `
      <tr>
        <td><div style="width: 8px; height: 8px; background: ${item.color}; border-radius: 1px;"></div></td>
        <td>${item.label}</td>
        <td>${item.count} ops</td>
        <td>${percentage}%</td>
        <td>${solValue} SOL <span style="color:#7dd3fc;font-size:13px;">($${prices && prices.solana ? ((item.value / 1e9) * prices.solana.usd).toFixed(2) : '--'})</span></td>
      </tr>
    `;
  });
  legendHtml += '</table>';
  legend.innerHTML = legendHtml;
}


function renderPriceTicker(prices) {
  const ticker = document.getElementById('price-ticker-content');
  if (!ticker) return;

  // Asset config: symbol, CoinGecko id, SVG icon URL
  const assets = [
    { symbol: 'BTC', id: 'bitcoin', icon: 'https://assets.coingecko.com/coins/images/1/large/bitcoin.png' },
    { symbol: 'SOL', id: 'solana', icon: 'https://assets.coingecko.com/coins/images/4128/large/solana.png' },
    { symbol: 'ATLAS', id: 'star-atlas', icon: 'https://assets.coingecko.com/coins/images/17659/standard/Icon_Reverse.png?1696517190' },
    { symbol: 'POLIS', id: 'star-atlas-dao', icon: 'https://assets.coingecko.com/coins/images/17789/standard/POLIS.jpg?1696517312' },
    { symbol: 'WPAC', id: 'wpac', icon: 'https://www.geckoterminal.com/_next/image?url=https%3A%2F%2Fassets.geckoterminal.com%2Fujk203lxsmobneroynh7hfyqhabo&w=128&q=75' },
  ];

  // Calculate item width so 4 out of 5 are always visible and fill the bar
  const barWidth = document.getElementById('price-ticker-bar').offsetWidth;
  const itemWidth = Math.floor(barWidth / 4);

  // Build ticker items
  let itemsHtml = '';
  assets.forEach(asset => {
    let price = '--';
    if (prices && prices[asset.id] && prices[asset.id].usd !== undefined && prices[asset.id].usd !== '--') {
      price = prices[asset.id].usd;
      if (asset.symbol === 'BTC') {
        price = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      } else if (asset.symbol === 'SOL') {
        price = price.toFixed(2);
      } else {
        price = price.toFixed(4);
      }
    }
    let iconUrl = asset.icon;
    itemsHtml += `
      <div class="ticker-item" style="display:flex;align-items:center;gap:8px;min-width:${itemWidth}px;max-width:${itemWidth}px;justify-content:center;">
        <img src="${iconUrl}" alt="${asset.symbol}" style="width:22px;height:22px;vertical-align:middle;" onerror="this.style.opacity=0.3;">
        <span style="font-weight:600;letter-spacing:1px;">${asset.symbol}</span>
        <span style="font-size:15px;color:#e2e8f0;">$${price}</span>
      </div>
    `;
  });

  // Duplicate items for seamless loop
  ticker.innerHTML = itemsHtml + itemsHtml;
  ticker.style.display = 'flex';
}
