import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_PLUGIN_ACTION_RESPONSE_BYTES,
  executePluginAction,
  publicPluginActions,
  publicPluginSchema,
  publicPluginSettings,
  serializePluginActionPayload,
  serializePluginWrite,
  validatePluginSettings,
  validateSecretClears,
} from "./plugin-config.ts";

const schema = {
  name: { type: "string", default: "demo" },
  retries: { type: "number", min: 1, max: 3 },
  enabled: { type: "boolean", default: true },
  mode: { type: "enum", values: ["fast", "safe"] },
  token: { type: "string", secret: true, default: "must-not-leak" },
};

test("all manifest scalar types use OMP-equivalent validation and reject unknown keys before writes", () => {
  assert.deepEqual(validatePluginSettings(schema, { name: "ok", retries: 2, enabled: false, mode: "safe" }), []);
  const errors = validatePluginSettings(schema, { name: 1, retries: 4, enabled: "true", mode: "other", extra: "x" });
  assert.deepEqual(errors.map(({ key, code }) => ({ key, code })), [
    { key: "name", code: "invalid_setting" },
    { key: "retries", code: "invalid_setting" },
    { key: "enabled", code: "invalid_setting" },
    { key: "mode", code: "invalid_setting" },
    { key: "extra", code: "unknown_setting" },
  ]);
  assert.deepEqual(validatePluginSettings(schema, { token: "" }, { preserveBlankSecrets: true }), []);
  assert.deepEqual(validateSecretClears(schema, ["name", "missing"]).map((error) => error.code), ["not_a_secret", "unknown_setting"]);
});

test("public settings redact secrets and secret defaults while exposing ordinary defaults", () => {
  const publicSchema = publicPluginSchema(schema);
  assert.equal(Object.hasOwn(publicSchema.token, "default"), false);
  assert.equal(publicSchema.name.default, "demo");
  assert.deepEqual(publicPluginSettings(publicSchema, { retries: 2, token: "raw-secret" }), {
    name: "demo",
    retries: 2,
    enabled: true,
    token: { configured: true, redacted: true },
  });
  assert.deepEqual(publicPluginSettings(publicSchema, {}).token, { configured: false, redacted: true });
  assert.deepEqual(publicPluginActions({ check: { module: "./private.ts", export: "run", description: "Check" } }), { check: { description: "Check" } });
});

test("writes for one scope are serial, including after a failure", async () => {
  const events = [];
  const operation = (name, fail = false) => serializePluginWrite("project", "/workspace", async () => {
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, name === "first" ? 15 : 1));
    events.push(`${name}:end`);
    if (fail) throw new Error("failure");
  });
  const first = operation("first", true);
  const second = operation("second");
  await assert.rejects(first, /failure/);
  await second;
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a manifest action executes the installed module with cwd and signal, never a caller-selected module", async () => {
  const parent = mkdtempSync(join(tmpdir(), "omp-web-plugin-action-"));
  const root = join(parent, "package");
  mkdirSync(root);
  try {
    writeFileSync(join(root, "action.mjs"), "export async function declared(cwd, signal) { return { source: 'installed-plugin', cwd, hasSignal: signal instanceof AbortSignal }; }\n");
    const controller = new AbortController();
    const result = await executePluginAction(root, { module: "./action.mjs", export: "declared" }, "/allowed/workspace", controller.signal);
    assert.deepEqual(result, { source: "installed-plugin", cwd: "/allowed/workspace", hasSignal: true });

    const parentAction = join(parent, "outside-action.mjs");
    writeFileSync(parentAction, "export function declared() { return { forbidden: true }; }\n");
    await assert.rejects(executePluginAction(root, { module: parentAction, export: "declared" }, "/allowed/workspace"), /outside the package root/);
    rmSync(parentAction, { force: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("action results must be bounded JSON", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => serializePluginActionPayload(cyclic), /non-JSON/);
  assert.throws(() => serializePluginActionPayload({ text: "x".repeat(MAX_PLUGIN_ACTION_RESPONSE_BYTES) }), /bounded JSON/);
  assert.equal(serializePluginActionPayload({ ok: true }), '{"ok":true}');
});
