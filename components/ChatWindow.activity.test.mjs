import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test from "node:test";

const { renderActivityPieces } = await import("./ChatWindow-transcript-group-row.tsx");

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });

test("folded activity keeps tool calls from separate messages as separate entries", () => {
  const thinking = { type: "thinking", thinking: "plan" };
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([thinking, call("b"), call("c")]),
    { role: "custom", customType: "developer", content: "notice", display: true },
    assistant([call("d")]),
  ];
  const pieces = [
    { index: 1, blocks: messages[1].content },
    { index: 2, blocks: messages[2].content },
    { index: 3 },
    { index: 4, blocks: messages[4].content },
  ];
  const calls = [];
  renderActivityPieces(messages, pieces, (idx, options) => { calls.push({ idx, options }); return null; });

  // One entry per piece, in order: nothing merged across messages, and the
  // parallel calls of message 2 stay together with their thinking block.
  assert.deepEqual(calls.map(({ idx }) => idx), [1, 2, 3, 4]);
  assert.deepEqual(
    calls.map(({ options }) => options.messageOverride?.content.map((b) => b.toolCallId ?? b.type)),
    [["a"], ["thinking", "b", "c"], undefined, ["d"]],
  );
  assert.deepEqual(calls[1].options.sourceBlockIndices, [0, 1, 2]);
  assert.equal(new Set(calls.map(({ idx, options }) => `${options.keyPrefix}-${idx}`)).size, calls.length);
});

test("a finished turn shows duration and token totals in the Process details summary", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { renderTranscriptGroupRow } = await import("./ChatWindow-transcript-group-row.tsx");
  const { planTranscriptRows } = await import("../lib/chat-transcript-plan.ts");
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const messages = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    { ...assistant([call("a")]), timestamp: 1_005_000, usage: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheWrite: 0, cost: zeroCost } },
    { ...assistant([{ type: "text", text: "done" }]), timestamp: 1_072_000, usage: { input: 500, output: 200, cacheRead: 100, cacheWrite: 0, cost: zeroCost } },
  ];
  const rows = planTranscriptRows(messages, {});
  const group = rows.find((row) => row.kind === "group");
  assert.ok(group, "a turn with tool activity must plan as a group row");
  const rendered = renderTranscriptGroupRow(group, {
    messages,
    renderMessage: (idx) => React.createElement("div", { key: `msg-${idx}` }, `msg-${idx}`),
    flat: false,
    messageRefs: { current: [] },
    visibleRefIndexByMessage: new Map(),
  });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...rendered));
  // 72 s from the user message to the final reply, 13k in / 3.2k out /
  // 8.1k cached across both model requests in the turn.
  assert.match(html, /1m 12s/, `the folded row must show the turn duration, got: ${html.slice(0, 400)}`);
  assert.match(html, /13k in · 3\.2k out · 8\.1k cached|chatWindow\.turnTokens/, `the folded row must show the turn token totals, got: ${html.slice(0, 400)}`);
});

test("a finished turn without timestamps or usage shows no stats in the summary", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { renderTranscriptGroupRow } = await import("./ChatWindow-transcript-group-row.tsx");
  const { planTranscriptRows } = await import("../lib/chat-transcript-plan.ts");
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([{ type: "text", text: "done" }]),
  ];
  const rows = planTranscriptRows(messages, {});
  const group = rows.find((row) => row.kind === "group");
  assert.ok(group, "a turn with tool activity must plan as a group row");
  const rendered = renderTranscriptGroupRow(group, {
    messages,
    renderMessage: (idx) => React.createElement("div", { key: `msg-${idx}` }, `msg-${idx}`),
    flat: false,
    messageRefs: { current: [] },
    visibleRefIndexByMessage: new Map(),
  });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...rendered));
  // Missing data renders as nothing, never as zero.
  assert.doesNotMatch(html, /chatWindow\.turnTokens/);
  assert.doesNotMatch(html, /\d+(\.\d+)?k in/);
  assert.match(html, /Completed \d+ steps?|chatWindow\.completedSteps/);
});

test("a finished turn folds its activity into one Completed N steps row", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { renderTranscriptGroupRow } = await import("./ChatWindow-transcript-group-row.tsx");
  const { planTranscriptRows } = await import("../lib/chat-transcript-plan.ts");
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([{ type: "text", text: "done" }]),
  ];
  const rows = planTranscriptRows(messages, {});
  const group = rows.find((row) => row.kind === "group");
  assert.ok(group, "a turn with tool activity must plan as a group row");
  const rendered = renderTranscriptGroupRow(group, {
    messages,
    renderMessage: (idx) => React.createElement("div", { key: `msg-${idx}` }, `msg-${idx}`),
    flat: false,
    messageRefs: { current: [] },
    visibleRefIndexByMessage: new Map(),
  });
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...rendered));
  // The final reply stays visible; the activity folds to one summary row.
  assert.match(html, /msg-2/, "the final reply must stay expanded");
  assert.match(html, /Completed \d+ steps?|chatWindow\.completedSteps/, `the folded row must read as completed steps, got: ${html.slice(0, 300)}`);
  assert.match(html, /tool calls?|chatWindow\.toolCallCount/, "the folded row must count tool calls");
});
