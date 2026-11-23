import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
const { cleanup, render, screen, waitFor } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");
const { PluginSettingsForm } = await import("./PluginSettingsForm.tsx");

afterEach(cleanup);

const pkg = {
  source: "fixture-plugin",
  scope: "global",
  filtered: false,
  disabled: false,
  installedPath: "/plugins/fixture-plugin",
  packageName: "fixture-plugin",
  counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
  resources: [],
  status: "installed",
  settings: {
    name: { type: "string", description: "Display name" },
    retries: { type: "number", min: 1, max: 3, step: 1 },
    enabled: { type: "boolean" },
    mode: { type: "enum", values: ["fast", "safe"] },
    token: { type: "string", secret: true },
  },
  actions: { check: { description: "Run the installed check" } },
};
const cwd = "/workspace";

function config() {
  return {
    source: pkg.source,
    scope: pkg.scope,
    schema: pkg.settings,
    settings: {
      name: "before",
      retries: 2,
      enabled: true,
      mode: "safe",
      token: { configured: true, redacted: true },
    },
    actions: pkg.actions,
  };
}

test("schema renders every scalar type, validates/saves typed values, and preserves a blank secret", async (t) => {
  let current = config();
  const writes = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json(current);
    const body = JSON.parse(init.body);
    if (method === "PUT") {
      writes.push(body);
      if (!body.validateOnly) {
        current = {
          ...current,
          settings: {
            name: body.settings.name,
            retries: body.settings.retries,
            enabled: body.settings.enabled,
            mode: body.settings.mode,
            token: { configured: true, redacted: true },
          },
        };
      }
      return Response.json({ valid: true, errors: [], ...(body.validateOnly ? {} : { config: current }) });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  render(createElement(PluginSettingsForm, { pkg, cwd }));
  const user = userEvent.setup();
  const name = await screen.findByRole("textbox", { name: "name" });
  assert.ok(screen.getByRole("spinbutton", { name: "retries" }));
  assert.ok(screen.getByRole("checkbox", { name: "enabled" }));
  assert.ok(screen.getByRole("combobox", { name: "mode" }));
  const secret = screen.getByLabelText("token");
  assert.equal(secret.type, "password");
  assert.equal(secret.value, "");
  assert.ok(screen.getByText("Configured · redacted"));
  assert.equal(document.body.textContent.includes("raw-secret"), false);
  const saveButton = screen.getByRole("button", { name: "Save settings" });
  assert.equal(saveButton.style.background, "var(--accent-strong)");
  assert.equal(saveButton.style.color, "var(--on-accent)");
  assert.equal(saveButton.parentElement?.style.position, "fixed");
  assert.ok(Number.parseInt(saveButton.style.minHeight, 10) >= 36);

  await user.clear(name);
  await user.type(name, "after");
  await user.clear(screen.getByRole("spinbutton", { name: "retries" }));
  await user.type(screen.getByRole("spinbutton", { name: "retries" }), "3");
  await user.click(screen.getByRole("checkbox", { name: "enabled" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "mode" }), "fast");
  await user.click(screen.getByRole("button", { name: "Validate settings" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.deepEqual(writes[0].settings, { name: "after", retries: 3, enabled: false, mode: "fast", token: "" });
  assert.equal(writes[0].validateOnly, true);
  assert.ok(await screen.findByText("Settings are valid."));

  await user.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.equal(writes[1].validateOnly, false);
  assert.equal(writes[1].settings.token, "");
  assert.ok(await screen.findByText("Settings saved."));
  assert.equal(screen.getByLabelText("token").value, "");
  assert.ok(document.querySelector("time"));
});

test("secret clearing is explicit and action requests contain only its declared id", async (t) => {
  let current = config();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return Response.json(current);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    if (method === "DELETE") {
      current = { ...current, settings: { ...current.settings, token: { configured: false, redacted: true } } };
      return Response.json({ valid: true, errors: [], config: current });
    }
    if (method === "POST") return Response.json({ actionId: body.actionId, result: { source: "installed-plugin", reachable: true }, completedAt: "2026-11-22T12:00:00.000Z" });
    throw new Error(`Unexpected ${method}`);
  });

  render(createElement(PluginSettingsForm, { pkg, cwd }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Clear secret token" }));
  await waitFor(() => assert.equal(requests.length, 1));
  assert.deepEqual(requests[0], {
    method: "DELETE",
    body: { source: pkg.source, scope: pkg.scope, cwd, settings: {}, clearSecrets: ["token"] },
  });
  assert.ok(await screen.findByText("Secret token cleared."));

  await user.click(screen.getByRole("button", { name: "Run check" }));
  await waitFor(() => assert.equal(requests.length, 2));
  assert.deepEqual(requests[1], { method: "POST", body: { source: pkg.source, scope: pkg.scope, cwd, actionId: "check" } });
  assert.ok(await screen.findByText(/installed-plugin/));
  assert.ok(screen.getByText("Action completed."));
});

test("a failed structured action result is rendered as an error, not success", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init?.method) return Response.json(config());
    return Response.json({
      actionId: "check",
      result: { status: "failed", lastError: { code: "backend_protocol_error", message: "Native temporal evidence missing" } },
      completedAt: "2026-11-22T12:00:00.000Z",
    });
  });
  render(createElement(PluginSettingsForm, { pkg, cwd }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Run check" }));
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent, /Native temporal evidence missing/);
  assert.equal(screen.queryByText("Action completed."), null);
});

test("server-side manifest validation errors are visible without writing secrets into the DOM", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init?.method) return Response.json(config());
    return Response.json({ valid: false, errors: [{ key: "retries", message: "Must be <= 3" }] }, { status: 400 });
  });
  render(createElement(PluginSettingsForm, { pkg, cwd }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Save settings" }));
  assert.ok(await screen.findByRole("alert"));
  assert.match(screen.getByRole("alert").textContent, /retries: Must be <= 3/);
});
