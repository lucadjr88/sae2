// Map the Rust decoder's JSON output into the project's unified decode shape
// { recipe?: AccountLike, process?: AccountLike, item?: AccountLike }
export function normalizeRustDecode(parsed) {
    if (!parsed || typeof parsed !== 'object')
        return null;
    const outer = {
        lamports: parsed.lamports,
        owner: parsed.owner,
        executable: parsed.executable,
        rent_epoch: parsed.rent_epoch,
    };
    const data = parsed.data || {};
    const result = {};
    // Heuristic mapping: look for obvious keys, otherwise inspect inner fields
    for (const key of Object.keys(data)) {
        const lk = key.toLowerCase();
        const val = data[key];
        if (lk.includes('recipe')) {
            result.recipe = { ...outer, data: { Recipe: val } };
            continue;
        }
        if (lk.includes('process')) {
            result.process = { ...outer, data: { Process: val } };
            continue;
        }
        if (lk.includes('domain') || lk.includes('item')) {
            result.item = { ...outer, data: { Domain: val } };
            continue;
        }
        // Field-level heuristics
        if (val && typeof val === 'object') {
            if ('recipe_items' in val || 'fee_amount' in val || 'outputs_count' in val || 'usage_limit' in val) {
                result.recipe = { ...outer, data: { Recipe: val } };
                continue;
            }
            if ('crafting_id' in val || 'start_time' in val || 'end_time' in val || 'crafting_facility' in val) {
                result.process = { ...outer, data: { Process: val } };
                continue;
            }
            if ('mint' in val || 'creator' in val || 'namespace' in val) {
                result.item = { ...outer, data: { Item: val } };
                continue;
            }
        }
    }
    // If we found nothing, but parsed.data itself looks like a Recipe/Process, try top-level checks
    if (!result.recipe && !result.process && !result.item && typeof data === 'object') {
        const flat = data;
        if ('recipe_items' in flat || 'fee_amount' in flat)
            result.recipe = { ...outer, data: { Recipe: flat } };
        else if ('crafting_id' in flat || 'start_time' in flat)
            result.process = { ...outer, data: { Process: flat } };
        else if ('mint' in flat || 'namespace' in flat)
            result.item = { ...outer, data: { Item: flat } };
    }
    // If still empty, return null (caller should fallback)
    if (Object.keys(result).length === 0)
        return null;
    return result;
}
export default normalizeRustDecode;
