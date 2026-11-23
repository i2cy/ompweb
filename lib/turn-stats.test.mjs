import assert from "node:assert/strict";
import test from "node:test";

const { summarizeTurnStats, formatTurnDuration } = await import("./turn-stats.ts");

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const assistant = (content, extra = {}) => ({ role: "assistant", provider: "p", model: "m", content, ...extra });
const usage = (input, output, cacheRead, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cost: zeroCost });
const text = (text) => ({ type: "text", text });
const call = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: { command: id } });

test("sums usage across every assistant message in the turn", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([call("a")], { timestamp: 1_005_000, usage: usage(12_000, 3_000, 8_000) }),
    assistant([text("done")], { timestamp: 1_010_000, usage: usage(500, 200, 100, 50) }),
  ];
  const stats = summarizeTurnStats(messages, 0, 3);
  assert.equal(stats.modelRequestCount, 2);
  assert.equal(stats.inputTokens, 12_500);
  assert.equal(stats.outputTokens, 3_200);
  assert.equal(stats.cacheReadTokens, 8_100);
  assert.equal(stats.cacheWriteTokens, 50);
  assert.equal(stats.durationMs, 10_000);
});

test("ignores messages outside the turn range and messages without usage", () => {
  const messages = [
    assistant([text("earlier")], { timestamp: 900_000, usage: usage(999_000, 999_000, 999_000) }),
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([call("a")], { timestamp: 1_005_000 }),
    assistant([text("done")], { timestamp: 1_010_000, usage: usage(100, 50, 25) }),
    assistant([text("later")], { timestamp: 2_000_000, usage: usage(777_000, 777_000, 777_000) }),
  ];
  const stats = summarizeTurnStats(messages, 1, 4);
  assert.equal(stats.modelRequestCount, 1);
  assert.equal(stats.inputTokens, 100);
  assert.equal(stats.outputTokens, 50);
  assert.equal(stats.cacheReadTokens, 25);
  assert.equal(stats.durationMs, 10_000);
});

test("returns nulls, not zeros, when the turn reports no usage", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([call("a")], { timestamp: 1_005_000 }),
    assistant([text("done")], { timestamp: 1_010_000 }),
  ];
  const stats = summarizeTurnStats(messages, 0, 3);
  assert.equal(stats.modelRequestCount, 0);
  assert.equal(stats.inputTokens, null);
  assert.equal(stats.outputTokens, null);
  assert.equal(stats.cacheReadTokens, null);
  assert.equal(stats.cacheWriteTokens, null);
  assert.equal(stats.durationMs, 10_000);
});

test("an all-zero usage record does not count as reported usage", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([text("done")], { timestamp: 1_010_000, usage: usage(0, 0, 0, 0) }),
  ];
  const stats = summarizeTurnStats(messages, 0, 2);
  assert.equal(stats.modelRequestCount, 0);
  assert.equal(stats.inputTokens, null);
});

test("duration runs to the last timestamped message in the turn", () => {
  const messages = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([call("a")], { timestamp: 1_005_000, usage: usage(10, 5, 0) }),
    { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "ok" }], timestamp: 1_030_000 },
  ];
  const stats = summarizeTurnStats(messages, 0, 3);
  assert.equal(stats.durationMs, 30_000);
});

test("duration is null without an anchor timestamp, or when the turn does not advance", () => {
  const noAnchorTs = [
    { role: "user", content: "go" },
    assistant([text("done")], { timestamp: 1_010_000, usage: usage(10, 5, 0) }),
  ];
  assert.equal(summarizeTurnStats(noAnchorTs, 0, 2).durationMs, null);

  const noEndTs = [
    { role: "user", content: "go", timestamp: 1_000_000 },
    assistant([text("done")], { usage: usage(10, 5, 0) }),
  ];
  assert.equal(summarizeTurnStats(noEndTs, 0, 2).durationMs, null);

  const backwards = [
    { role: "user", content: "go", timestamp: 1_010_000 },
    assistant([text("done")], { timestamp: 1_000_000, usage: usage(10, 5, 0) }),
  ];
  assert.equal(summarizeTurnStats(backwards, 0, 2).durationMs, null);
});

test("an empty range returns nulls", () => {
  const stats = summarizeTurnStats([{ role: "user", content: "go" }], 0, 0);
  assert.deepEqual(stats, {
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    modelRequestCount: 0,
  });
});

test("formatTurnDuration keeps seconds precision below an hour", () => {
  assert.equal(formatTurnDuration(null), null);
  assert.equal(formatTurnDuration(undefined), null);
  assert.equal(formatTurnDuration(0), null);
  assert.equal(formatTurnDuration(999), null);
  assert.equal(formatTurnDuration(1_000), "1s");
  assert.equal(formatTurnDuration(45_000), "45s");
  assert.equal(formatTurnDuration(72_000), "1m 12s");
  assert.equal(formatTurnDuration(120_000), "2m");
  assert.equal(formatTurnDuration(3_599_000), "59m 59s");
  assert.equal(formatTurnDuration(3_600_000), "1h 0m");
  assert.equal(formatTurnDuration(3_720_000), "1h 2m");
});
