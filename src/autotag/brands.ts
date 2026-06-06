// Keyword -> brand map, seeded from the brand skills. Edit freely as data.
const BRAND_KEYWORDS: Record<string, string[]> = {
  TFH: ["deadhead", "grateful dead", "stealie", "phish", "jam band", "jamband", "lot", "psychedelic skull", "dancing bear"],
  Coastly: ["coastal", "beach", "sun-washed", "seaside", "nautical", "ocean", "shore"],
  "OIB.Guide": ["ocean isle beach", "oib", "brunswick county", "sunset beach", "holden beach"],
  "Funky Legs": ["leggings", "all-over print", "all over print", "patterned tights"],
  "Design & Chill": ["sarcasm", "snarky", "meme", "trainwreck"],
};

/** Infer which brands a set of free terms fits. Case-insensitive, deduped, possibly empty. */
export function inferBrands(terms: string[]): string[] {
  const hay = terms.map((t) => t.toLowerCase());
  const out = new Set<string>();
  for (const [brand, keywords] of Object.entries(BRAND_KEYWORDS)) {
    if (keywords.some((kw) => hay.some((t) => t.includes(kw)))) out.add(brand);
  }
  return [...out];
}
