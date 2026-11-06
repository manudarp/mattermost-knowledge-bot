import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

interface Scripted {
  text: string;
  finishReason?: string | null;
  truncated?: boolean;
  reasoned?: boolean;
}
const script: Scripted[] = [];
const calls: Array<{ maxTokens: number; userPrompt: string }> = [];

vi.mock("../../src/ai/client.js", () => ({
  callModel: vi.fn(async (opts: { maxTokens: number; userPrompt: string }) => {
    calls.push({ maxTokens: opts.maxTokens, userPrompt: opts.userPrompt });
    const s = script.shift();
    if (!s) throw new Error("unexpected LLM call");
    return {
      text: s.text,
      finishReason: s.finishReason ?? "stop",
      truncated: s.truncated ?? false,
      reasoned: s.reasoned ?? false,
      usage: { input: 10, output: 100 },
    };
  }),
}));

const { callModelJson } = await import("../../src/ai/jsonCall.js");

const Schema = z.object({ title: z.string() });
const base = { name: "test", systemPrompt: "sys", userPrompt: "user", schema: Schema, maxTokens: 8000, temperature: 0 };

beforeEach(() => {
  script.length = 0;
  calls.length = 0;
});

describe("callModelJson", () => {
  it("empty reply (reasoning model out of budget) → retries the original prompt with a doubled budget", async () => {
    script.push({ text: "", finishReason: "length", truncated: true, reasoned: true }, { text: '{"title":"ok"}' });
    await expect(callModelJson(base)).resolves.toEqual({ title: "ok" });
    expect(calls.map((c) => c.maxTokens)).toEqual([8000, 16000]);
    expect(calls[1]!.userPrompt).not.toContain("Previous response");
  });

  it("budget escalation is capped by LLM_MAX_OUTPUT_TOKENS", async () => {
    script.push({ text: "" }, { text: "" }, { text: "" });
    await expect(callModelJson({ ...base, maxTokens: 12000 })).rejects.toThrow(/risposta vuota/);
    expect(calls.map((c) => c.maxTokens)).toEqual([12000, 16000, 16000]);
  });

  it("invalid JSON → retries with the error and the previous answer", async () => {
    script.push({ text: "not json" }, { text: '{"title":"ok"}' });
    await expect(callModelJson(base)).resolves.toEqual({ title: "ok" });
    expect(calls[1]!.userPrompt).toContain("Previous response:\nnot json");
    expect(calls[1]!.maxTokens).toBe(8000);
  });
});
