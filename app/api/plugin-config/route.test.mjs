import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const scratch = realpathSync(mkdtempSync(join(os.tmpdir(), "omp-web-plugin-config-route-")));
const agentDir = join(scratch, "agent");
const home = join(scratch, "home");
const project = join(scratch, "workspace");
const packageRoot = join(scratch, "installed-plugin");
const logPath = join(scratch, "calls.jsonl");
const statePath = join(scratch, "state.json");
for (const dir of [agentDir, home, project, packageRoot]) mkdirSync(dir, { recursive: true });
writeFileSync(logPath, "");
writeFileSync(statePath, JSON.stringify({ settings: { token: "raw-secret", name: "before", retries: 2, enabled: true, mode: "safe" } }));

const manifest = {
  version: "1.0.0",
  settings: {
    name: { type: "string", default: "demo", description: "Display name" },
    retries: { type: "number", min: 1, max: 3 },
    enabled: { type: "boolean" },
    mode: { type: "enum", values: ["fast", "safe"] },
    token: { type: "string", secret: true, default: "secret-default-must-not-leak" },
  },
  actions: {
    check: { module: "./action.mjs", export: "check", description: "Run the installed check" },
    explode: { module: "./action.mjs", export: "explode", description: "Fail safely" },
    cancel: { module: "./action.mjs", export: "cancel", description: "Cancel safely" },
  },
};
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.0.0", omp: manifest }));
writeFileSync(join(packageRoot, "action.mjs"), `export async function check(cwd, signal) { return { source: "installed-plugin", cwd, signalled: signal instanceof AbortSignal }; }
export async function explode() { throw new Error("action leaked raw-secret"); }
export async function cancel() { throw new DOMException("cancelled raw-secret", "AbortError"); }
`);
writeFileSync(join(scratch, "plugins.json"), JSON.stringify({
  npm: [{ name: "fixture-plugin", version: "1.0.0", path: packageRoot, enabled: true, manifest }],
  marketplace: [{ id: "fixture-plugin@market", scope: "project", entries: [{ scope: "project", installPath: packageRoot, version: "1.0.0", enabled: true }] }],
}));

