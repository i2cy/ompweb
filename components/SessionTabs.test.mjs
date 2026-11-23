import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";
import React from "react";

const { act, cleanup, fireEvent, render } = await import("@testing-library/react/pure.js");
const { SessionTabs } = await import("./SessionTabs.tsx");

const sessions = [
  { id: "s1", path: "/a", cwd: "/a", name: "First session", created: "2026-01-01", modified: "2026-01-01", messageCount: 3, firstMessage: "first" },
  { id: "s2", path: "/b", cwd: "/b", name: "", created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: "second prompt" },
];

async function renderTabs(t, props = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url) === "/api/sessions") {
      return Response.json({
        sessions,
        runningSessionIds: ["s2"],
        runningSessions: [{ id: "s2", cwd: "/b", awaitingInput: true }],
      });
    }
    return Response.json({});
  };
  const selected = [];
  const closed = [];
  const view = render(React.createElement(SessionTabs, {
    tabs: [{ id: "s1" }, { id: "s2" }],
    selectedId: "s1",
    onSelect: (session) => selected.push(session.id),
    onClose: (tab, next) => closed.push({ tab: tab.id, next: next?.id ?? null }),
    ...props,
  }));
  t.after(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return { view, selected, closed };
}

test("session tabs show titles, mark the running one, and switch on click", async (t) => {
  const { view, selected } = await renderTabs(t);
  const tabs = view.getAllByRole("tab");
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["First session", "second prompt"]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("aria-selected"), "false");
  // s2 is running and waiting for input: its tab carries the indicator dot.
  assert.ok(tabs[1].querySelector("span[aria-hidden]"), "the running tab must show its indicator");
  assert.match(tabs[1].getAttribute("title"), /Waiting for input|sessionTabs\.awaitingInput/);
  fireEvent.click(tabs[1]);
  assert.deepEqual(selected, ["s2"]);
});

test("closing the selected tab offers its neighbour", async (t) => {
  const { view, closed } = await renderTabs(t);
  const closeButtons = [...view.container.querySelectorAll("button")].filter((button) => (button.getAttribute("aria-label") ?? "").match(/Close|sessionTabs\.closeTab/));
  assert.equal(closeButtons.length, 2, "each tab needs a close button");
  fireEvent.click(closeButtons[0]);
  assert.deepEqual(closed, [{ tab: "s1", next: "s2" }]);
});

test("no tabs renders nothing", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ sessions: [] });
  t.after(() => { cleanup(); globalThis.fetch = originalFetch; });
  const view = render(React.createElement(SessionTabs, { tabs: [], selectedId: null, onSelect: () => {}, onClose: () => {} }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(view.container.innerHTML, "");
});
