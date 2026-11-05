import { describe, expect, it } from "vitest";
import { TEAM_MODEL_LLAMA_MODEL, TEAM_MODEL_TEXT_MODEL } from "@shiba/shared";
import { requireTeamModelTextInput, teamModelTextOutput } from "../src/team-model-adapters.js";

const messages = [{ role: "system", content: "Instructions" }, { role: "user", content: "Reviewed text" }];
const glm = { messages, max_completion_tokens: 64, stream: false, n: 1, modalities: ["text"], tool_choice: "none", store: false, chat_template_kwargs: { enable_thinking: false } };
const llama = { messages, max_tokens: 64, stream: false };
describe("fixed funded operation adapters", () => {
  it.each([[TEAM_MODEL_TEXT_MODEL, glm], [TEAM_MODEL_LLAMA_MODEL, llama]])("accepts only the frozen %s payload and returns a detached snapshot", (model, input) => {
    const parsed = requireTeamModelTextInput(input, model as string, 64);
    expect(parsed).toEqual(input); expect(parsed.messages).not.toBe(input.messages);
  });
  it.each([
    { ...glm, tools: [] }, { ...glm, response_format: { type: "json_object" } }, { ...glm, stream: true },
    { ...glm, n: 2 }, { ...glm, modalities: ["text", "audio"] }, { ...glm, store: true },
    { ...glm, chat_template_kwargs: { enable_thinking: false, arbitrary: true } },
    { ...glm, messages: [{ role: "system", content: "Instructions" }, { role: "user", content: [{ type: "image_url", image_url: "https://example.test" }] }] },
    { ...glm, messages: [...messages, { role: "assistant", content: "Extra history" }] },
    { ...glm, messages: [{ ...messages[0], name: "extra" }, messages[1]] },
    { ...glm, max_completion_tokens: 65 },
  ])("refuses unsupported GLM fields, modalities and bounds before reservation", (input) => {
    expect(() => requireTeamModelTextInput(input, TEAM_MODEL_TEXT_MODEL, 64)).toThrow("input_policy_changed");
  });
  it.each([{ ...llama, tools: [] }, { ...llama, stream: true }, { ...llama, max_tokens: 65 }])("refuses unsupported Llama operations", (input) => {
    expect(() => requireTeamModelTextInput(input, TEAM_MODEL_LLAMA_MODEL, 64)).toThrow("input_policy_changed");
  });
  it.each(["@cf/baai/bge-base-en-v1.5", "@cf/black-forest-labs/flux-1-schnell", "arbitrary-payment"]) ("never falls back for unmetered operation %s", (model) => {
    expect(() => requireTeamModelTextInput(glm, model, 64)).toThrow("input_policy_changed");
    expect(() => teamModelTextOutput({ response: "Not an authorized operation" }, model)).toThrow("output_unconfirmed");
  });
  it.each(["tool_calls", "function_call", "audio", "images"]) ("does not confirm unsupported %s output as text", (field) => {
    expect(() => teamModelTextOutput({ choices: [{ message: { content: "Text", [field]: [] } }] }, TEAM_MODEL_TEXT_MODEL)).toThrow("output_unconfirmed");
    expect(() => teamModelTextOutput({ response: "Text", [field]: [] }, TEAM_MODEL_LLAMA_MODEL)).toThrow("output_unconfirmed");
  });
  it("accepts harmless null optional output fields and preserves byte-bounded text", () => {
    expect(teamModelTextOutput({ choices: [{ message: { content: "Text", tool_calls: null } }] }, TEAM_MODEL_TEXT_MODEL)).toBe("Text");
    const output = teamModelTextOutput({ response: "😀".repeat(3000) }, TEAM_MODEL_LLAMA_MODEL);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(8192); expect(output).toMatch(/\[truncated\]$/);
  });
});
