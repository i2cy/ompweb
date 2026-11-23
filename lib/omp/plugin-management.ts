import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import { basename, extname, join } from "path";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginSettingSchema,
  PluginsResponse,
} from "@/lib/api-types";
import { OMP_NOT_FOUND, resolveOmpBin } from "@/lib/omp/omp-cli";
import { ensureAgentDir } from "@/lib/omp/paths";
import { ANSI_RE, parseJsonLoose } from "@/lib/omp/plugins-cli";
import { publicPluginActions, publicPluginSchema, type OmpActionDeclaration } from "@/lib/omp/plugin-config";
import { createChildProcessEnvironment } from "@/lib/project-command-env";

// Plugin management is delegated to the user's omp binary (`omp plugin ...`);
// omp-web never embeds the Bun-only SDK. `--json` output shapes are mirrored
// from oh-my-pi coding-agent src/cli/plugin-cli.ts + extensibility/plugins.

export interface OmpPluginManifest {
  name?: string;
  version?: string;
  description?: string;
  tools?: string;
  hooks?: string;
  extensions?: string[];
  commands?: string[];
  features?: Record<string, unknown>;
  settings?: Record<string, PluginSettingSchema>;
  actions?: Record<string, OmpActionDeclaration>;
}

interface OmpNpmPlugin {
  name: string;
  version: string;
  path: string;
  manifest?: OmpPluginManifest;
  enabledFeatures?: string[] | null;
  enabled: boolean;
}

interface OmpMarketplaceEntry {
  scope?: "user" | "project";
  installPath?: string;
  version?: string;
  enabled?: boolean;
}

interface OmpMarketplacePlugin {
  id: string;
  scope?: "user" | "project";
  entries?: OmpMarketplaceEntry[];
  shadowedBy?: string;
}

interface OmpPluginList {
  npm?: OmpNpmPlugin[];
  marketplace?: OmpMarketplacePlugin[];
}

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

