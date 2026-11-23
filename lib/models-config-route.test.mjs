import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real /api/models-config against a throwaway agent dir. Bug hunt round 1
// (#295): GET returned provider apiKeys — and credential headers — in
// plaintext; PUT must preserve the stored credentials when the client
// echoes the masked placeholders back.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-models-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousXdg = process.env.XDG_DATA_HOME;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.XDG_DATA_HOME;

const route = await import("../app/api/models-config/route.ts");
const lib = await import("./omp/models-config.ts");

const MODELS_YML = `providers:
  acme:
    baseUrl: https://example.invalid/v1
    apiKey: sk-LIVE-KEY-123
    headers:
      Authorization: Bearer LIVE-TOKEN
    models:
      - id: acme-1
        api: openai-completions
        headers:
          X-Model-Key: MODEL-SECRET
`;

function put(body, init = {}) {
  return route.PUT(new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  }));
}

test("GET masks apiKey and headers, and PUT with the placeholders preserves the stored credentials", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));

  const got = await (await route.GET()).json();
  assert.equal(got.providers.acme.apiKey, lib.MASKED_API_KEY);
  assert.equal(got.providers.acme.headers.Authorization, lib.MASKED_API_KEY);
  assert.equal(got.providers.acme.models[0].headers["X-Model-Key"], lib.MASKED_API_KEY);
  assert.equal(got.providers.acme.baseUrl, "https://example.invalid/v1");
  assert.doesNotMatch(JSON.stringify(got), /sk-LIVE-KEY-123|LIVE-TOKEN|MODEL-SECRET/);

  // Save an unrelated edit while echoing the placeholders back.
  const res = await put({
    ...got,
    providers: { acme: { ...got.providers.acme, models: [{ id: "acme-1", api: "openai-completions", maxTokens: 2048, headers: got.providers.acme.models[0].headers }] } },
  });
  assert.equal(res.status, 200);
  const onDisk = readFileSync(join(agentDir, "models.yml"), "utf8");
  assert.match(onDisk, /sk-LIVE-KEY-123/);
  assert.match(onDisk, /Bearer LIVE-TOKEN/);
  assert.match(onDisk, /MODEL-SECRET/);
  assert.match(onDisk, /maxTokens: 2048/);

  // A genuinely new key overwrites the stored one.
  const res2 = await put({ providers: { acme: { baseUrl: "https://example.invalid/v1", apiKey: "sk-NEW-KEY-456", models: [{ id: "acme-1", api: "openai-completions", maxTokens: 2048 }] } } });
  assert.equal(res2.status, 200);
  assert.match(readFileSync(join(agentDir, "models.yml"), "utf8"), /sk-NEW-KEY-456/);
});

test("PUT never persists the masked placeholder as a credential", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));
  // A brand-new provider submitted with the placeholder: no stored value to
  // restore, so the placeholder must be dropped rather than written.
  const res = await put({ providers: { brand: { baseUrl: "https://example.invalid/v1", apiKey: lib.MASKED_API_KEY, auth: "none", headers: { Authorization: lib.MASKED_API_KEY } } } });
  assert.equal(res.status, 200);
  assert.doesNotMatch(readFileSync(join(agentDir, "models.yml"), "utf8"), new RegExp(lib.MASKED_API_KEY));
});

test("PUT with a null body is a 400, not a 500", async () => {
  const res = await put("null");
  assert.equal(res.status, 400);
});

test("PUT rejects a key with the placeholder and a replacement appended", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));
  const res = await put({ providers: { acme: { baseUrl: "https://example.invalid/v1", apiKey: `${lib.MASKED_API_KEY}sk-NEW`, models: [{ id: "acme-1", api: "openai-completions" }] } } });
  assert.equal(res.status, 400);
  assert.match(readFileSync(join(agentDir, "models.yml"), "utf8"), /sk-LIVE-KEY-123/);
});

test("PUT preserves the key when the provider is renamed", async (t) => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.yml"), MODELS_YML, "utf8");
  t.after(() => rmSync(join(agentDir, "models.yml"), { force: true }));
  const got = await (await route.GET()).json();
  const res = await put({ providers: { renamed: got.providers.acme } });
  assert.equal(res.status, 200);
  const onDisk = readFileSync(join(agentDir, "models.yml"), "utf8");
  assert.match(onDisk, /sk-LIVE-KEY-123/);
  assert.match(onDisk, /renamed:/);
  assert.doesNotMatch(onDisk, /acme:/);
});

test("teardown restores the environment", () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  rmSync(agentDir, { recursive: true, force: true });
});
