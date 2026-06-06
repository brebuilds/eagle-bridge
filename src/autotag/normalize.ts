import type { AutoTags } from "../types.js";
import { inferBrands } from "./brands.js";
import { normalizeStyles } from "./styles.js";

export interface ParsedModel {
  subject?: string[];
  style?: string[];
  colors?: string[];
  text_in_image?: string;
  seo_keywords?: string[];
}

/** Extract the first balanced JSON object from messy model output. Never throws. */
export function parseModelOutput(raw: string): ParsedModel {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice) as ParsedModel;
    } catch {
      // fall through to salvage
    }
  }
  return {};
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v === "string") {
      const s = v.toLowerCase().trim();
      if (s) out.add(s);
    }
  }
  return [...out];
}

export interface NormalizeCtx {
  colors: string[]; // hex from sharp
  model: string;
  now: string; // ISO timestamp (injected for testability)
}

/** Turn parsed model output into the hybrid AutoTags vocabulary. */
export function normalizeTags(parsed: ParsedModel, ctx: NormalizeCtx): AutoTags {
  const subject = clean(parsed.subject);
  const seo = clean(parsed.seo_keywords);
  const styleWords = [...(parsed.style ?? []), ...subject, ...seo];
  return {
    subject,
    style: normalizeStyles(styleWords),
    colors: ctx.colors,
    seo,
    brandFit: inferBrands([...subject, ...seo]),
    model: ctx.model,
    taggedAt: ctx.now,
  };
}
