/**
 * Test script for the new decoders
 * Verifies that SAGE and Crafting instructions are properly recognized
 */

import { decodeSageInstruction, decodeSageInstructionFromLogs } from './src/decoders/sage-crafting-decoder.js';
import { SAGE_STARBASED_INSTRUCTIONS, CRAFTING_INSTRUCTIONS } from './src/decoders/universal-decoder.js';

console.log('=== SAGE Decoder Tests ===\n');

// Test 1: Decode individual instructions
console.log('Test 1: Decode individual instructions');
const testInstructions = [
  'CreateCraftingProcess',
  'StartMiningAsteroid',
  'WarpToCoordinate',
  'StartStarbaseUpgrade',
  'DepositCargoToFleet'
];

testInstructions.forEach(ix => {
  const decoded = decodeSageInstruction(ix);
  if (decoded) {
    console.log(`✓ ${ix} → ${decoded.name} (${decoded.craftType || decoded.category || 'unknown'})`);
  } else {
    console.log(`✗ ${ix} → NOT FOUND`);
  }
});

// Test 2: Verify instruction counts
console.log('\nTest 2: Instruction counts');
const sageCount = Object.keys(SAGE_STARBASED_INSTRUCTIONS).length;
const craftingCount = Object.keys(CRAFTING_INSTRUCTIONS).length;
console.log(`SAGE Starbased Instructions: ${sageCount}`);
console.log(`Crafting Instructions: ${craftingCount}`);

// Test 3: Verify categories
console.log('\nTest 3: Instruction categories in SAGE');
const categories = new Set();
Object.values(SAGE_STARBASED_INSTRUCTIONS).forEach(ix => {
  if (ix.category) categories.add(ix.category);
});
console.log('Categories found:', Array.from(categories).sort().join(', '));

// Test 4: Decode from log messages
console.log('\nTest 4: Decode from log messages');
const mockLogs = [
  'Program log: Starting execution',
  'Program: Instruction: CreateCraftingProcess',
  'Program log: Crafting initialized'
];

const decoded = decodeSageInstructionFromLogs(mockLogs);
if (decoded) {
  console.log(`✓ Found instruction: ${decoded.name} (${decoded.category})`);
} else {
  console.log('✗ No instruction found');
}

// Test 5: Material extraction
console.log('\nTest 5: Material extraction from logs');
const miningLogs = [
  'Program log: Mining started',
  'Mint: Ore',
  'Amount: 100'
];
const miningDecoded = decodeSageInstructionFromLogs(miningLogs);
if (miningDecoded) {
  console.log(`✓ Operation: ${miningDecoded.name}, Material: ${miningDecoded.material || 'unknown'}`);
}

// Test 6: List all crafting operations
console.log('\nTest 6: All SAGE Crafting Operations');
const craftingOps = Object.values(SAGE_STARBASED_INSTRUCTIONS)
  .filter(ix => ix.category === 'crafting')
  .map(ix => ix.instructionType);
console.log('Crafting operations:', craftingOps.join(', '));

// Test 7: Distinguish between programs
console.log('\nTest 7: Program distinction');
const craftingOp = CRAFTING_INSTRUCTIONS['CreateCraftingProcess'];
const sageOp = SAGE_STARBASED_INSTRUCTIONS['CreateCraftingProcess'];
console.log(`Crafting program: ${craftingOp.program}`);
console.log(`SAGE program: ${sageOp.program}`);

console.log('\n=== All tests completed ===');
