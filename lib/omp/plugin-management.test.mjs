import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runOmp } from "./plugin-management.ts";

test("plugin configuration can use an independent OMP without replacing the chat runner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omp-plugin-runner-"));
  const executable = path.join(directory, "plugin-omp");
  const previousPluginBin = process.env.OMP_WEB_PLUGIN_OMP_BIN;
  const previousRunnerBin = process.env.OMP_WEB_OMP_BIN;
  try {
    await writeFile(executable, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    process.env.OMP_WEB_PLUGIN_OMP_BIN = executable;
    process.env.OMP_WEB_OMP_BIN = path.join(directory, "chat-runner-must-not-be-used");
    const { stdout } = await runOmp(["plugin", "config", "validate"], { cwd: directory });
    assert.deepEqual(JSON.parse(stdout), { args: ["plugin", "config", "validate"], cwd: directory });
  } finally {
    if (previousPluginBin === undefined) delete process.env.OMP_WEB_PLUGIN_OMP_BIN;
    else process.env.OMP_WEB_PLUGIN_OMP_BIN = previousPluginBin;
    if (previousRunnerBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousRunnerBin;
    await rm(directory, { recursive: true, force: true });
  }
});
