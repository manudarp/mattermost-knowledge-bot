import { describe, it, expect } from "vitest";
import { stripJsonFences } from "../../src/ai/jsonExtract.js";

const payload = {
  title: "Deploy",
  text: "## Comandi\nEsegui:\n```bash\ndocker compose up -d\n```\nPoi controlla `{ status }`.\n\n```json\n{\"a\": 1}\n```",
  change_summary: "x",
};
const json = JSON.stringify(payload);

describe("stripJsonFences", () => {
  it("raw JSON whose strings contain code fences and braces", () => {
    expect(JSON.parse(stripJsonFences(json))).toEqual(payload);
  });

  it("```json-fenced JSON whose strings contain code fences (the bug seen in production)", () => {
    expect(JSON.parse(stripJsonFences("```json\n" + json + "\n```"))).toEqual(payload);
    expect(JSON.parse(stripJsonFences("```\n" + json + "\n```\n"))).toEqual(payload);
  });

  it("prose around the object", () => {
    expect(JSON.parse(stripJsonFences(`Ecco il risultato:\n${json}\nSpero vada bene!`))).toEqual(payload);
  });

  it("prose plus fenced block", () => {
    expect(JSON.parse(stripJsonFences(`Ecco:\n\`\`\`json\n${json}\n\`\`\``))).toEqual(payload);
  });

  it("really truncated output still fails (and is not silently 'fixed')", () => {
    expect(() => JSON.parse(stripJsonFences(json.slice(0, 60)))).toThrow();
  });
});
