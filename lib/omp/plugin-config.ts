import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  PluginActionInfo,
  PluginConfigValidationError,
  PluginSecretState,
  PluginSettingSchema,
  PluginSettingValue,
} from "@/lib/api-types";

export const MAX_PLUGIN_ACTION_RESPONSE_BYTES = 256 * 1024;

export interface OmpActionDeclaration {
  module: string;
  export: string;
  description?: string;
}

/** Only schema is public. In particular, a secret's default is a value too and
 * must not cross the server boundary. Action module/export names stay on the
 * server: the browser needs only the declared id and description. */
export function publicPluginSchema(schema: Record<string, PluginSettingSchema> | undefined): Record<string, PluginSettingSchema> {
  return Object.fromEntries(Object.entries(schema ?? {}).map(([key, setting]) => {
    const safe = { ...setting };
    if (safe.secret) delete safe.default;
    return [key, safe];
  }));
}

export function publicPluginActions(actions: Record<string, OmpActionDeclaration> | undefined): Record<string, PluginActionInfo> {
  return Object.fromEntries(Object.entries(actions ?? {}).map(([id, action]) => [id, { description: action.description }]));
}

/** Mirrors omp's validateSetting for the four manifest scalar types. Unknown
 * request keys are rejected separately, before any CLI write is started. */
export function validatePluginSettings(
  schema: Record<string, PluginSettingSchema>,
  values: Record<string, unknown>,
  options: { preserveBlankSecrets?: boolean } = {},
): PluginConfigValidationError[] {
  const errors: PluginConfigValidationError[] = [];
  for (const [key, value] of Object.entries(values)) {
    const setting = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!setting) {
      errors.push({ key, code: "unknown_setting", message: "Unknown setting" });
      continue;
    }
    if (options.preserveBlankSecrets && setting.secret && value === "") continue;

    let message: string | undefined;
    switch (setting.type) {
      case "string":
        if (typeof value !== "string") message = "Expected string";
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) message = "Expected number";
        else if (setting.min !== undefined && value < setting.min) message = `Must be >= ${setting.min}`;
        else if (setting.max !== undefined && value > setting.max) message = `Must be <= ${setting.max}`;
        break;
      case "boolean":
        if (typeof value !== "boolean") message = "Expected boolean";
        break;
      case "enum":
        if (!setting.values.includes(String(value))) message = `Must be one of: ${setting.values.join(", ")}`;
        break;
    }
    if (message) errors.push({ key, code: "invalid_setting", message });
  }
  return errors;
}

export function validateSecretClears(
  schema: Record<string, PluginSettingSchema>,
  keys: string[],
): PluginConfigValidationError[] {
  const errors: PluginConfigValidationError[] = [];
  for (const key of keys) {
    const setting = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (!setting) errors.push({ key, code: "unknown_setting", message: "Unknown setting" });
    else if (!setting.secret) errors.push({ key, code: "not_a_secret", message: "Only secret settings can be cleared" });
  }
  return errors;
}

/** Raw values never leave this function for secret keys. Defaults are exposed
 * only for non-secret settings, matching `omp plugin config list` display. */
export function publicPluginSettings(
  schema: Record<string, PluginSettingSchema>,
  raw: Record<string, unknown>,
): Record<string, PluginSettingValue | PluginSecretState> {
  const entries: Array<[string, PluginSettingValue | PluginSecretState]> = [];
  for (const [key, setting] of Object.entries(schema)) {
    if (setting.secret) {
      entries.push([key, {
        configured: Object.hasOwn(raw, key) && raw[key] !== undefined && raw[key] !== null && raw[key] !== "",
        redacted: true,
      }]);
      continue;
    }
    const value = Object.hasOwn(raw, key) ? raw[key] : setting.default;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

// A scope owns a runtime configuration file. Serializing by scope (rather than
// by plugin) prevents two Web requests for different plugins from interleaving.
// This is deliberately only the Web-side queue; omp's own lock remains the
// authority for coordination with external CLI processes.
const writeTails = new Map<string, Promise<void>>();

export async function serializePluginWrite<T>(scope: "global" | "project", cwd: string | null, operation: () => Promise<T>): Promise<T> {
  const key = scope === "global" ? "global" : `project:${cwd ?? ""}`;
  const previous = writeTails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  const tail = run.then(() => undefined, () => undefined);
  writeTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (writeTails.get(key) === tail) writeTails.delete(key);
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

/** Resolve and execute only an action declaration read from the installed
 * package manifest. Neither the module nor the export is request-controlled. */
export async function executePluginAction(
  packageRoot: string,
  declaration: OmpActionDeclaration,
  cwd: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!declaration || typeof declaration.module !== "string" || !declaration.module || typeof declaration.export !== "string" || !declaration.export) {
    throw new Error("Invalid plugin action declaration");
  }
  signal?.throwIfAborted();
  const root = await realpath(packageRoot);
  const modulePath = await realpath(resolve(root, declaration.module));
  if (!withinRoot(root, modulePath)) throw new Error("Plugin action module is outside the package root");
  // Runtime plugin registry: a static import cannot name an installed package's manifest-selected action module.
  const loaded = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
  const action = Object.hasOwn(loaded, declaration.export) ? loaded[declaration.export] : undefined;
  if (typeof action !== "function") throw new Error("Plugin action export is not a function");
  signal?.throwIfAborted();
  return await (action as (cwd: string, signal?: AbortSignal) => unknown)(cwd, signal);
}

export function serializePluginActionPayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new Error("Plugin action returned a non-JSON result");
  }
  if (json === undefined || Buffer.byteLength(json, "utf8") > MAX_PLUGIN_ACTION_RESPONSE_BYTES) {
    throw new Error("Plugin action result is not bounded JSON");
  }
  return json;
}
