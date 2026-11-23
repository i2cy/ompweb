import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import type {
  PluginConfigListResponse,
  PluginConfigResponse,
  PluginPackageInfo,
  PluginScope,
} from "@/lib/api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { ensureAgentDir } from "@/lib/omp/paths";
import { parseJsonLoose } from "@/lib/omp/plugins-cli";
import {
  executePluginAction,
  publicPluginSettings,
  serializePluginActionPayload,
  serializePluginWrite,
  validatePluginSettings,
  validateSecretClears,
} from "@/lib/omp/plugin-config";
import { isRecord } from "@/lib/type-guards";
import { readInstalledManifest, readPlugins, runOmp } from "@/lib/omp/plugin-management";

const MAX_CONFIG_REQUEST_BYTES = 256 * 1024;

interface PluginTarget {
  source: string;
  scope: PluginScope;
  cwd: string | null;
  actionCwd: string;
  configCwd: string;
  pkg: PluginPackageInfo;
}

class ConfigRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function jsonError(error: unknown): Response {
  if (error instanceof ConfigRouteError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof RequestBodyTooLargeError) return Response.json({ error: "Plugin configuration request is too large", code: "request_too_large" }, { status: 413 });
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid JSON request", code: "invalid_json" }, { status: 400 });
  // CLI stdout/stderr and action exceptions can contain credentials. Never
  // forward their messages, and do not copy them into ordinary server logs.
  return Response.json({ error: "Plugin configuration operation failed", code: "plugin_config_failed" }, { status: 500 });
}

function readScope(value: unknown): PluginScope {
  if (value === undefined || value === null || value === "global") return "global";
  if (value === "project") return "project";
  throw new ConfigRouteError(400, "invalid_scope", "scope must be global or project");
}

async function resolveTarget(sourceValue: unknown, scopeValue: unknown, cwdValue: unknown): Promise<PluginTarget> {
  if (typeof sourceValue !== "string" || !sourceValue.trim()) throw new ConfigRouteError(400, "source_required", "source is required");
  const source = sourceValue.trim();
  const scope = readScope(scopeValue);
  if (cwdValue !== undefined && cwdValue !== null && (typeof cwdValue !== "string" || !cwdValue.trim())) {
    throw new ConfigRouteError(400, "invalid_cwd", "cwd must be a workspace path");
  }
  const cwd = typeof cwdValue === "string" ? cwdValue : null;
  if (scope === "project" && !cwd) throw new ConfigRouteError(400, "cwd_required", "cwd is required for project scope");
  if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw new ConfigRouteError(403, "access_denied", "Workspace is not allowed");
  }

  const pkg = (await readPlugins(cwd)).packages.find((candidate) => candidate.source === source && candidate.scope === scope);
  if (!pkg) throw new ConfigRouteError(404, "plugin_not_found", "Installed plugin not found");
  return {
    source,
    scope,
    cwd,
    actionCwd: cwd ?? ensureAgentDir(),
    // A user-level read/write must not accidentally resolve a project's
    // overrides merely because the selected UI workspace supplied a cwd.
    configCwd: scope === "project" ? cwd! : ensureAgentDir(),
    pkg,
  };
}

async function readConfig(target: PluginTarget): Promise<PluginConfigResponse> {
  const scopeArgs = target.scope === "project" ? ["--local"] : [];
  const { stdout } = await runOmp(["plugin", "config", "list", target.source, "--json", ...scopeArgs], { cwd: target.configCwd, timeout: 60_000 });
  const parsed = parseJsonLoose<unknown>(stdout);
  if (!isRecord(parsed) || !isRecord(parsed.settings)) throw new ConfigRouteError(502, "invalid_omp_response", "OMP returned an invalid plugin configuration");
  const schema = target.pkg.settings ?? {};
  return {
    source: target.source,
    scope: target.scope,
    schema,
    settings: publicPluginSettings(schema, parsed.settings),
    actions: target.pkg.actions ?? {},
  };
}

interface ConfigWriteBody {
  source?: unknown;
  scope?: unknown;
  cwd?: unknown;
  settings?: unknown;
  clearSecrets?: unknown;
  validateOnly?: unknown;
}

function readWriteBody(body: ConfigWriteBody): { settings: Record<string, unknown>; clearSecrets: string[]; validateOnly: boolean } {
  if (!isRecord(body.settings)) throw new ConfigRouteError(400, "settings_required", "settings must be an object");
  if (body.clearSecrets !== undefined && (!Array.isArray(body.clearSecrets) || !body.clearSecrets.every((key) => typeof key === "string"))) {
    throw new ConfigRouteError(400, "invalid_secret_clear", "clearSecrets must be an array of setting keys");
  }
  if (body.validateOnly !== undefined && typeof body.validateOnly !== "boolean") {
    throw new ConfigRouteError(400, "invalid_validate_only", "validateOnly must be a boolean");
  }
  return { settings: body.settings, clearSecrets: (body.clearSecrets ?? []) as string[], validateOnly: body.validateOnly === true };
}

