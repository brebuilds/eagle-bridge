export interface BacklinkInput {
  token: string;
  baseId: string;
  tableId: string;
  designId?: string;
  eagleItemId: string;
  eagleUrl: string;
}

/**
 * Write the Eagle item id + url back onto an Airtable Design record.
 * No-op when designId is missing. Assumes the Designs table has
 * single-line-text fields `EagleItemId` and `EagleUrl`.
 */
export async function backlinkDesign(input: BacklinkInput): Promise<void> {
  if (!input.designId) return;
  const url = `https://api.airtable.com/v0/${input.baseId}/${input.tableId}/${input.designId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { EagleItemId: input.eagleItemId, EagleUrl: input.eagleUrl } }),
  });
  if (!res.ok) throw new Error(`Airtable back-link failed: ${res.status}`);
}
