import sharp from "sharp";

export const TAG_PROMPT =
  'Tag this print-on-demand design for an Etsy seller. Reply ONLY with JSON: ' +
  '{"subject":[],"style":[],"colors":[],"text_in_image":"","seo_keywords":[]}. ' +
  "Be concise; 3-8 seo_keywords buyers would actually search.";

export class OllamaVision {
  constructor(
    private baseUrl: string,
    private model: string,
    private imagePx: number,
    private timeoutMs: number,
  ) {}

  /** Downscale the image and ask the vision model for tags. Returns the raw response string. */
  async tag(imagePath: string): Promise<string> {
    const buf = await sharp(imagePath).resize(this.imagePx, this.imagePx, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
    const b64 = buf.toString("base64");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: TAG_PROMPT, images: [b64], stream: false, options: { temperature: 0.2 } }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(`Ollama request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const body = (await res.json()) as { response?: string };
    return body.response ?? "";
  }
}
