import { z } from "zod";

export const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const imageModels = [
  { id: FLUX_MODEL, label: "Flux Schnell", supportsDimensions: false, mime: "image/jpeg" },
  { id: "@cf/leonardo/lucid-origin", label: "Lucid Origin", supportsDimensions: true, mime: "image/jpeg" },
  { id: "@cf/leonardo/phoenix-1.0", label: "Phoenix", supportsDimensions: true, mime: "image/jpeg" },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", label: "SDXL Lightning", supportsDimensions: true, mime: "image/png" },
] as const;
export const imageAspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export const imageDimensions = {
  "1:1": { width: 1024, height: 1024 }, "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 }, "4:3": { width: 1024, height: 768 }, "3:4": { width: 768, height: 1024 },
} as const;
export const imageInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2000), model: z.string().optional(),
  aspectRatio: z.enum(imageAspectRatios).optional(), aspect: z.enum(["square", "landscape", "portrait"]).optional(),
});
