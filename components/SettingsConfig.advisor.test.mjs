import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SettingsConfig } from "./SettingsConfig";

const noop = () => {};

/** Render the real Agent & Intelligence panel with a stubbed settings API. */
async function renderIntelligenceTab(t, { advisorEnabled = true } = {}) {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "/api/omp-settings" && (options.method ?? "GET") === "PUT") {
      const settings = JSON.parse(options.body).settings;
      puts.push(settings);
      return Response.json({ success: true, settings });
    }
    if (String(url) === "/api/omp-settings") return Response.json({ settings: { advisor: { enabled: advisorEnabled } } });
    return Response.json({});
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => {
    root.render(createElement(SettingsConfig, {
      activeTab: "intelligence",
      toolCallsDefaultCollapsed: false, onToolCallsDefaultCollapsedChange: noop,
      hideToolActivity: false, onHideToolActivityChange: noop,
      expandThinkingByDefault: false, onExpandThinkingByDefaultChange: noop, onHideThinkingBlockChange: noop,
      providerUsageVisible: false, onProviderUsageVisibleChange: noop,
      scopeNativeSelectAll: false, onScopeNativeSelectAllChange: noop,
      openUrlAutomatically: false, onOpenUrlAutomaticallyChange: noop,
      cwd: null, remoteHost: false, sessionId: null,
      onModelsSaved: noop, onPluginsReloaded: noop,
      appUpdate: null, onRefreshAppUpdate: async () => null,
      onRequestAppUpdate: noop, onSelectTab: noop, onClose: noop,
    }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return { container, puts };
}

const advisorSwitch = (container) => container.querySelector('[data-search-id="advisor-enabled"] button[role="switch"]');

test("Agent & Intelligence exposes the Advisor default and persists it", async (t) => {
  const { container, puts } = await renderIntelligenceTab(t, { advisorEnabled: true });
  assert.ok(container.textContent.includes("Advisor"), "no Advisor section in the intelligence tab");
  const toggle = advisorSwitch(container);
  assert.ok(toggle, "no Advisor toggle");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  act(() => toggle.click());
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.ok(puts.length >= 1, "toggling Advisor sent no PUT");
  assert.equal(puts.at(-1).advisor.enabled, false);
});

test("the Advisor toggle reflects a disabled global default", async (t) => {
  const { container } = await renderIntelligenceTab(t, { advisorEnabled: false });
  const toggle = advisorSwitch(container);
  assert.ok(toggle, "no Advisor toggle");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
});
