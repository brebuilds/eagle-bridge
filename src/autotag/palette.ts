import sharp from "sharp";

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Extract up to `max` representative colors as hex. Uses sharp's dominant color plus
 * a small posterized histogram for variety. Deterministic.
 */
export async function extractColors(imagePath: string, max = 4): Promise<string[]> {
  const out = new Set<string>();
  // 1. sharp's built-in dominant color
  const { dominant } = await sharp(imagePath).stats();
  out.add(toHex(dominant.r, dominant.g, dominant.b));
  // 2. posterized sample for a couple more buckets
  const w = 16, h = 16;
  const { data, info } = await sharp(imagePath).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = Math.round(data[i] / 64) * 64;
    const g = Math.round(data[i + 1] / 64) * 64;
    const b = Math.round(data[i + 2] / 64) * 64;
    const hex = toHex(r, g, b);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const [hex] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.size >= max) break;
    out.add(hex);
  }
  return [...out].slice(0, max);
}
