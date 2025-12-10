import { Program } from '@project-serum/anchor';
import BN from 'bn.js';
import { PublicKey } from "@solana/web3.js";
import bs58 from 'bs58';
import { byteArrayToString, readAllFromRPC, readFromRPC } from "@staratlas/data-source";
import { MineItem, Planet, Resource, SAGE_IDL } from "@staratlas/sage";
import { newConnection, newAnchorProvider } from '../utils/anchor-setup.js';
import { loadKeypair } from '../utils/wallet-setup.js';
const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
const SAGE_GAME_ID = 'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr';
export async function getPlanets(rpcEndpoint, rpcWebsocket, walletPath, x, y) {
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    const wallet = loadKeypair(walletPath);
    const provider = newAnchorProvider(connection, wallet);
    const sageProgram = new Program(SAGE_IDL, SAGE_PROGRAM_ID, provider);
    const gamePubkey = new PublicKey(SAGE_GAME_ID);
    const xBN = new BN(x);
    const yBN = new BN(y);
    const xArr = xBN.toTwos(64).toArrayLike(Buffer, 'le', 8);
    const yArr = yBN.toTwos(64).toArrayLike(Buffer, 'le', 8);
    const x58 = bs58.encode(xArr);
    const y58 = bs58.encode(yArr);
    const planets = await readAllFromRPC(connection, sageProgram, Planet, 'processed', [
        { memcmp: { offset: 73, bytes: gamePubkey.toBase58() } },
        { memcmp: { offset: 105, bytes: x58 } },
        { memcmp: { offset: 113, bytes: y58 } },
    ]);
    if (planets.length === 0) {
        throw new Error('No planets found');
    }
    const result = [];
    for (const planet of planets) {
        if (planet.type !== 'ok')
            continue;
        const data = planet.data.data;
        if (data.numResources >= 1) {
            const planetInfo = {
                name: byteArrayToString(data.name),
                location: planet.key.toString(),
                miners: data.numMiners,
                numResources: data.numResources,
                resources: []
            };
            const resources = await readAllFromRPC(connection, sageProgram, Resource, 'processed', [
                { memcmp: { offset: 9, bytes: gamePubkey.toBase58() } },
                { memcmp: { offset: 41, bytes: planet.key.toBase58() } },
            ]);
            for (const resource of resources) {
                if (resource.type !== 'ok')
                    continue;
                const resourceData = resource.data.data;
                const mineItem = await readFromRPC(connection, sageProgram, resourceData.mineItem, MineItem, 'processed');
                if (mineItem.type !== 'ok')
                    continue;
                const mineItemData = mineItem.data.data;
                planetInfo.resources.push({
                    name: byteArrayToString(mineItemData.name),
                    mint: mineItemData.mint.toString(),
                    systemRichness: resourceData.systemRichness.toString(),
                    hardness: mineItemData.resourceHardness.toString(),
                    miners: resourceData.numMiners
                });
            }
            result.push(planetInfo);
        }
    }
    return result;
}
