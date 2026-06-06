import { describe, it, expect } from "vitest";
import { parseModelOutput, normalizeTags } from "../src/autotag/normalize.js";

const messy = `Here is the JSON data for the print-on-demand design:

\`\`\`
{
  "subject": ["In My Dollar General Era"],
  "style": ["Retro"],
  "colors": ["Yellow"],
  "text_in_image": "",
  "seo_keywords": ["Dollar General", "Retro", "Nostalgia", "90s"]
}
\`\`\``;

describe("parseModelOutput", () => {
  it("extracts JSON wrapped in prose + code fences", () => {
    const p = parseModelOutput(messy);
    expect(p.subject).toEqual(["In My Dollar General Era"]);
    expect(p.seo_keywords).toContain("Nostalgia");
  });
  it("returns an empty-ish object on unparseable input", () => {
    const p = parseModelOutput("the model said no");
    expect(p.subject ?? []).toEqual([]);
  });
});

describe("normalizeTags", () => {
  it("builds AutoTags: controlled style/brand, free seo/subject, injected colors", () => {
    const parsed = parseModelOutput(messy);
    const t = normalizeTags(parsed, { colors: ["#f4c20d"], model: "llama3.2-vision:11b", now: "2026-06-06T00:00:00Z" });
    expect(t.style).toContain("retro");          // mapped
    expect(t.colors).toEqual(["#f4c20d"]);        // injected from sharp
    expect(t.seo).toEqual(expect.arrayContaining(["dollar general", "nostalgia"])); // free, lowercased
    expect(t.subject).toContain("in my dollar general era");
    expect(t.brandFit).toEqual([]);               // nothing matches a brand
    expect(t.model).toBe("llama3.2-vision:11b");
    expect(t.taggedAt).toBe("2026-06-06T00:00:00Z");
  });
  it("lowercases, trims, and dedupes free tags", () => {
    const t = normalizeTags({ seo_keywords: ["Retro", " retro ", "RETRO"] }, { colors: [], model: "m", now: "t" });
    expect(t.seo).toEqual(["retro"]);
  });
});
