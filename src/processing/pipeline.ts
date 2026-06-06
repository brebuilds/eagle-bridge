import sharp from "sharp";
import { dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Recipe } from "../types.js";
import { decideUpscaleFactor, upscaleImage } from "./upscale.js";

export interface RunRecipeInput {
  inputPath: string;
  outputPath: string;
  recipe: Recipe;
  realesrganBin: string;
}

export interface RunRecipeResult {
  outputPath: string;
  upscaled: boolean;
  upscaleFactor: number;
  warning?: string;
}

function bgColor(bg: string): sharp.Color {
  if (bg === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 };
  return bg; // hex string accepted by sharp
}

export async function runRecipe(input: RunRecipeInput): Promise<RunRecipeResult> {
  const { recipe } = input;
  await mkdir(dirname(input.outputPath), { recursive: true });

  const [targetW, targetH] = recipe.printPx;
  const meta = await sharp(input.inputPath).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;

  // 1. Decide + perform upscale
  const factor = decideUpscaleFactor({
    srcW, srcH, targetW, targetH, mode: recipe.upscale, max: recipe.maxUpscale,
  });
  let working = input.inputPath;
  let upscaled = false;
  let warning: string | undefined;
  if (factor > 1) {
    const upPath = `${input.outputPath}.upscaled.png`;
    try {
      working = await upscaleImage(input.realesrganBin, input.inputPath, upPath, factor);
      upscaled = true;
    } catch (e) {
      warning = `Upscale failed, fell back to resampling: ${(e as Error).message}`;
      working = input.inputPath;
    }
  }

  // 2. Resize/fit to the inner print area
  const fitMode = recipe.fit === "cover" ? "cover" : "contain";
  const resizedBuf = await sharp(working)
    .resize(targetW, targetH, {
      fit: fitMode,
      background: bgColor(recipe.bg),
    })
    .toColourspace("srgb")
    .png()
    .toBuffer();

  // 3. Add bleed (extend canvas evenly) if requested
  let pipeline = sharp(resizedBuf);
  if (recipe.bleedPx > 0) {
    pipeline = pipeline.extend({
      top: recipe.bleedPx, bottom: recipe.bleedPx, left: recipe.bleedPx, right: recipe.bleedPx,
      background: bgColor(recipe.bg),
    });
  }

  // 4. Output in the requested format with dpi metadata
  if (recipe.format === "jpeg") {
    pipeline = pipeline.flatten({ background: recipe.bg === "transparent" ? "#ffffff" : recipe.bg }).jpeg({ quality: 95 });
  } else {
    pipeline = pipeline.png();
  }
  await pipeline.withMetadata({ density: recipe.dpi }).toFile(input.outputPath);

  // cleanup temp upscale file
  if (upscaled) await rm(`${input.outputPath}.upscaled.png`, { force: true });

  return { outputPath: input.outputPath, upscaled, upscaleFactor: factor, warning };
}
