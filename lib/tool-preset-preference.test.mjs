import assert from "node:assert/strict";
import test from "node:test";

import { getPreferredToolPreset, getSessionToolPreset, setPreferredToolPreset, setSessionToolPreset } from "./tool-preset-preference.ts";
import { getPresetForToolNames, getToolNamesForPreset, getToolPresetToolCount } from "./tool-presets.ts";

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test("defaults to the full OMP toolset and persists explicit choices", () => {
  const storage = createStorage({ "omp-web:tool-preset": "unknown" });
  assert.equal(getPreferredToolPreset(storage), "full");

  setPreferredToolPreset("default", storage);
  assert.equal(getPreferredToolPreset(storage), "default");

  setPreferredToolPreset("full", storage);
  assert.equal(getPreferredToolPreset(storage), "full");
});

test("full preset leaves OMP's native toolset unrestricted", () => {
  assert.equal(getToolNamesForPreset("full"), undefined);
  assert.deepEqual(getToolNamesForPreset("default"), ["read", "bash", "edit", "write"]);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});

test("a session's spawn preset is recorded per session and unknown when never recorded (#356)", () => {
  const storage = createStorage();
  assert.equal(getSessionToolPreset("s1", storage), null);
  assert.equal(getSessionToolPreset(null, storage), null);

  setSessionToolPreset("s1", "default", storage);
  assert.equal(getSessionToolPreset("s1", storage), "default");
  assert.equal(getSessionToolPreset("s2", storage), null, "sessions do not share a record");

  setSessionToolPreset("s1", "full", storage);
  assert.equal(getSessionToolPreset("s1", storage), "full");

  const invalid = createStorage({ "omp-web:tool-preset:s1": "unknown" });
  assert.equal(getSessionToolPreset("s1", invalid), null);
});

test("tool counts and the toolNames round-trip name the preset (#356)", () => {
  assert.equal(getToolPresetToolCount("full"), null);
  assert.equal(getToolPresetToolCount("default"), 4);
  assert.equal(getToolPresetToolCount("none"), 0);
  assert.equal(getPresetForToolNames(undefined), "full");
  assert.equal(getPresetForToolNames([]), "none");
  assert.equal(getPresetForToolNames(["write", "read", "edit", "bash"]), "default");
  assert.equal(getPresetForToolNames(["read", "bash"]), null, "a custom toolset is no preset");
});
