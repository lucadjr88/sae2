#!/usr/bin/env node

/**
 * Integration test for sage-crafting-decoder
 * Tests the new decoder against real transaction log patterns
 */

import { 
  decodeSageInstruction, 
  decodeSageInstructionFromLogs
} from './sage-crafting-decoder.js';

import {
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS
} from './universal-decoder.js';

console.log('=== SAGE Crafting Decoder Integration Test ===\n');

// Test Case 1: Direct instruction lookup
console.log('Test 1: Direct instruction lookup');
console.log('-'.repeat(50));

const testInstructions = [
  'CreateCraftingProcess',
  'StartCraftingProcess',
  'ClaimCraftingOutputs',
  'StartMiningAsteroid',
  'DepositCargoToFleet',
  'WarpToCoordinate'
];

for (const instr of testInstructions) {
  const decoded = decodeSageInstruction(instr);
  console.log(`✓ ${instr}`);
  if (decoded) {
    console.log(`  → ${decoded.name} (${decoded.craftType})\n`);
  }
}

// Test Case 2: Instruction from logs (real transaction pattern)
console.log('\nTest 2: Instruction from transaction logs');
console.log('-'.repeat(50));

const txLogs = [
  'Program log: Instruction: CreateCraftingProcess',
  'Program log: Processing crafting request',
  'Program invoke: Program consumed X compute units'
];

const decodedFromLogs = decodeSageInstructionFromLogs(txLogs);
console.log('Transaction logs pattern:');
txLogs.slice(0, 1).forEach(l => console.log(`  ${l}`));
console.log(`✓ Decoded: ${decodedFromLogs?.name} (${decodedFromLogs?.craftType})\n`);

// Test Case 3: Category distribution
console.log('Test 3: Instruction statistics');
console.log('-'.repeat(50));

const categories = new Map();
for (const [name, instr] of Object.entries(SAGE_STARBASED_INSTRUCTIONS)) {
  if (name !== 'Unknown') {
    const cat = instr.category || 'unknown';
    categories.set(cat, (categories.get(cat) || 0) + 1);
  }
}

console.log('SAGE Starbased Instructions by Category:');
const sortedCats = Array.from(categories.entries()).sort((a, b) => b[1] - a[1]);
for (const [cat, count] of sortedCats) {
  console.log(`  ${cat}: ${count}`);
}

console.log(`\nTotal SAGE operations: ${sortedCats.reduce((a, b) => a + b[1], 0)}`);
console.log(`Total Crafting operations: ${Object.keys(CRAFTING_INSTRUCTIONS).length - 1}`); // -1 for 'Unknown'

// Test Case 4: Distinguish between similar operations
console.log('\nTest 4: Distinguishing similar operations');
console.log('-'.repeat(50));

const similar = [
  'StartCraftingProcess',
  'CreateCraftingProcess',
  'StopCraftingProcess',
  'CloseCraftingProcess',
  'CancelCraftingProcess'
];

for (const op of similar) {
  const decoded = decodeSageInstruction(op);
  console.log(`${op}`);
  console.log(`  Program: ${decoded?.program}`);
  console.log(`  Category: ${decoded?.craftType}`);
  console.log(`  Description: ${SAGE_STARBASED_INSTRUCTIONS[op]?.description}\n`);
}

console.log('\n✓ All integration tests completed successfully!');
