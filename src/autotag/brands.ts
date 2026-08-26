// Keyword -> brand map, seeded from the brand skills. Edit freely as data.
const BRAND_KEYWORDS: Record<string, string[]> = {
  ORB: ["moon skull", "cosmic wanderer", "echo trail", "jam trail", "jamtrail", "lot", "psychedelic skull", "orbit bear"],
  Tidewash: ["coastal", "beach", "sun-washed", "seaside", "nautical", "ocean", "shore"],
  "Driftport.Guide": ["driftport beach", "driftport", "harbor county", "twilight beach", "anchor beach"],
  "Wild Tights": ["leggings", "all-over print", "all over print", "patterned tights"],
  "Chill Draft": ["sarcasm", "snarky", "meme", "hot mess"],
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
