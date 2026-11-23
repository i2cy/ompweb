import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
const { cleanup, fireEvent, render, within } = await import("@testing-library/react/pure.js");
const { SettingsConfig } = await import("./SettingsConfig");

const noop = () => {};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const settingsProps = {
  activeTab: "system",
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
};

/** `get` answers the settings load; each PUT waits until the test releases it. */
function fakeSettings(t, get) {
  const puts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "/api/web-settings") return Response.json({});
    if (init?.method === "PUT") {
      const { promise, resolve } = Promise.withResolvers();
      puts.push({ body: init.body, release: () => resolve(Response.json({})) });
      return promise;
    }
    return get();
  };
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  return puts;
}

// Two overlapping PUTs can resolve out of order and leave the UI showing the
// opposite of the server value — for the agent-tools toggle, a security
// boundary. Each switch must take no second change until its save lands.
for (const [label, body] of [
  ["Resume running sessions after a restart", '{"autoResumeSessions":true}'],
  ["Agent tools (cross-session)", '{"agentToolsEnabled":true}'],
]) {
  test(`${label}: the switch takes no second change until its save lands`, async (t) => {
    const puts = fakeSettings(t, () => Response.json({ autoResumeSessions: false, agentToolsEnabled: false }));
    const { container } = render(createElement(SettingsConfig, settingsProps));
    await settle();
    const toggle = within(container).getByRole("switch", { name: label });
    assert.equal(toggle.disabled, false);

    fireEvent.click(toggle);
    await settle();
    assert.deepEqual(puts.map((p) => p.body), [body]);
    assert.equal(toggle.disabled, true, "an off click now could reach the server before the on");
    fireEvent.click(toggle);
    await settle();
    assert.equal(puts.length, 1);

    puts[0].release();
    await settle();
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
  });
}
