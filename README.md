# SA Explorer - Moduli & Utilizzo

## Moduli Principali
- **Backend**: Node.js, Express.js, TypeScript
- **Blockchain**: Solana Web3.js, Star Atlas SAGE SDK
- **Frontend**: Vanilla JS, HTML5, CSS3

## Dipendenze Core
- `@staratlas/sage`, `@staratlas/data-source`, `@staratlas/player-profile`, `@solana/web3.js`, `@project-serum/anchor`, `express`

## Quick Start
1. Installa dipendenze: `npm install`
2. Build: `npm run build`
3. Avvia: `npm start`

## Funzionalità
- Analisi flotte, fees SAGE, rental detection, report visuali, dati real-time.

---

# star-atlas-decoders-main - Moduli & Utilizzo

## Decoder Principali (Rust crates)
- **sage-starbased-decoder**
- **sage-holosim-decoder**
- **atlas-staking-decoder**
- **crafting-decoder**
- **crew-decoder**
- **marketplace-decoder**
- **player-profile-decoder**
- **points-decoder**
- **profile-faction-decoder**
- **profile-vault-decoder**
- **srsly-decoder**
- **tcomp-decoder**

## Utilizzo
- Ogni decoder è un crate Rust: build con `cargo build`, usabile come binario o libreria.
- Integra nei tuoi tool per decodifica account/instruction Star Atlas.

---

# staratlas-utility-master - Moduli & Utilizzo

## Moduli Principali (TypeScript)
- **constants**: Program IDs, mint, enums
- **types**: Tipi TypeScript
- **utils**: Utility generiche
- **rpc**: RPC pool management
- **transactions**: Transaction builder
- **sage-queries**: Query helper SAGE
- **sage-mechanics**: Calcoli movimento/mining
- **fleet/resources/starbase**: Gestione flotte, risorse, starbase

## Installazione
```bash
npm install @solana/web3.js
cp -r lib/ your-project/lib/
```

## Esempio d'Uso
```typescript
import { RPCPool, queryFleetsByOwner } from './lib';
const pool = new RPCPool([...]);
const connection = await pool.getConnection();
const fleets = await queryFleetsByOwner(connection, gameId, ownerProfilePubkey);
```

---

# star-atlas-cookbook - Moduli & Utilizzo

## Contenuto
- Esempi pratici per wallet, game, fleets, planets, player profile, server, ecc.
- Script per generazione keypair, runner, integrazione moduli utility/master.

## Come usare
- Consulta `MODULI_E_UTILIZZO.md` per guida moduli utility/master.
- Esegui script in `examples/` per testare casi d'uso reali.

---

**Nota:** Tutti i progetti sono modulari e integrabili. Consulta i file README o MODULI_E_UTILIZZO.md di ciascun progetto per dettagli su parametri, tipi e funzioni.