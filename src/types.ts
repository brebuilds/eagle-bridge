// Eagle item as returned by the Eagle localhost API (subset we use).
export interface EagleItem {
  id: string;
  name: string;
  ext: string;
  tags: string[];
  folders: string[];
  annotation: string;
  url?: string;
  width?: number;
  height?: number;
  modificationTime?: number;
}

// Structured link we store in an item's annotation (JSON-encoded).
export interface AssetLink {
  airtableDesignId?: string;
  brand?: string;
  source?: "stacks-upload" | "watch-folder" | "n8n" | "api";
  processed?: Record<string, string>; // productType -> relative file path
}

// A per-product-type processing recipe (from Airtable Product Type table).
export interface Recipe {
  type: string; // machine key, e.g. "tee"
  label: string; // human label, e.g. "T-Shirt (DTG)"
  printPx: [number, number];
  dpi: number;
  fit: "contain" | "cover";
  bg: "transparent" | string; // "transparent" or a hex color
  bleedPx: number;
  format: "png" | "jpeg";
  upscale: "auto" | "always" | "never";
  maxUpscale: number; // cap on upscale factor (e.g. 4)
}
