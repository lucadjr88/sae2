/**
 * Universal Decoder for Star Atlas Programs
 * Supports:
 * - Crafting Program
 * - SAGE Starbased Program
 * - SAGE Holosim Program
 * 
 * This decoder integrates with the official Carbon decoders via Rust binary
 */

import { decodeAccountWithRust } from './rust-wrapper.js';

// Program IDs
const CRAFTING_PROGRAM = 'CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5';
const SAGE_STARBASED_PROGRAM = 'SAGEQbkxz47ynfSeJ2cgvhy26yEQ6w57RPUAGuk76a1';
const SAGE_HOLOSIM_PROGRAM = 'HSim1111111111111111111111111111111111111111';

// Mapping of SAGE Starbased instruction names to human-readable types
const SAGE_STARBASED_INSTRUCTIONS = {
  // Crafting operations
  'CreateCraftingProcess': {
    program: 'SAGE-Starbased',
    instructionType: 'CreateCraftingProcess',
    name: 'Start Crafting',
    category: 'crafting',
    description: 'Initialize a new crafting process'
  },
  'StartCraftingProcess': {
    program: 'SAGE-Starbased',
    instructionType: 'StartCraftingProcess',
    name: 'Start Crafting Process',
    category: 'crafting',
    description: 'Activate a crafting process'
  },
  'StopCraftingProcess': {
    program: 'SAGE-Starbased',
    instructionType: 'StopCraftingProcess',
    name: 'Stop Crafting',
    category: 'crafting',
    description: 'Halt an active crafting process'
  },
  'CancelCraftingProcess': {
    program: 'SAGE-Starbased',
    instructionType: 'CancelCraftingProcess',
    name: 'Cancel Crafting',
    category: 'crafting',
    description: 'Cancel a crafting process'
  },
  'CloseCraftingProcess': {
    program: 'SAGE-Starbased',
    instructionType: 'CloseCraftingProcess',
    name: 'Close Crafting',
    category: 'crafting',
    description: 'Close a completed crafting process'
  },
  'ClaimCraftingOutputs': {
    program: 'SAGE-Starbased',
    instructionType: 'ClaimCraftingOutputs',
    name: 'Claim Crafting Outputs',
    category: 'crafting',
    description: 'Claim crafted items'
  },
  'ClaimCraftingNonConsumables': {
    program: 'SAGE-Starbased',
    instructionType: 'ClaimCraftingNonConsumables',
    name: 'Claim Crafting Non-Consumables',
    category: 'crafting',
    description: 'Claim non-consumable crafting materials'
  },
  'BurnCraftingConsumables': {
    program: 'SAGE-Starbased',
    instructionType: 'BurnCraftingConsumables',
    name: 'Burn Consumables',
    category: 'crafting',
    description: 'Consume materials for crafting'
  },
  'DepositCraftingIngredient': {
    program: 'SAGE-Starbased',
    instructionType: 'DepositCraftingIngredient',
    name: 'Deposit Crafting Ingredient',
    category: 'crafting',
    description: 'Add ingredient to crafting process'
  },
  'WithdrawCraftingIngredient': {
    program: 'SAGE-Starbased',
    instructionType: 'WithdrawCraftingIngredient',
    name: 'Withdraw Crafting Ingredient',
    category: 'crafting',
    description: 'Remove ingredient from crafting'
  },

  // Mining operations
  'StartMiningAsteroid': {
    program: 'SAGE-Starbased',
    instructionType: 'StartMiningAsteroid',
    name: 'Start Mining',
    category: 'mining',
    description: 'Begin mining asteroids'
  },
  'StopMiningAsteroid': {
    program: 'SAGE-Starbased',
    instructionType: 'StopMiningAsteroid',
    name: 'Stop Mining',
    category: 'mining',
    description: 'Stop mining asteroids'
  },
  'MineAsteroidToRespawn': {
    program: 'SAGE-Starbased',
    instructionType: 'MineAsteroidToRespawn',
    name: 'Mine to Respawn',
    category: 'mining',
    description: 'Mine and respawn'
  },
  'ScanForSurveyDataUnits': {
    program: 'SAGE-Starbased',
    instructionType: 'ScanForSurveyDataUnits',
    name: 'Scan for Survey Data',
    category: 'mining',
    description: 'Scan for survey data units'
  },

  // Fleet operations
  'CreateFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'CreateFleet',
    name: 'Create Fleet',
    category: 'fleet',
    description: 'Create a new fleet'
  },
  'DisbandFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'DisbandFleet',
    name: 'Disband Fleet',
    category: 'fleet',
    description: 'Disband a fleet'
  },
  'AddShipToFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'AddShipToFleet',
    name: 'Add Ship to Fleet',
    category: 'fleet',
    description: 'Add a ship to a fleet'
  },
  'RemoveShipEscrow': {
    program: 'SAGE-Starbased',
    instructionType: 'RemoveShipEscrow',
    name: 'Remove Ship Escrow',
    category: 'fleet',
    description: 'Remove ship from escrow'
  },
  'LoadFleetCrew': {
    program: 'SAGE-Starbased',
    instructionType: 'LoadFleetCrew',
    name: 'Load Fleet Crew',
    category: 'fleet',
    description: 'Load crew into fleet'
  },
  'UnloadFleetCrew': {
    program: 'SAGE-Starbased',
    instructionType: 'UnloadFleetCrew',
    name: 'Unload Fleet Crew',
    category: 'fleet',
    description: 'Unload crew from fleet'
  },

  // Cargo operations
  'DepositCargoToFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'DepositCargoToFleet',
    name: 'Deposit Cargo to Fleet',
    category: 'cargo',
    description: 'Add cargo to fleet'
  },
  'WithdrawCargoFromFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'WithdrawCargoFromFleet',
    name: 'Withdraw Cargo from Fleet',
    category: 'cargo',
    description: 'Remove cargo from fleet'
  },
  'TransferCargoWithinFleet': {
    program: 'SAGE-Starbased',
    instructionType: 'TransferCargoWithinFleet',
    name: 'Transfer Cargo Within Fleet',
    category: 'cargo',
    description: 'Transfer cargo between fleet vessels'
  },
  'DepositCargoToGame': {
    program: 'SAGE-Starbased',
    instructionType: 'DepositCargoToGame',
    name: 'Deposit Cargo to Game',
    category: 'cargo',
    description: 'Deposit cargo into game'
  },
  'WithdrawCargoFromGame': {
    program: 'SAGE-Starbased',
    instructionType: 'WithdrawCargoFromGame',
    name: 'Withdraw Cargo from Game',
    category: 'cargo',
    description: 'Withdraw cargo from game'
  },

  // Warp/Movement operations
  'StartSubwarp': {
    program: 'SAGE-Starbased',
    instructionType: 'StartSubwarp',
    name: 'Start Subwarp',
    category: 'movement',
    description: 'Begin subwarp travel'
  },
  'StopSubwarp': {
    program: 'SAGE-Starbased',
    instructionType: 'StopSubwarp',
    name: 'Stop Subwarp',
    category: 'movement',
    description: 'Stop subwarp travel'
  },
  'WarpToCoordinate': {
    program: 'SAGE-Starbased',
    instructionType: 'WarpToCoordinate',
    name: 'Warp to Coordinate',
    category: 'movement',
    description: 'Warp to a specific coordinate'
  },
  'WarpLane': {
    program: 'SAGE-Starbased',
    instructionType: 'WarpLane',
    name: 'Warp Lane',
    category: 'movement',
    description: 'Use warp lane'
  },

  // Starbase operations
  'RegisterStarbase': {
    program: 'SAGE-Starbased',
    instructionType: 'RegisterStarbase',
    name: 'Register Starbase',
    category: 'starbase',
    description: 'Register a new starbase'
  },
  'DeregisterStarbase': {
    program: 'SAGE-Starbased',
    instructionType: 'DeregisterStarbase',
    name: 'Deregister Starbase',
    category: 'starbase',
    description: 'Deregister a starbase'
  },
  'StartStarbaseUpgrade': {
    program: 'SAGE-Starbased',
    instructionType: 'StartStarbaseUpgrade',
    name: 'Start Starbase Upgrade',
    category: 'starbase',
    description: 'Initiate starbase upgrade'
  },
  'CompleteStarbaseUpgrade': {
    program: 'SAGE-Starbased',
    instructionType: 'CompleteStarbaseUpgrade',
    name: 'Complete Starbase Upgrade',
    category: 'starbase',
    description: 'Finish starbase upgrade'
  },
  'TransferCargoAtStarbase': {
    program: 'SAGE-Starbased',
    instructionType: 'TransferCargoAtStarbase',
    name: 'Transfer Cargo at Starbase',
    category: 'starbase',
    description: 'Transfer cargo at starbase'
  },
  'DepositStarbaseUpkeepResource': {
    program: 'SAGE-Starbased',
    instructionType: 'DepositStarbaseUpkeepResource',
    name: 'Deposit Upkeep Resource',
    category: 'starbase',
    description: 'Deposit starbase upkeep resource'
  },

  // Fleet state transitions
  'IdleToLoadingBay': {
    program: 'SAGE-Starbased',
    instructionType: 'IdleToLoadingBay',
    name: 'Idle to Loading Bay',
    category: 'fleet-state',
    description: 'Move fleet from idle to loading bay'
  },
  'LoadingBayToIdle': {
    program: 'SAGE-Starbased',
    instructionType: 'LoadingBayToIdle',
    name: 'Loading Bay to Idle',
    category: 'fleet-state',
    description: 'Move fleet from loading bay to idle'
  },
  'IdleToRespawn': {
    program: 'SAGE-Starbased',
    instructionType: 'IdleToRespawn',
    name: 'Idle to Respawn',
    category: 'fleet-state',
    description: 'Move fleet from idle to respawn'
  },
  'RespawnToLoadingBay': {
    program: 'SAGE-Starbased',
    instructionType: 'RespawnToLoadingBay',
    name: 'Respawn to Loading Bay',
    category: 'fleet-state',
    description: 'Move fleet from respawn to loading bay'
  },

  // Profile/Registration
  'RegisterSagePlayerProfile': {
    program: 'SAGE-Starbased',
    instructionType: 'RegisterSagePlayerProfile',
    name: 'Register Player Profile',
    category: 'profile',
    description: 'Register a SAGE player profile'
  },
  'MintCrewToGame': {
    program: 'SAGE-Starbased',
    instructionType: 'MintCrewToGame',
    name: 'Mint Crew',
    category: 'profile',
    description: 'Mint crew to game'
  },
  'AddCrewToGame': {
    program: 'SAGE-Starbased',
    instructionType: 'AddCrewToGame',
    name: 'Add Crew to Game',
    category: 'profile',
    description: 'Add crew to game account'
  },

  // Default for unknown instructions
  'Unknown': {
    program: 'SAGE-Starbased',
    instructionType: 'Unknown',
    name: 'Unknown Operation',
    category: 'unknown',
    description: 'Unknown SAGE operation'
  }
};

