// Map of controlled style -> synonyms that should collapse into it.
const STYLE_SYNONYMS: Record<string, string[]> = {
  retro: ["retro", "vintage", "90s", "80s", "70s", "nostalgia", "nostalgic"],
  psychedelic: ["psychedelic", "trippy", "trip", "groovy", "tie dye", "tie-dye"],
  minimalist: ["minimalist", "minimal", "clean", "simple"],
  "hand-drawn": ["hand-drawn", "hand drawn", "sketch", "sketchy", "doodle"],
  boho: ["boho", "bohemian"],
  grunge: ["grunge", "distressed", "gritty"],
  kawaii: ["kawaii", "cute", "chibi"],
  typographic: ["typography", "typographic", "lettering", "text-based", "text based"],
};

/** Collapse free style words to the controlled vocabulary. Unknowns dropped. Deduped. */
export function normalizeStyles(words: string[]): string[] {
  const hay = words.map((w) => w.toLowerCase().trim());
  const out = new Set<string>();
  for (const [style, syns] of Object.entries(STYLE_SYNONYMS)) {
    if (syns.some((s) => hay.some((w) => w.includes(s)))) out.add(style);
  }
  return [...out];
}
