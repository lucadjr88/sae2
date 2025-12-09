#!/usr/bin/env node

/**
 * Test script for universal decoder
 * Tests all major SAGE and Crafting instruction types
 */

import { 
  decodeInstructionFromLogs, 
  extractMaterialType,
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS 
} from './universal-decoder.js';

console.log('=== Universal Decoder Test ===\n');

// Test data: instruction names with their expected categories
const testCases = [
  // Crafting operations
  { log: 'Instruction: CreateCraftingProcess', expected: 'CreateCraftingProcess', category: 'crafting' },
  { log: 'Instruction: StartCraftingProcess', expected: 'StartCraftingProcess', category: 'crafting' },
  { log: 'Instruction: StopCraftingProcess', expected: 'StopCraftingProcess', category: 'crafting' },
  { log: 'Instruction: ClaimCraftingOutputs', expected: 'ClaimCraftingOutputs', category: 'crafting' },

  // Mining operations
  { log: 'Instruction: StartMiningAsteroid', expected: 'StartMiningAsteroid', category: 'mining' },
  { log: 'Instruction: StopMiningAsteroid', expected: 'StopMiningAsteroid', category: 'mining' },
  { log: 'Instruction: ScanForSurveyDataUnits', expected: 'ScanForSurveyDataUnits', category: 'mining' },

  // Fleet operations
  { log: 'Instruction: CreateFleet', expected: 'CreateFleet', category: 'fleet' },
  { log: 'Instruction: DisbandFleet', expected: 'DisbandFleet', category: 'fleet' },
  { log: 'Instruction: AddShipToFleet', expected: 'AddShipToFleet', category: 'fleet' },
  { log: 'Instruction: LoadFleetCrew', expected: 'LoadFleetCrew', category: 'fleet' },

  // Cargo operations
  { log: 'Instruction: DepositCargoToFleet', expected: 'DepositCargoToFleet', category: 'cargo' },
  { log: 'Instruction: WithdrawCargoFromFleet', expected: 'WithdrawCargoFromFleet', category: 'cargo' },
  { log: 'Instruction: TransferCargoWithinFleet', expected: 'TransferCargoWithinFleet', category: 'cargo' },

  // Movement operations
  { log: 'Instruction: WarpToCoordinate', expected: 'WarpToCoordinate', category: 'movement' },
  { log: 'Instruction: StartSubwarp', expected: 'StartSubwarp', category: 'movement' },

  // Starbase operations
  { log: 'Instruction: RegisterStarbase', expected: 'RegisterStarbase', category: 'starbase' },
  { log: 'Instruction: StartStarbaseUpgrade', expected: 'StartStarbaseUpgrade', category: 'starbase' },
];

let passed = 0;
let failed = 0;

console.log('Testing instruction decoding from log messages:\n');

for (const test of testCases) {
  const decoded = decodeInstructionFromLogs([test.log]);
  const result = decoded?.instructionType === test.expected && decoded?.category === test.category;
  const status = result ? '✓' : '✗';
  
  if (result) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${status} ${test.log}`);
  if (decoded) {
    console.log(`  → ${decoded.name} (${decoded.category})\n`);
  } else {
    console.log(`  → NOT DECODED\n`);
  }
}

console.log(`\n=== Results ===`);
console.log(`Passed: ${passed}/${testCases.length}`);
console.log(`Failed: ${failed}/${testCases.length}`);

if (failed === 0) {
  console.log('\n✓ All tests passed!');
  process.exit(0);
} else {
  console.log('\n✗ Some tests failed');
  process.exit(1);
}
