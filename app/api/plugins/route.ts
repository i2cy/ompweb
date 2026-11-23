import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { OMP_NOT_FOUND } from "@/lib/omp/omp-cli";
import { ensureAgentDir } from "@/lib/omp/paths";
import { readPlugins, runOmp } from "@/lib/omp/plugin-management";
import type { PluginScope } from "@/lib/api-types";

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

/** Dynamic CLI failures keep their message; a missing omp binary is the one
 * known cause worth a stable code for client-side localization. */
function pluginErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(OMP_NOT_FOUND)) {
    return Response.json({ error: message, code: "omp_not_found" }, { status: 500 });
  }
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");

  try {
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return Response.json(await readPlugins(cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd? }; without a cwd, global changes only.
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
    };
    const cwd = body.cwd || null;
    const scope = readScope(body.scope);
    if (!cwd && scope === "project") return Response.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });
    if (!body.action) return Response.json({ error: "action required", code: "action_required" }, { status: 400 });
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const source = body.source?.trim();
    // A source starting with "-" would be parsed as CLI options by
    // `omp plugin …` instead of a plugin name (e.g. `--scope` consuming
    // the following `--json` as its value) — the same guard the
    // skills-install route applies to package names.
    if (source?.startsWith("-")) {
      return Response.json({ error: "Invalid plugin source", code: "plugin_source_invalid" }, { status: 400 });
    }
    const scopeArgs = scope === "project" ? ["--scope", "project"] : [];
    const dir = cwd ?? ensureAgentDir();

    if (body.action === "install") {
      if (!source) return Response.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(["plugin", "install", source, "--json", ...scopeArgs], { cwd: dir, timeout: 300_000 });
    } else if (body.action === "remove") {
      if (!source) return Response.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(["plugin", "uninstall", source, "--json", ...scopeArgs], { cwd: dir, timeout: 120_000 });
    } else if (body.action === "update") {
      await runOmp(["plugin", "upgrade", ...(source ? [source, ...scopeArgs] : [])], { cwd: dir, timeout: 300_000 });
    } else if (body.action === "disable" || body.action === "enable") {
      if (!source) return Response.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runOmp(["plugin", body.action, source, "--json", ...scopeArgs], { cwd: dir, timeout: 60_000 });
    } else {
      return Response.json({ error: `Unsupported action: ${body.action}`, code: "plugin_unsupported_action" }, { status: 400 });
    }

    return Response.json(await readPlugins(cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}
