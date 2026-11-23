// Per-turn duration and token totals for one user turn, computed from the
// transcript messages already in memory. Pure: no new data collection, no
// settings, no API calls.
//
// A "turn" is the anchored range planTranscriptRows hands to
// renderTranscriptGroupRow: the user message at startIndex and every message
// up to (not including) endIndex.
//
// Duration is the elapsed time from the anchor message to the last timestamped
// message in the turn, so it covers waiting, model requests and tool
// execution — not just generation. It is null when either end lacks a
// timestamp, which is the honest answer for imported or live-streaming turns
// that do not carry timestamps yet.
//
// Token totals sum the provider-reported `usage` of every assistant message in
// the turn, so a turn with several model requests (tool calls) counts all of
// them, not only the final response. This follows the same accounting as
// usage-service.ts: `input` and `cacheRead` are separate additive fields, so
// cached input is not counted twice. That convention holds for the providers
// omp-web records today; a provider whose `input` already includes cached
// tokens would need provider-specific handling, which this module cannot
// detect from the data — see the #392 follow-up, not this slice.
//
// A usage record only counts when it reports a positive token total, mirroring
// usage-service.ts: a present-but-empty record must not turn into a
// "0 in · 0 out · 0 cached" line. When no record counts, the token totals are
// null (unavailable), never zero.
import type { AgentMessage, AssistantMessage } from "./types";

export interface TurnStats {
  /** Elapsed ms from the anchor message to the last timestamped message in the turn, or null when unavailable. */
  durationMs: number | null;
  /** Uncached input tokens summed over the turn, or null when no usage was reported. */
  inputTokens: number | null;
  /** Output tokens summed over the turn, or null when no usage was reported. */
  outputTokens: number | null;
  /** Cache-read tokens summed over the turn, or null when no usage was reported. */
  cacheReadTokens: number | null;
  /** Cache-write tokens summed over the turn, or null when no usage was reported. */
  cacheWriteTokens: number | null;
  /** How many assistant messages in the turn reported usage. */
  modelRequestCount: number;
}

function numericTimestamp(message: AgentMessage): number | undefined {
  const ts = (message as { timestamp?: unknown }).timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function summarizeTurnStats(
  messages: AgentMessage[],
  startIndex: number,
  endIndex: number,
): TurnStats {
  const start = Math.max(0, startIndex);
  const end = Math.min(messages.length, Math.max(start, endIndex));
  const empty: TurnStats = {
    durationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    modelRequestCount: 0,
  };
  if (end - start < 1) return empty;

  const startTs = numericTimestamp(messages[start]);
  let endTs: number | undefined;
  for (let idx = start + 1; idx < end; idx += 1) {
    const ts = numericTimestamp(messages[idx]);
    if (ts !== undefined && (endTs === undefined || ts > endTs)) endTs = ts;
  }
  const durationMs =
    startTs !== undefined && endTs !== undefined && endTs > startTs
      ? endTs - startTs
      : null;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let modelRequestCount = 0;
  for (let idx = start; idx < end; idx += 1) {
    const msg = messages[idx];
    if (msg.role !== "assistant") continue;
    const usage = (msg as AssistantMessage).usage;
    if (!usage || typeof usage !== "object") continue;
    const total =
      positiveNumber(usage.input) +
      positiveNumber(usage.output) +
      positiveNumber(usage.cacheRead) +
      positiveNumber(usage.cacheWrite);
    if (total <= 0) continue;
    modelRequestCount += 1;
    input += positiveNumber(usage.input);
    output += positiveNumber(usage.output);
    cacheRead += positiveNumber(usage.cacheRead);
    cacheWrite += positiveNumber(usage.cacheWrite);
  }

  return {
    durationMs,
    inputTokens: modelRequestCount > 0 ? input : null,
    outputTokens: modelRequestCount > 0 ? output : null,
    cacheReadTokens: modelRequestCount > 0 ? cacheRead : null,
    cacheWriteTokens: modelRequestCount > 0 ? cacheWrite : null,
    modelRequestCount,
  };
}

/**
 * Short elapsed time for the Process details summary: "45s", "1m 12s",
 * "2h 3m". Sub-second turns show nothing, matching formatDuration: a
 * duration that short is noise in a summary line.
 */
export function formatTurnDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 1_000) return null;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
