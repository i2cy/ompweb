import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real /api/sessions/[id]/export against a fake live session host. Bug hunt
// round 1 (#295): exports were served `inline` from the authenticated
// origin with no sandboxing, so attacker-influenced transcript HTML
// (event-handler attributes) executed in omp-web's origin. Exports must now
// always download as an attachment, even when ?inline=1 is asked — including
// for this machine's own daemon, whose HTML is the exporter's output either
// way. The fake host keeps this test platform-independent: the original
// omp-stub.sh approach could not run on Windows CI (review item 7).
const exportRoute = await import("../app/api/sessions/[id]/export/route.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const { closeHostLink } = await import("./hosts/hub.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");

const EXPORT_HTML = "<html><body><img src=x onerror=alert(2)></body></html>";

async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-export-route-"));
  mkdirSync(join(agentDir, "sessions", "-project"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  globalThis.__ompHostLists = undefined;
  try {
    await run();
  } finally {
    closeHostLink("local");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    closeOutboxStore();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("serves exports as attachments even when inline is requested", async (t) => {
  const id = "0a000000-0000-4000-8000-000000000022";
  const exported = [];
  const host = {
    id: "local",
    label: "This machine",
    status: () => "online",
    sessionOps: {
      async exportSession(sessionId) {
        exported.push(sessionId);
        return { ok: true, value: { html: EXPORT_HTML, fileName: "live.html" } };
      },
    },
  };
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[id, { isAlive: () => true, host }]]);
  t.after(() => { globalThis.__ompSessions = previousSessions; });

  await withAgentDir(async () => {
    for (const query of ["?inline=1", ""]) {
      const res = await exportRoute.GET(
        new Request(`http://localhost/api/sessions/${id}/export${query}`),
        { params: Promise.resolve({ id }) },
      );
      assert.equal(res.status, 200, `export${query} must succeed`);
      assert.match(res.headers.get("Content-Disposition") ?? "", /^attachment;/, `export${query} must be attachment-only`);
      assert.equal(await res.text(), EXPORT_HTML);
    }
    assert.deepEqual(exported, [id, id]);
  });
});
