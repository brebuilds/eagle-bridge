import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface UpscaleDecision {
  srcW: number;
  srcH: number;
  targetW: number;
  targetH: number;
  mode: "auto" | "always" | "never";
  max: number;
}

/** Integer upscale factor (Real-ESRGAN supports integer scales). */
export function decideUpscaleFactor(d: UpscaleDecision): number {
  if (d.mode === "never") return 1;
  const needed = Math.max(d.targetW / d.srcW, d.targetH / d.srcH);
  if (d.mode === "always") {
    return Math.min(Math.max(2, Math.ceil(needed)), d.max);
  }
  if (needed <= 1) return 1;
  return Math.min(Math.ceil(needed), d.max);
}

/**
 * Upscale a PNG/JPG by an integer factor using Real-ESRGAN.
 * Returns the output path. Throws if the binary fails.
 */
export async function upscaleImage(bin: string, inputPath: string, outputPath: string, factor: number): Promise<string> {
  // realesrgan-ncnn-vulkan -i in -o out -s <factor> -n realesrgan-x4plus
  await run(bin, ["-i", inputPath, "-o", outputPath, "-s", String(factor), "-n", "realesrgan-x4plus"]);
  return outputPath;
}
