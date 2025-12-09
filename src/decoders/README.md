# SAGE & Crafting Decoders - Official Implementation

## Overview

This directory contains the **official** decoders for Star Atlas SAGE and Crafting programs, integrated with the Carbon decoder framework from `star-atlas-decoders-main`.

## Supported Programs

### 1. Crafting Program
- **Program ID**: `CRAFT2RPXPJWCEix4WpJST3E7NLf79GTqZUL75wngXo5`
- **Source**: `star-atlas-decoders-main/carbon-decoders/crafting-decoder`
- **Supported Operations**: 30+
  - Recipe management (register, update, delete)
  - Crafting processes (create, start, stop, cancel, close)
  - Output claiming and ingredient management
  - Domain and category management

**Example Crafting Instructions**:
- `CreateCraftingProcess` - Initialize new crafting
- `StartCraftingProcess` - Activate crafting
- `StopCraftingProcess` - Halt crafting
- `ClaimRecipeOutput` - Claim crafted items
- `BurnConsumableIngredient` - Consume materials

### 2. SAGE Starbased Program
- **Program ID**: `SAGEQbkxz47ynfSeJ2cgvhy26yEQ6w57RPUAGuk76a1`
- **Source**: `star-atlas-decoders-main/carbon-decoders/sage-starbased-decoder`
- **Supported Operations**: 100+
- **Categories**:
  - **Crafting** (10 ops): CreateCraftingProcess, StartCraftingProcess, etc.
  - **Mining** (4 ops): StartMiningAsteroid, StopMiningAsteroid, etc.
  - **Fleet** (6 ops): CreateFleet, AddShipToFleet, LoadFleetCrew, etc.
  - **Cargo** (5 ops): DepositCargoToFleet, WithdrawCargoFromFleet, etc.
  - **Movement** (4 ops): StartSubwarp, WarpToCoordinate, WarpLane, etc.
  - **Starbase** (6 ops): RegisterStarbase, StartStarbaseUpgrade, etc.
  - **Fleet State** (4 ops): IdleToLoadingBay, LoadingBayToIdle, etc.
  - **Profile** (3 ops): RegisterSagePlayerProfile, MintCrewToGame, etc.
  - **And many more**: 50+ additional operations

### 3. SAGE Holosim Program
- **Program ID**: `HSim1111111111111111111111111111111111111111`
- **Source**: `star-atlas-decoders-main/carbon-decoders/sage-holosim-decoder`
- **Status**: Integrated (same instruction types as Starbased)

## Architecture

### Rust Binary Decoder

Located in `rust_decoder/src/main.rs` and compiled to `bin/carbon_crafting_decoder`

**Features**:
- ✅ Decodes Crafting account types using official `carbon-crafting-decoder` crate
- ✅ Supports all 6 Crafting account types:
  - Recipe
  - CraftingFacility
  - CraftingProcess
  - CraftableItem
  - Domain
  - RecipeCategory

### TypeScript Decoders

#### 1. `universal-decoder.ts/js`
Complete mapping of all official SAGE and Crafting instructions.

**Exports**:
- `decodeInstructionFromLogs(logMessages: string[])` - Parse instruction from transaction logs
- `extractMaterialType(instruction, logs)` - Extract material type (Ore, Fuel, Food, etc.)
- `decodeAccount(data)` - Decode account using Rust binary
- `SAGE_STARBASED_INSTRUCTIONS` - Full instruction mapping
- `CRAFTING_INSTRUCTIONS` - Full Crafting instruction mapping

#### 2. `sage-crafting-decoder.ts/js`
High-level decoder wrapper that uses `universal-decoder`.

**Exports**:
- `decodeSageInstruction(instr: string)` - Decode single instruction string
- `decodeSageInstructionFromLogs(logMessages: string[])` - Decode from log array

### Rust Wrapper

`rust-wrapper.ts` - Spawns the Rust binary and decodes account data.

**Features**:
- ✅ Handles binary execution
- ✅ Hex encoding/decoding
- ✅ JSON parsing
- ✅ Fallback handling

## Usage Examples

### Decode Crafting Account

```typescript
import { decodeAccountWithRust } from './rust-wrapper.js';

const accountData = Buffer.from(...);
const decoded = decodeAccountWithRust(accountData);

if (decoded && decoded.kind === 'Recipe') {
  console.log('Recipe Duration:', decoded.value.duration);
  console.log('Consumables:', decoded.value.consumables_count);
}
```