// Map crafting instruction types
const CRAFTING_INSTRUCTIONS = {
  'StartCraftingProcess': {
    program: 'Crafting',
    instructionType: 'StartCraftingProcess',
    name: 'Start Crafting',
    category: 'crafting',
    description: 'Start a crafting process'
  },
  'StopCraftingProcess': {
    program: 'Crafting',
    instructionType: 'StopCraftingProcess',
    name: 'Stop Crafting',
    category: 'crafting',
    description: 'Stop crafting process'
  },
  'CreateCraftingProcess': {
    program: 'Crafting',
    instructionType: 'CreateCraftingProcess',
    name: 'Create Crafting',
    category: 'crafting',
    description: 'Create a crafting process'
  },
  'CancelCraftingProcess': {
    program: 'Crafting',
    instructionType: 'CancelCraftingProcess',
    name: 'Cancel Crafting',
    category: 'crafting',
    description: 'Cancel crafting process'
  },
  'CloseCraftingProcess': {
    program: 'Crafting',
    instructionType: 'CloseCraftingProcess',
    name: 'Close Crafting',
    category: 'crafting',
    description: 'Close crafting process'
  },
  'ClaimRecipeOutput': {
    program: 'Crafting',
    instructionType: 'ClaimRecipeOutput',
    name: 'Claim Recipe Output',
    category: 'crafting',
    description: 'Claim crafted output'
  },
  'BurnConsumableIngredient': {
    program: 'Crafting',
    instructionType: 'BurnConsumableIngredient',
    name: 'Burn Consumable',
    category: 'crafting',
    description: 'Burn consumable ingredient'
  },
  'ClaimNonConsumableIngredient': {
    program: 'Crafting',
    instructionType: 'ClaimNonConsumableIngredient',
    name: 'Claim Non-Consumable',
    category: 'crafting',
    description: 'Claim non-consumable ingredient'
  }
};

