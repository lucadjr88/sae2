import { Program } from '@project-serum/anchor';
import BN from 'bn.js';
import { PublicKey } from "@solana/web3.js";
import bs58 from 'bs58';
import { byteArrayToString, readAllFromRPC } from "@staratlas/data-source";
import { SAGE_IDL, Starbase, StarbasePlayer, Ship } from "@staratlas/sage";
import { newConnection, newAnchorProvider } from '../utils/anchor-setup.js';
import { loadKeypair } from '../utils/wallet-setup.js';
const SAGE_PROGRAM_ID = 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE';
const SAGE_GAME_ID = 'GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr';
export async function getShipsForFleet(rpcEndpoint, rpcWebsocket, walletPath, profileId, x, y) {
    const connection = newConnection(rpcEndpoint, rpcWebsocket);
    const wallet = loadKeypair(walletPath);
    const provider = newAnchorProvider(connection, wallet);
    const sageProgram = new Program(SAGE_IDL, SAGE_PROGRAM_ID, provider);
    const gamePubkey = new PublicKey(SAGE_GAME_ID);
    const profilePubkey = new PublicKey(profileId);
    const xBN = new BN(x);
    const yBN = new BN(y);
    const xArr = xBN.toTwos(64).toArrayLike(Buffer, 'le', 8);
    const yArr = yBN.toTwos(64).toArrayLike(Buffer, 'le', 8);
    const x58 = bs58.encode(xArr);
    const y58 = bs58.encode(yArr);
    const starbases = await readAllFromRPC(connection, sageProgram, Starbase, 'processed', [
        { memcmp: { offset: 73, bytes: gamePubkey.toBase58() } },
        { memcmp: { offset: 113, bytes: x58 } },
        { memcmp: { offset: 121, bytes: y58 } },
    ]);
    if (starbases.length === 0) {
        throw new Error('No starbase found at these coordinates');
    }
    const starbaseKey = starbases[0].key;
    const starbasePlayers = await readAllFromRPC(connection, sageProgram, StarbasePlayer, 'processed', [
        { memcmp: { offset: 9, bytes: starbaseKey.toBase58() } },
        { memcmp: { offset: 41, bytes: profilePubkey.toBase58() } },
    ]);
    if (starbasePlayers.length === 0) {
        return [];
    }
    const starbasePlayerKey = starbasePlayers[0].key;
    const ships = await readAllFromRPC(connection, sageProgram, Ship, 'processed', [
        { memcmp: { offset: 41, bytes: starbasePlayerKey.toBase58() } },
    ]);
    const result = [];
    for (const ship of ships) {
        if (ship.type !== 'ok')
            continue;
        const data = ship.data.data;
        const state = data.state;
        if (state && 'StarbaseLoadingBay' in state) {
            result.push({
                name: byteArrayToString(data.name),
                mint: data.mint.toString(),
                quantity: state.StarbaseLoadingBay.shipQuantityInEscrow.toString()
            });
        }
    }
    return result;
}
