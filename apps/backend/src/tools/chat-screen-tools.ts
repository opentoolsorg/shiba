import { tool, type ToolSet } from "ai";
import {
  screenClickInputSchema,
  screenKeyInputSchema,
  screenScrollInputSchema,
  screenShotInputSchema,
  screenTypeInputSchema,
} from "@shiba/shared";
import type { Env } from "../env.js";
import { readRunComputerScreenshot, saveRunComputerScreenshot } from "../run-computer-output.js";
import type { ScreenAction } from "../screen-control.js";

export function createChatScreenTools(env: Env, ctx: {
  userId: string;
  workspaceId: string;
  act: (runId: string, action: ScreenAction) => Promise<Response>;
}): ToolSet {
  const act = async (runId: string, action: ScreenAction) => {
    const response = await ctx.act(runId, action);
    return response.json() as Promise<{ ok?: boolean; screenshotBase64?: string; error?: string; paused?: boolean }>;
  };
  return {
    screen_click: tool({
      description: "Click a pixel on the approved cloud computer in this thread. Requires human confirmation.",
      inputSchema: screenClickInputSchema,
      needsApproval: true,
      execute: ({ runId, ...input }) => act(runId, { type: "click", ...input }),
    }),
    screen_type: tool({
      description: "Type non-secret text on the approved cloud computer. Never enter credentials. Requires human confirmation.",
      inputSchema: screenTypeInputSchema,
      needsApproval: true,
      execute: ({ runId, text }) => act(runId, { type: "type", text }),
    }),
    screen_key: tool({
      description: "Send a keyboard shortcut to the approved cloud computer. Requires human confirmation.",
      inputSchema: screenKeyInputSchema,
      needsApproval: true,
      execute: ({ runId, keys }) => act(runId, { type: "key", keys }),
    }),
    screen_scroll: tool({
      description: "Scroll the approved cloud computer in this thread.",
      inputSchema: screenScrollInputSchema,
      execute: ({ runId, dx, dy }) => act(runId, { type: "scroll", dx, dy }),
    }),
    screen_shot: tool({
      description: "Capture the approved cloud computer and save the screenshot to private Outputs.",
      inputSchema: screenShotInputSchema,
      execute: async ({ runId }) => {
        const { screenshotBase64, ...result } = await act(runId, { type: "shot" });
        if (!screenshotBase64) return { ...result, artifactId: undefined };
        try {
          const file = await saveRunComputerScreenshot(env, { ...ctx, runId, screenshotBase64 });
          return { ok: true, ...file };
        } catch {
          return { ok: false, error: "The screenshot could not be saved to private Outputs.", artifactId: undefined };
        }
      },
      toModelOutput: async ({ input, output }) => {
        const data = output.artifactId ? await readRunComputerScreenshot(env, {
          ...ctx, runId: input.runId, artifactId: output.artifactId,
        }).catch(() => null) : null;
        return data ? { type: "content", value: [
          { type: "text", text: JSON.stringify(output) },
          { type: "image-data", data, mediaType: "image/png" },
        ] } : { type: "text", value: JSON.stringify(output) };
      },
    }),
  };
}
