// Utility functions for transaction parsing and material detection
import { MATERIAL_MINTS } from './material-mints.js';

export function detectCraftingMaterial(instructions: string[], txMeta: any): string | undefined {
  let material: string | undefined = undefined;
  // Cerca per nome
  for (const instr of instructions) {
    if (/fuel/i.test(instr)) material = 'Fuel';
    else if (/ore/i.test(instr)) material = 'Ore';
    else if (/tool/i.test(instr)) material = 'Tool';
    else if (/component/i.test(instr)) material = 'Component';
    else if (/food/i.test(instr)) material = 'Food';
    else if (/claim/i.test(instr) && /ammo/i.test(instr)) material = 'Ammo';
  }
  // Cerca per pubkey
  if (!material && txMeta && Array.isArray(txMeta.innerInstructions)) {
    for (const blk of txMeta.innerInstructions) {
      if (!blk || !Array.isArray(blk.instructions)) continue;
      for (const iin of blk.instructions) {
        const fields = [iin?.parsed?.destination, iin?.parsed?.mint, iin?.parsed?.token, iin?.parsed?.authority, iin?.parsed?.source];
        for (const val of fields) {
          if (typeof val === 'string') {
            if (MATERIAL_MINTS[val]) {
              material = MATERIAL_MINTS[val];
            } else if (/^[A-Za-z0-9]{32,44}$/.test(val)) {
              material = val;
            }
          }
          if (material) break;
        }
        if (material) break;
      }
      if (material) break;
    }
  }
  return material;
}
