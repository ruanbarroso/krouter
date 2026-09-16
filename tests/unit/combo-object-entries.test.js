import { describe, it, expect } from "vitest";
import { parseModel } from "../../open-sse/services/model.js";
import { getComboModelsFromData as comboModels } from "../../open-sse/services/combo.js";
import { getComboModelsFromData as compactModels } from "../../open-sse/services/compact.js";

// Production 2026-09-16: every POST /v1/chat/completions to `barroso-chat`
// 500'd with an empty body in ~300ms — `TypeError: a.includes is not a
// function` thrown synchronously in reorderByQuota → parseModel, before the
// first upstream attempt. Root cause: combo entries stored as
// {model, reasoning} objects (per-entry reasoning effort, PR #5 unmerged)
// reached string-only code. String combos (claude-*) were unaffected, which
// is why direct models 200'd while the aggregate 500'd.
const OBJECT_COMBO = [
  { name: "barroso-chat", models: [
    { model: "oc/muse-spark-1.3-contributor-free", reasoning: "xhigh" },
    { model: "gemini/gemini-3.8-flash", reasoning: "high" },
    "cx/gpt-5.6-luna",
  ] },
];

describe("combo object entries ({model, reasoning})", () => {
  it("parseModel unwraps {model} objects", () => {
    expect(parseModel({ model: "oc/muse-spark-1.3-contributor-free", reasoning: "xhigh" }))
      .toMatchObject({ provider: "opencode", model: "muse-spark-1.3-contributor-free" });
    expect(parseModel({ model: "claude-opus-5" }).isAlias).toBe(true);
    expect(parseModel(null)).toMatchObject({ provider: null, model: null });
  });

  it("parseModel still parses plain strings unchanged", () => {
    expect(parseModel("cc/claude-opus-5"))
      .toMatchObject({ provider: "claude", model: "claude-opus-5" });
  });

  it("combo.js getComboModelsFromData normalizes to id strings", () => {
    expect(comboModels("barroso-chat", OBJECT_COMBO)).toEqual([
      "oc/muse-spark-1.3-contributor-free",
      "gemini/gemini-3.8-flash",
      "cx/gpt-5.6-luna",
    ]);
  });

  it("compact.js getComboModelsFromData normalizes to id strings", () => {
    expect(compactModels("barroso-chat", OBJECT_COMBO)).toEqual([
      "oc/muse-spark-1.3-contributor-free",
      "gemini/gemini-3.8-flash",
      "cx/gpt-5.6-luna",
    ]);
  });

  it("every normalized entry parses without throwing", () => {
    for (const id of comboModels("barroso-chat", OBJECT_COMBO)) {
      expect(() => parseModel(id)).not.toThrow();
      expect(parseModel(id).model).toBeTruthy();
    }
  });
});
