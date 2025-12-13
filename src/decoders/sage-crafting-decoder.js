/**
 * SAGE Crafting Decoder
 * 
 * Uses the official Carbon decoders from star-atlas-decoders
 * Properly distinguishes between different crafting and SAGE operations
 */

import {
  decodeInstructionFromLogs,
  extractMaterialType,
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS
} from './universal-decoder.js';

/**
 * Decode a SAGE or Crafting instruction from log messages
 * This properly uses the official instruction mappings from Carbon decoders
 */
export function decodeSageInstruction(instr) {
  if (!instr) return undefined;

  // First try direct lookup in mappings
  let decoded = SAGE_STARBASED_INSTRUCTIONS[instr] || CRAFTING_INSTRUCTIONS[instr];
  
  // If not found, try log pattern matching
  if (!decoded) {
    decoded = decodeInstructionFromLogs([instr]);
  }
  
  if (decoded) {
    const material = extractMaterialType(decoded, [instr]);
    return {
      program: decoded.program,
      type: decoded.category || 'operation',
      name: decoded.name,
      craftType: decoded.category,
      material: material
    };
  }

  return undefined;
}

/**
 * Alternative: decode from array of log messages
 * Returns the first matching instruction found
 */
export function decodeSageInstructionFromLogs(logMessages) {
  const decoded = decodeInstructionFromLogs(logMessages);
  
  if (decoded) {
    const material = extractMaterialType(decoded, logMessages);
    return {
      program: decoded.program,
      type: decoded.category || 'operation',
      name: decoded.name,
      craftType: decoded.category,
      material: material
    };
  }

  return undefined;
}

export default {
  decodeSageInstruction,
  decodeSageInstructionFromLogs,
  SAGE_STARBASED_INSTRUCTIONS,
  CRAFTING_INSTRUCTIONS
};