async function writeConfig(body: ConfigWriteBody, forceClearOnly: boolean): Promise<Response> {
  const { settings, clearSecrets, validateOnly } = readWriteBody(body);
  if (forceClearOnly && (Object.keys(settings).length > 0 || clearSecrets.length === 0)) {
    throw new ConfigRouteError(400, "secret_clear_required", "DELETE requires only a non-empty clearSecrets array");
  }
  const target = await resolveTarget(body.source, body.scope, body.cwd);
  const schema = target.pkg.settings ?? {};
  const errors = [...validatePluginSettings(schema, settings, { preserveBlankSecrets: true }), ...validateSecretClears(schema, clearSecrets)];
  for (const key of clearSecrets) {
    if (Object.hasOwn(settings, key) && settings[key] !== "") errors.push({ key, code: "invalid_setting", message: "A secret cannot be set and cleared in the same request" });
  }
  if (errors.length > 0) return Response.json({ valid: false, errors }, { status: 400 });
  if (validateOnly) return Response.json({ valid: true, errors: [] });

  const config = await serializePluginWrite(target.scope, target.cwd, async () => {
    const scopeArgs = target.scope === "project" ? ["--local"] : [];
    for (const [key, value] of Object.entries(settings)) {
      if (schema[key]?.secret && value === "") continue;
      await runOmp(["plugin", "config", "set", target.source, key, String(value), ...scopeArgs], { cwd: target.configCwd, timeout: 60_000 });
    }
    for (const key of new Set(clearSecrets)) {
      await runOmp(["plugin", "config", "delete", target.source, key, ...scopeArgs], { cwd: target.configCwd, timeout: 60_000 });
    }
    return readConfig(target);
  });
  return Response.json({ valid: true, errors: [], config });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    const source = params.get("source");
    const scope = params.get("scope") ?? undefined;
    const cwd = params.get("cwd");
    if (!source) {
      if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new ConfigRouteError(403, "access_denied", "Workspace is not allowed");
      const { packages } = await readPlugins(cwd);
      const response: PluginConfigListResponse = {
        plugins: packages.map((pkg) => ({ source: pkg.source, scope: pkg.scope, schema: pkg.settings ?? {}, actions: pkg.actions ?? {} })),
      };
      return Response.json(response);
    }
    return Response.json(await readConfig(await resolveTarget(source, scope, cwd)));
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    return await writeConfig(await parseJsonWithinLimit<ConfigWriteBody>(req, MAX_CONFIG_REQUEST_BYTES), false);
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    return await writeConfig(await parseJsonWithinLimit<ConfigWriteBody>(req, MAX_CONFIG_REQUEST_BYTES), true);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await parseJsonWithinLimit<ConfigWriteBody & { actionId?: unknown }>(req, MAX_CONFIG_REQUEST_BYTES);
    if (Object.hasOwn(body, "module") || Object.hasOwn(body, "export") || Object.hasOwn(body, "command")) {
      throw new ConfigRouteError(400, "invalid_action_request", "Plugin actions accept only an actionId");
    }
    if (typeof body.actionId !== "string" || !body.actionId) throw new ConfigRouteError(400, "action_required", "actionId is required");
    const target = await resolveTarget(body.source, body.scope, body.cwd);
    if (!target.pkg.installedPath) throw new ConfigRouteError(404, "plugin_not_installed", "Plugin package is not installed");
    const manifest = await readInstalledManifest(target.pkg.installedPath);
    const declaration = manifest?.actions && Object.hasOwn(manifest.actions, body.actionId) ? manifest.actions[body.actionId] : undefined;
    if (!declaration) throw new ConfigRouteError(404, "unknown_action", "Plugin action is not declared by the installed manifest");
    const result = await executePluginAction(target.pkg.installedPath, declaration, target.actionCwd, req.signal);
    if (result === undefined || typeof result === "function" || typeof result === "symbol") {
      return Response.json({ error: "Plugin action returned a non-JSON result", code: "invalid_action_result" }, { status: 502 });
    }
    const json = serializePluginActionPayload({ actionId: body.actionId, result, completedAt: new Date().toISOString() });
    return new Response(json, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (error) {
    if (req.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return Response.json({ error: "Plugin action was cancelled", code: "action_aborted" }, { status: 408 });
    }
    if (error instanceof Error && error.message === "Plugin action returned a non-JSON result") {
      return Response.json({ error: "Plugin action returned a non-JSON result", code: "invalid_action_result" }, { status: 502 });
    }
    if (error instanceof Error && error.message === "Plugin action result is not bounded JSON") {
      return Response.json({ error: "Plugin action result is not bounded JSON", code: "action_result_too_large" }, { status: 413 });
    }
    return jsonError(error);
  }
}