const fakeOmp = join(scratch, "fake-omp.mjs");
writeFileSync(fakeOmp, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(readFileSync(${JSON.stringify(join(scratch, "plugins.json"))}, "utf8"));
} else if (args[0] === "plugin" && args[1] === "config" && args[2] === "list") {
  process.stdout.write(JSON.stringify({ settings: state.settings, schema: {} }));
} else if (args[0] === "plugin" && args[1] === "config" && args[2] === "set") {
  const [,,,, key, value] = args;
  if (value === "trigger-cli-error") {
    process.stderr.write("command included raw-secret and secret-default-must-not-leak");
    process.exit(1);
  }
  state.settings[key] = key === "retries" ? Number(value) : key === "enabled" ? value === "true" : value;
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else if (args[0] === "plugin" && args[1] === "config" && args[2] === "delete") {
  delete state.settings[args[4]];
  writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
} else {
  process.stderr.write("unexpected invocation");
  process.exit(2);
}
`);
chmodSync(fakeOmp, 0o755);

const ENV_KEYS = ["OMP_WEB_OMP_BIN", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "HOME", "USERPROFILE"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
process.env.OMP_WEB_OMP_BIN = fakeOmp;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = process.env.USERPROFILE = home;
delete process.env.PI_CONFIG_DIR;
const scratchOs = { ...os, homedir: () => home };
mock.module("os", () => ({ ...scratchOs, default: scratchOs }));
mock.module("node:os", () => ({ ...scratchOs, default: scratchOs }));
const { allowFileRoot } = await import("../../../lib/file-access.ts");
allowFileRoot(project);
const route = await import("./route.ts");

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const skip = process.platform === "win32";
const calls = () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const resetCalls = () => writeFileSync(logPath, "");
const url = (query = "") => `http://localhost/api/plugin-config${query}`;
const request = (method, body) => new Request(url(), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const target = { source: "fixture-plugin", scope: "global", cwd: project };

test("list/get expose schema and action metadata but never a secret value or default", { skip }, async () => {
  const listed = await route.GET(new Request(url()));
  assert.equal(listed.status, 200);
  const listBody = await listed.text();
  assert.doesNotMatch(listBody, /raw-secret|secret-default-must-not-leak|action\.mjs|export/);
  const parsed = JSON.parse(listBody);
  assert.deepEqual(parsed.plugins[0].actions, {
    check: { description: "Run the installed check" },
    explode: { description: "Fail safely" },
    cancel: { description: "Cancel safely" },
  });

  const response = await route.GET(new Request(url(`?${new URLSearchParams(target)}`)));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /raw-secret|secret-default-must-not-leak/);
  const body = JSON.parse(text);
  assert.deepEqual(body.settings.token, { configured: true, redacted: true });
  assert.equal(body.settings.name, "before");
  assert.equal(Object.hasOwn(body.schema.token, "default"), false);
});

test("blank secrets are preserved on validate/save and unknown keys write nothing", { skip }, async () => {
  resetCalls();
  const settings = { name: "after", retries: 3, enabled: false, mode: "fast", token: "" };
  const validated = await route.PUT(request("PUT", { ...target, settings, clearSecrets: [], validateOnly: true }));
  assert.equal(validated.status, 200);
  assert.deepEqual(await validated.json(), { valid: true, errors: [] });
  assert.equal(calls().some((call) => call.args[2] === "set"), false);

  const savedResponse = await route.PUT(request("PUT", { ...target, settings, clearSecrets: [] }));
  assert.equal(savedResponse.status, 200);
  const body = await savedResponse.json();
  assert.equal(body.config.settings.name, "after");
  assert.equal(body.config.settings.retries, 3);
  assert.equal(body.config.settings.enabled, false);
  assert.deepEqual(body.config.settings.token, { configured: true, redacted: true });
  const writes = calls().filter((call) => call.args[2] === "set");
  assert.equal(writes.some((call) => call.args[4] === "token"), false);
  assert.equal(writes.every((call) => call.cwd === agentDir), true);

  const beforeUnknown = calls().length;
  const unknown = await route.PUT(request("PUT", { ...target, settings: { unknown: "value" }, clearSecrets: [] }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).errors[0].code, "unknown_setting");
  assert.equal(calls().length, beforeUnknown + 1, "only the installed-plugin list ran; no config command or write");
});

test("only an explicit clear deletes a secret, and CLI failures are redacted", { skip }, async () => {
  resetCalls();
  const failed = await route.PUT(request("PUT", { ...target, settings: { name: "trigger-cli-error" }, clearSecrets: [] }));
  assert.equal(failed.status, 500);
  const failureText = await failed.text();
  assert.doesNotMatch(failureText, /raw-secret|secret-default-must-not-leak/);
  assert.deepEqual(JSON.parse(failureText), { error: "Plugin configuration operation failed", code: "plugin_config_failed" });

  const response = await route.DELETE(request("DELETE", { ...target, settings: {}, clearSecrets: ["token"] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.config.settings.token, { configured: false, redacted: true });
  assert.equal(calls().some((call) => call.args[2] === "delete" && call.args[4] === "token"), true);
  const nonSecret = await route.DELETE(request("DELETE", { ...target, settings: {}, clearSecrets: ["name"] }));
  assert.equal(nonSecret.status, 400);
  assert.equal((await nonSecret.json()).errors[0].code, "not_a_secret");
});

test("actions are looked up in the installed manifest and run with the authorized cwd", { skip }, async () => {
  const unknown = await route.POST(request("POST", { ...target, actionId: "not-declared" }));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "unknown_action");

  const injected = await route.POST(request("POST", { ...target, actionId: "check", module: "/tmp/evil.mjs", export: "evil" }));
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).code, "invalid_action_request");

  const response = await route.POST(request("POST", { ...target, actionId: "check" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.actionId, "check");
  assert.deepEqual(body.result, { source: "installed-plugin", cwd: project, signalled: true });
  assert.equal(typeof body.completedAt, "string");
});

test("action exceptions and cancellation are structured and redacted", { skip }, async () => {
  const failed = await route.POST(request("POST", { ...target, actionId: "explode" }));
  assert.equal(failed.status, 500);
  const failureText = await failed.text();
  assert.doesNotMatch(failureText, /raw-secret/);
  assert.deepEqual(JSON.parse(failureText), { error: "Plugin configuration operation failed", code: "plugin_config_failed" });

  const cancelled = await route.POST(request("POST", { ...target, actionId: "cancel" }));
  assert.equal(cancelled.status, 408);
  const cancelText = await cancelled.text();
  assert.doesNotMatch(cancelText, /raw-secret/);
  assert.deepEqual(JSON.parse(cancelText), { error: "Plugin action was cancelled", code: "action_aborted" });
});

test("project settings use OMP local overrides in the authorized workspace", { skip }, async () => {
  resetCalls();
  const projectTarget = { source: "fixture-plugin@market", scope: "project", cwd: project };
  const response = await route.PUT(request("PUT", { ...projectTarget, settings: { name: "project-value" }, clearSecrets: [] }));
  assert.equal(response.status, 200);
  const configCalls = calls().filter((call) => call.args[1] === "config");
  assert.equal(configCalls.length > 0, true);
  assert.equal(configCalls.every((call) => call.cwd === project), true);
  assert.equal(configCalls.every((call) => call.args.includes("--local")), true);
});

test("an unauthorized workspace is rejected before OMP or an action runs", { skip }, async () => {
  resetCalls();
  const response = await route.POST(request("POST", { ...target, cwd: join(scratch, "not-allowed"), actionId: "check" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "access_denied");
  assert.equal(calls().length, 0);
});