/**
 * Decode a SAGE or Crafting instruction by examining log messages
 * This is a heuristic decoder that looks for instruction names in log messages
 */
export function decodeInstructionFromLogs(logMessages) {
  for (const log of logMessages) {
    // Look for instruction names in logs
    // Format: "Instruction: InstructionName"
    const ixMatch = log.match(/Instruction:\s*(\w+)/i);
    if (ixMatch) {
      const ixName = ixMatch[1];
      // Check SAGE Starbased
      if (SAGE_STARBASED_INSTRUCTIONS[ixName]) {
        return SAGE_STARBASED_INSTRUCTIONS[ixName];
      }
      // Check Crafting
      if (CRAFTING_INSTRUCTIONS[ixName]) {
        return CRAFTING_INSTRUCTIONS[ixName];
      }
    }

    // Look for specific patterns
    if (/StartCraftingProcess|CreateCraftingProcess/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['CreateCraftingProcess'];
    }
    if (/StopCraftingProcess|CloseCraftingProcess/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['StopCraftingProcess'];
    }
    if (/ClaimCraftingOutputs/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['ClaimCraftingOutputs'];
    }
    if (/StartMiningAsteroid/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['StartMiningAsteroid'];
    }
    if (/StopMiningAsteroid/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['StopMiningAsteroid'];
    }
    if (/WarpToCoordinate|WarpLane/i.test(log)) {
      return SAGE_STARBASED_INSTRUCTIONS['WarpToCoordinate'];
    }
  }
  
  return undefined;
}

