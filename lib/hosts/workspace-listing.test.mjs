import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filePathApiSegments } from "../file-paths.ts";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

/** A granted root with no live host: the direct-service pattern of
 * workspace-git.test.mjs. `opsModule` supplies `createWorkspaceService` (a
 * fresh import when the test fakes a builtin). */
async function listingService(t, opsModule) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-listing-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
  const { StagedUploads } = await import("./uploads.ts");
  const service = opsModule.createWorkspaceService(new StagedUploads(() => {}), () => {});
  t.after(() => {
    service.stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  grantWorkspaceRoot(root);
  return { root, service };
}

/** A granted root with no service: for tests that build their own service
 * from a fresh module import. */
async function listingRoot(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-listing-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  grantWorkspaceRoot(root);
  return root;
}

test("listFiles lists the authorized directory", async (t) => {
  const opsModule = await import("./workspace-ops.ts");
  const { root, service } = await listingService(t, opsModule);
  const dir = join(root, "dir");
  mkdirSync(dir);
  writeFileSync(join(dir, "note.txt"), "inside\n");
  const result = await service.ops.listFiles({ segments: filePathApiSegments(dir), sessionId: null }, false);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.entries.map((entry) => entry.name), ["note.txt"]);
});

test("listFiles reports file_changed when the listed directory is swapped for a symlink mid-listing (#396)", async (t) => {
  const root = await listingRoot(t);
  const dir = join(root, "dir");
  const saved = join(root, "dir.saved");
  // Outside every granted root: a sibling temp directory, never granted.
  const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "omp-listing-outside-")));
  const outside = join(outsideRoot, "outside");
  mkdirSync(dir);
  mkdirSync(outside);
  writeFileSync(join(dir, "note.txt"), "inside\n");
  writeFileSync(join(outside, "OUTSIDE_MARKER.txt"), "outside\n");
  const realFs = fs;
  let swapped = false;
  // The swap lands after authorize (which runs before readdir) and before
  // listDirectory's re-stat: exactly the window #396's parent swap exploits.
  // The directory stays swapped, so the re-stat must see the outside
  // directory's identity and refuse with 409 file_changed.
  // authorizeFileAccess hands listDirectory the native-canonical spelling of
  // the directory, which on Windows need not equal this test's spelling
  // (8.3 short names, drive-letter case): compare canonical paths so the
  // mock fires on every platform.
  const canonicalDir = (() => {
    try {
      const native = realFs.realpathSync.native ?? realFs.realpathSync;
      return native(dir);
    } catch {
      return dir;
    }
  })();
  const isListedDirectory = (spelled) => {
    const candidate = typeof spelled === "string" ? spelled : spelled.toString();
    if (candidate === dir || candidate === canonicalDir) return true;
    try {
      const native = realFs.realpathSync.native ?? realFs.realpathSync;
      return native(candidate) === canonicalDir;
    } catch {
      return false;
    }
  };
  await mockBuiltin(t, "node:fs", {
    readdirSync(path, options) {
      if (!swapped && isListedDirectory(path)) {
        swapped = true;
        renameSync(dir, saved);
        symlinkSync(outside, dir);
      }
      return realFs.readdirSync(path, options);
    },
  });
  const fresh = await import("./workspace-ops.ts?fresh=396");
  const { StagedUploads } = await import("./uploads.ts");
  const freshService = fresh.createWorkspaceService(new StagedUploads(() => {}), () => {});
  t.after(() => freshService.stop());
  let result;
  try {
    result = await freshService.ops.listFiles({ segments: filePathApiSegments(dir), sessionId: null }, false);
  } finally {
    // The mocked readdir left the directory swapped; put it back so the
    // fixture cleanup can remove it.
    try { unlinkSync(dir); } catch { /* already a real directory */ }
    try { renameSync(saved, dir); } catch { /* never swapped away */ }
    rmSync(outsideRoot, { recursive: true, force: true });
  }
  assert.equal(swapped, true, "the mocked readdir never ran for the listed directory");
  assert.deepEqual(result, { ok: false, status: 409, code: "file_changed", error: "The directory changed while it was being listed" });
});
