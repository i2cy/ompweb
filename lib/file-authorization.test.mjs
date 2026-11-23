import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Regression tests for bug hunt round 1 (#295), security area: the generic
// file API must never serve omp's credential files, and a symlink — or a
// symlinked config root — must not launder a denied file into a browsable
// one. Synthetic fixtures only.
const { authorizeFileAccess } = await import("./file-authorization.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");

function writeSessionFile(dir, name, header, entries = []) {
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);
}

const segs = (p) => p.split("/").filter(Boolean);

test("denies a session-referenced models.yml under a symlinked config root", async (t) => {
  // Review item 5 (#295): getConfigAgentRoots() used to return lexical
  // paths, so a denied file under a symlinked configured root could slip
  // past the denied check and be admitted by the session-reference branch.
  // The secret policy is canonical now (resolved-path/inode checks, #394);
  // this pins that a symlinked root still denies.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-authz-")));
  const realConfig = path.join(base, "real-config");
  const agentDir = path.join(realConfig, "agent");
  const ws = path.join(base, "ws");
  fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.symlinkSync(realConfig, path.join(base, "config"), "dir");
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    home: process.env.HOME,
    configDir: process.env.PI_CONFIG_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = base;
  process.env.PI_CONFIG_DIR = "config";
  delete process.env.XDG_DATA_HOME;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateSessionListCache();
    fs.rmSync(base, { recursive: true, force: true });
  });

  // The file lives under the real root; the session references the lexical
  // (symlinked) spelling, which is outside every lexical config root.
  const modelsYml = path.join(agentDir, "models.yml");
  fs.writeFileSync(modelsYml, "apiKey: sk-SECRET\n");
  const lexical = path.join(base, "config", "agent", "models.yml");
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  writeSessionFile(path.join(agentDir, "sessions", "-project"), "2026-01-01_ref.jsonl", {
    id: sessionId,
    cwd: ws,
    timestamp: "2026-01-01T00:00:00.000Z",
  }, [
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: `please look at ${lexical}` }] } },
  ]);
  invalidateSessionListCache();
  const decision = await authorizeFileAccess(segs(lexical), sessionId, true, new Set([ws]));
  assert.equal(decision.ok, false, "session-referenced models.yml under a symlinked root must be denied");
  assert.equal(decision.status, 403);
});

test("denies a denied file reached through a session-referenced symlink outside any root", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-authz-")));
  const agentDir = path.join(base, "agent");
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    home: process.env.HOME,
    configDir: process.env.PI_CONFIG_DIR,
    xdg: process.env.XDG_DATA_HOME,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = base;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateSessionListCache();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const agentDb = path.join(agentDir, "agent.db");
  fs.writeFileSync(agentDb, "SECRET-AGENT-DB");
  const link = path.join(outside, "ref.db");
  fs.symlinkSync(agentDb, link);
  // A session whose transcript mentions the link: without the denied check
  // running on the realpath first, the session-reference admission alone
  // would let this through (it skips the existing-path root check).
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  writeSessionFile(path.join(agentDir, "sessions", "-project"), "2026-01-01_ref.jsonl", {
    id: sessionId,
    cwd: ws,
    timestamp: "2026-01-01T00:00:00.000Z",
  }, [
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: `please look at ${link}` }] } },
  ]);
  invalidateSessionListCache();
  const decision = await authorizeFileAccess(segs(link), sessionId, true, new Set([ws]));
  assert.equal(decision.ok, false, "session-referenced symlink to agent.db must be denied");
  assert.equal(decision.status, 403);
});