### Decode SAGE Instruction

```typescript
import { decodeSageInstruction, decodeSageInstructionFromLogs } from './sage-crafting-decoder.js';

// Option 1: From single instruction name
const instruction = decodeSageInstruction('StartCraftingProcess');
console.log(instruction.name);        // "Start Crafting Process"
console.log(instruction.category);    // "crafting"

// Option 2: From transaction logs
const tx = await connection.getTransaction(signature);
const decoded = decodeSageInstructionFromLogs(tx.meta.logMessages);
console.log(decoded.name);
console.log(decoded.material);
```

### Distinguish Crafting Operations

```typescript
import { SAGE_STARBASED_INSTRUCTIONS, CRAFTING_INSTRUCTIONS } from './universal-decoder.js';

const op = SAGE_STARBASED_INSTRUCTIONS['CreateCraftingProcess'];
console.log(op.category);      // "crafting"
console.log(op.description);   // "Initialize a new crafting process"

// Versus
const craftingOp = CRAFTING_INSTRUCTIONS['CreateCraftingProcess'];
console.log(craftingOp.program);  // "Crafting"
```

## Instruction Categories

### Complete List of Supported SAGE Operations

#### Crafting (SAGE Starbased)
1. CreateCraftingProcess
2. StartCraftingProcess
3. StopCraftingProcess
4. CancelCraftingProcess
5. CloseCraftingProcess
6. ClaimCraftingOutputs
7. ClaimCraftingNonConsumables
8. BurnCraftingConsumables
9. DepositCraftingIngredient
10. WithdrawCraftingIngredient

#### Mining
1. StartMiningAsteroid
2. StopMiningAsteroid
3. MineAsteroidToRespawn
4. ScanForSurveyDataUnits

#### Fleet Management
1. CreateFleet
2. DisbandFleet
3. AddShipToFleet
4. RemoveShipEscrow
5. LoadFleetCrew
6. UnloadFleetCrew

#### Cargo Operations
1. DepositCargoToFleet
2. WithdrawCargoFromFleet
3. TransferCargoWithinFleet
4. DepositCargoToGame
5. WithdrawCargoFromGame

#### Movement
1. StartSubwarp
2. StopSubwarp
3. WarpToCoordinate
4. WarpLane

#### Starbase
1. RegisterStarbase
2. DeregisterStarbase
3. StartStarbaseUpgrade
4. CompleteStarbaseUpgrade
5. TransferCargoAtStarbase
6. DepositStarbaseUpkeepResource

#### Fleet State Transitions
1. IdleToLoadingBay
2. LoadingBayToIdle
3. IdleToRespawn
4. RespawnToLoadingBay

#### Profile/Account
1. RegisterSagePlayerProfile
2. MintCrewToGame
3. AddCrewToGame

**Plus 50+ additional operations** (resource management, progression, ship operations, etc.)

## Configuration

### Environment Variables

```bash
# Path to Rust binary (optional, defaults to ./bin/carbon_crafting_decoder)
RUST_DECODER_BIN=./bin/carbon_crafting_decoder
```

## Benefits of Official Decoders

✅ **Accuracy**: Uses exact discriminators and Borsh deserialization from official Carbon decoders
✅ **Completeness**: All 100+ SAGE operations properly mapped
✅ **Type Safety**: Proper enum types for instruction categories
✅ **Maintainability**: Updates automatically when Carbon decoders are updated
✅ **Performance**: Rust binary for fast deserialization

## Troubleshooting

### "Unable to decode account"

Ensure the account data matches one of the supported types:
- Crafting: Recipe, CraftingFacility, CraftingProcess, CraftableItem, Domain, RecipeCategory
- Check discriminators match expected values

### "Rust binary not found"

1. Verify `./bin/carbon_crafting_decoder` exists
2. Check `RUST_DECODER_BIN` environment variable
3. Rebuild with `cargo build --release` in `rust_decoder/`

### "Instruction not recognized"

Check log messages contain one of the 100+ official instruction names.
Pattern: `Instruction: InstructionName`

## References

- [Carbon Decoders](https://github.com/staratlasmeta/star-atlas-decoders)
- [SAGE Program Documentation](https://docs.staratlas.com/)
- [Crafting Program README](../../star-atlas-decoders-main/carbon-decoders/crafting-decoder/README.md)
