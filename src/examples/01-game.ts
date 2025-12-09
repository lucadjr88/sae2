import { Program } from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";
import { readAllFromRPC } from "@staratlas/data-source";
import { Game, SAGE_IDL } from "@staratlas/sage";
import { newConnection, newAnchorProvider } from '../utils/anchor-setup.js';
import { loadKeypair } from '../utils/wallet-setup.js';

const SAGE_PROGRAM_ID = "SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE";

export async function getGameInfo(rpcEndpoint: string, rpcWebsocket: string, walletPath: string) {
  const connection = newConnection(rpcEndpoint, rpcWebsocket);
  const wallet = loadKeypair(walletPath);
  const provider = newAnchorProvider(connection, wallet);

  const sageProgram = new Program(SAGE_IDL, SAGE_PROGRAM_ID, provider);

  const games = await readAllFromRPC(
    connection,
    sageProgram as any,
    Game,
    'processed',
    [],
  );

  if (games.length === 0) {
    throw new Error('No game found');
  }

  const [game] = games;
  if (game.type !== 'ok') {
    throw new Error('Failed to load game data');
  }
  
  return {
    gameId: game.key.toString(),
    game: game.data
  };
}
