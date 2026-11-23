import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runOmp } from "./plugin-management.ts";

test("plugin configuration can use an independent OMP without replacing the chat runner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omp-plugin-runner-"));
  const runnerScript = path.join(directory, "plugin");
  const previousPluginBin = process.env.OMP_WEB_PLUGIN_OMP_BIN;
  const previousRunnerBin = process.env.OMP_WEB_OMP_BIN;
  try {
    await writeFile(runnerScript, "console.log(JSON.stringify({ args: [process.argv[1].split(/[\\\\/]/).pop(), ...process.argv.slice(2)], cwd: process.cwd() }));\n");
    process.env.OMP_WEB_PLUGIN_OMP_BIN = process.execPath;
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
