import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFooterStatusText } from "../../src/handlers/footer-status.js";

function fakeStore(entries: string[]) {
  return { getMemoryEntries: () => entries } as any;
}

describe("buildFooterStatusText", () => {
  it("returns undefined when the footerStatus flag is off", () => {
    assert.strictEqual(buildFooterStatusText(false, fakeStore(["a"]), null, "proj"), undefined);
  });

  it("counts global entries with a null project store", () => {
    const text = buildFooterStatusText(true, fakeStore(["a", "b"]), null, null);
    assert.strictEqual(text, "🧠 2 memories");
  });

  it("singular form for one entry", () => {
    const text = buildFooterStatusText(true, fakeStore(["a"]), null, null);
    assert.strictEqual(text, "🧠 1 memory");
  });

  it("includes project store count and project name", () => {
    const text = buildFooterStatusText(true, fakeStore(["a", "b"]), fakeStore(["c"]), "devstack");
    assert.strictEqual(text, "🧠 3 memories · devstack");
  });

  it("omits the project suffix when no project store exists", () => {
    const text = buildFooterStatusText(true, fakeStore([]), null, "devstack");
    assert.strictEqual(text, "🧠 0 memories");
  });
});