export function runOmp(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  // Plugin configuration can use a separately deployed OMP without replacing
  // the pinned chat runner and its RPC protocol.
  const bin = process.env.OMP_WEB_PLUGIN_OMP_BIN ?? resolveOmpBin();
  if (!bin) {
    return Promise.reject(new Error(OMP_NOT_FOUND));
  }
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(
    bin,
    args,
    {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }),
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
        reject(new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`));
      } else {
        resolve({ stdout, stderr });
      }
    },
  );
  return promise;
}

/** Best-effort scan of a plugin's skills/ directory (omp discovers plugin-root
 * skills the same way) so the UI can show a resource count. */
async function scanPluginSkills(pluginPath: string): Promise<PluginResourceInfo[]> {
  const skillsDir = join(pluginPath, "skills");
  let entries;
  try {
    const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
    entries = await readDirectory(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const resources: PluginResourceInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) {
      resources.push({
        kind: "skill",
        name: entry.name,
        path: skillPath,
        relativePath: join("skills", entry.name, "SKILL.md"),
      });
    }
  }
  return resources;
}

function manifestResources(pluginPath: string, manifest: OmpPluginManifest | undefined): PluginResourceInfo[] {
  const resources: PluginResourceInfo[] = [];
  const push = (kind: PluginResourceInfo["kind"], rel: string) => {
    const file = basename(rel);
    const ext = extname(file);
    resources.push({
      kind,
      name: ext ? file.slice(0, -ext.length) : file,
      path: join(pluginPath, rel),
      relativePath: rel,
    });
  };
  for (const rel of manifest?.extensions ?? []) push("extension", rel);
  if (manifest?.tools) push("extension", manifest.tools);
  if (manifest?.hooks) push("extension", manifest.hooks);
  // omp "commands" (slash commands) are the closest analog of pi prompts.
  for (const rel of manifest?.commands ?? []) push("prompt", rel);
  return resources;
}

/** Read the installed package, not a request-supplied path. The list command's
 * manifest is a fallback for packages whose package.json is temporarily unreadable. */
export async function readInstalledManifest(pluginPath: string | undefined, fallback?: OmpPluginManifest): Promise<OmpPluginManifest | undefined> {
  if (!pluginPath) return fallback;
  try {
    const pkg = JSON.parse(await fs.readFile(join(pluginPath, "package.json"), "utf8")) as { omp?: OmpPluginManifest; pi?: OmpPluginManifest };
    return pkg.omp ?? pkg.pi ?? fallback;
  } catch {
    return fallback;
  }
}

async function toNpmPackageInfo(plugin: OmpNpmPlugin): Promise<PluginPackageInfo> {
  const manifest = await readInstalledManifest(plugin.path, plugin.manifest);
  const resources = [
    ...manifestResources(plugin.path, manifest),
    ...(await scanPluginSkills(plugin.path)),
  ];
  const counts = emptyCounts();
  for (const resource of resources) {
    if (resource.kind === "extension") counts.extensions += 1;
    else if (resource.kind === "skill") counts.skills += 1;
    else if (resource.kind === "prompt") counts.prompts += 1;
    else counts.themes += 1;
  }
  const installed = Boolean(plugin.path && existsSync(plugin.path));
  const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
  return {
    source: plugin.name,
    scope: "global",
    filtered: Array.isArray(plugin.enabledFeatures),
    disabled: plugin.enabled === false,
    installedPath: plugin.path || undefined,
    packageName: plugin.name,
    version: plugin.version || manifest?.version,
    configuredVersion: undefined,
    settings: publicPluginSchema(manifest?.settings),
    actions: publicPluginActions(manifest?.actions),
    counts,
    resources,
    status: plugin.enabled === false
      ? "disabled"
      : resourceCount > 0
        ? "loaded"
        : installed
          ? "installed"
          : "missing",
  };
}

async function toMarketplacePackageInfo(plugin: OmpMarketplacePlugin): Promise<PluginPackageInfo> {
  const entry = plugin.entries?.[0];
  const installedPath = entry?.installPath;
  const manifest = await readInstalledManifest(installedPath);
  const installed = Boolean(installedPath && existsSync(installedPath));
  const resources = installedPath ? await scanPluginSkills(installedPath) : [];
  const counts = emptyCounts();
  counts.skills = resources.length;
  const disabled = entry?.enabled === false;
  return {
    source: plugin.id,
    scope: plugin.scope === "project" ? "project" : "global",
    filtered: false,
    disabled,
    installedPath: installedPath || undefined,
    packageName: plugin.id,
    version: entry?.version,
    configuredVersion: undefined,
    settings: publicPluginSchema(manifest?.settings),
    actions: publicPluginActions(manifest?.actions),
    counts,
    resources,
    status: disabled ? "disabled" : resources.length > 0 ? "loaded" : installed ? "installed" : "missing",
  };
}

/** Without a cwd, the user level only (a cluster member's settings act on this machine's, spec K7): omp runs in its
 * agent directory, where no project lies, and a project-scope entry is left out all the same. */
export async function readPlugins(cwd: string | null): Promise<PluginsResponse> {
  const diagnostics: PluginDiagnostic[] = [];
  const packages: PluginPackageInfo[] = [];
  const totals = emptyCounts();

  try {
    const { stdout } = await runOmp(["plugin", "list", "--json"], { cwd: cwd ?? ensureAgentDir(), timeout: 60_000 });
    const list = parseJsonLoose<OmpPluginList>(stdout);
    if (!list) {
      diagnostics.push({
        type: "error",
        message: "Could not parse `omp plugin list --json` output.",
      });
    } else {
      for (const plugin of list.npm ?? []) {
        packages.push(await toNpmPackageInfo(plugin));
      }
      for (const plugin of list.marketplace ?? []) {
        if (!cwd && plugin.scope === "project") continue;
        const info = await toMarketplacePackageInfo(plugin);
        if (plugin.shadowedBy) {
          diagnostics.push({
            type: "warning",
            source: plugin.id,
            message: `Shadowed by a ${plugin.shadowedBy}-scoped install of the same plugin.`,
          });
        }
        packages.push(info);
      }
      for (const pkg of packages) {
        totals.extensions += pkg.counts.extensions;
        totals.skills += pkg.counts.skills;
        totals.prompts += pkg.counts.prompts;
        totals.themes += pkg.counts.themes;
      }
    }
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { packages, totals, diagnostics };
}