/**
 * Extract a material type from instruction name or log
 */
export function extractMaterialType(instruction, logs) {
  if (!instruction) return undefined;

  // Check instruction name for material hints
  const ixName = instruction.name.toLowerCase();
  if (/ore/i.test(ixName)) return 'Ore';
  if (/fuel/i.test(ixName)) return 'Fuel';
  if (/food/i.test(ixName)) return 'Food';
  if (/ammo/i.test(ixName)) return 'Ammo';
  if (/tool/i.test(ixName)) return 'Tool';
  if (/component/i.test(ixName)) return 'Component';

  // Check logs if provided
  if (logs) {
    const logStr = logs.join(' ').toLowerCase();
    if (/ore/i.test(logStr)) return 'Ore';
    if (/fuel/i.test(logStr)) return 'Fuel';
    if (/food/i.test(logStr)) return 'Food';
    if (/ammo/i.test(logStr)) return 'Ammo';
    if (/tool/i.test(logStr)) return 'Tool';
    if (/component/i.test(logStr)) return 'Component';
  }

  return undefined;
}

/**
 * Decode an account using the Rust binary
 */
export async function decodeAccount(data) {
  try {
    return decodeAccountWithRust(data);
  } catch (e) {
    return null;
  }
}

export {
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS
};

export default {
  decodeInstructionFromLogs,
  extractMaterialType,
  decodeAccount,
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS
};