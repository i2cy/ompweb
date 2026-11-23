"use client";

import { useCallback, useEffect, useState } from "react";
import { formatApiError } from "@/lib/i18n/api-error";
import { useI18n } from "@/lib/i18n";
import type {
  PluginActionResponse,
  PluginConfigResponse,
  PluginConfigValidationError,
  PluginConfigWriteResponse,
  PluginPackageInfo,
  PluginSecretState,
  PluginSettingSchema,
  PluginSettingValue,
} from "@/lib/api-types";

interface ActionState {
  status: "success" | "error";
  message: string;
  result?: unknown;
  at: string;
}

type DraftValue = string | boolean;
type Drafts = Record<string, DraftValue>;

function isSecretState(value: PluginSettingValue | PluginSecretState | undefined): value is PluginSecretState {
  return typeof value === "object" && value !== null && value.redacted === true;
}

function draftsFromConfig(config: PluginConfigResponse): Drafts {
  const drafts = Object.create(null) as Drafts;
  for (const [key, schema] of Object.entries(config.schema)) {
    if (schema.secret) {
      drafts[key] = "";
      continue;
    }
    const value = config.settings[key];
    if (schema.type === "boolean") drafts[key] = typeof value === "boolean" ? value : false;
    else if (schema.type === "enum") drafts[key] = typeof value === "string" ? value : (schema.values[0] ?? "");
    else drafts[key] = typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  return drafts;
}

function targetParams(pkg: PluginPackageInfo, cwd: string | null): URLSearchParams {
  const params = new URLSearchParams({ source: pkg.source, scope: pkg.scope });
  if (cwd) params.set("cwd", cwd);
  return params;
}

function fieldErrors(data: { errors?: PluginConfigValidationError[] }): string | null {
  return data.errors?.length ? data.errors.map((error) => `${error.key}: ${error.message}`).join("\n") : null;
}

function ScalarInput({
  settingKey,
  schema,
  value,
  secretState,
  disabled,
  onChange,
}: {
  settingKey: string;
  schema: PluginSettingSchema;
  value: DraftValue;
  secretState?: PluginSecretState;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const { t } = useI18n();
  const common = {
    id: `plugin-setting-${settingKey}`,
    "aria-label": settingKey,
    disabled,
  };
  const style: React.CSSProperties = {
    width: "100%",
    minHeight: 34,
    padding: "6px 9px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: schema.type === "string" || schema.secret ? "var(--font-mono)" : undefined,
    fontSize: 12,
  };

  if (schema.secret) {
    return (
      <input
        {...common}
        type="password"
        value={String(value)}
        autoComplete="off"
        placeholder={secretState?.configured ? t("pluginsConfig.secretKeep") : t("pluginsConfig.secretNotConfigured")}
        onChange={(event) => onChange(event.target.value)}
        style={style}
      />
    );
  }
  if (schema.type === "boolean") {
    return (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
        style={{ width: 18, height: 18, accentColor: "var(--accent-strong)" }}
      />
    );
  }
  if (schema.type === "enum") {
    return (
      <select {...common} value={String(value)} onChange={(event) => onChange(event.target.value)} style={style}>
        {schema.values.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (schema.type === "number") {
    return (
      <input
        {...common}
        type="number"
        value={String(value)}
        min={schema.min}
        max={schema.max}
        step={schema.step}
        onChange={(event) => onChange(event.target.value)}
        style={style}
      />
    );
  }
  return <input {...common} type="text" value={String(value)} onChange={(event) => onChange(event.target.value)} style={style} />;
}

/** Manifest-driven control plane only. All values, validation, secret handling
 * and actions remain generic and are executed by the server/installed plugin. */
export function PluginSettingsForm({ pkg, cwd }: { pkg: PluginPackageInfo; cwd: string | null }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<PluginConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>({});

  const applyConfig = useCallback((next: PluginConfigResponse) => {
    setConfig(next);
    setDrafts(draftsFromConfig(next));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/plugin-config?${targetParams(pkg, cwd)}`);
      const data = await response.json() as PluginConfigResponse & { error?: string; code?: string };
      if (!response.ok || data.error) throw new Error(formatApiError(data.error ? data : `HTTP ${response.status}`));
      applyConfig(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [applyConfig, cwd, pkg]);

  useEffect(() => { void load(); }, [load]);

  const valuesFromDrafts = useCallback((): Record<string, unknown> => {
    if (!config) return {};
    return Object.fromEntries(Object.entries(config.schema).map(([key, schema]) => {
      const value = drafts[key];
      if (!schema.secret && schema.type === "number") return [key, String(value).trim() === "" ? null : Number(value)];
      return [key, value ?? ""];
    }));
  }, [config, drafts]);

  const saveOrValidate = useCallback(async (validateOnly: boolean) => {
    if (!config) return;
    setBusy(validateOnly ? "validate" : "save");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/plugin-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: pkg.source,
          scope: pkg.scope,
          cwd,
          settings: valuesFromDrafts(),
          clearSecrets: [],
          validateOnly,
        }),
      });
      const data = await response.json() as Partial<PluginConfigWriteResponse> & { error?: string; code?: string };
      if (!response.ok || data.error || data.valid === false) {
        throw new Error(fieldErrors(data) ?? formatApiError(data.error ? data : `HTTP ${response.status}`));
      }
      if (data.config) applyConfig(data.config);
      setMessage(t(validateOnly ? "pluginsConfig.settingsValid" : "pluginsConfig.settingsSaved"));
      setCompletedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCompletedAt(new Date().toISOString());
    } finally {
      setBusy(null);
    }
  }, [applyConfig, config, cwd, pkg.source, pkg.scope, t, valuesFromDrafts]);

  const clearSecret = useCallback(async (key: string) => {
    setBusy(`clear:${key}`);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/plugin-config", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: pkg.source, scope: pkg.scope, cwd, settings: {}, clearSecrets: [key] }),
      });
      const data = await response.json() as Partial<PluginConfigWriteResponse> & { error?: string; code?: string };
      if (!response.ok || data.error || !data.config) throw new Error(fieldErrors(data) ?? formatApiError(data.error ? data : `HTTP ${response.status}`));
      applyConfig(data.config);
      setMessage(t("pluginsConfig.secretCleared", { key }));
      setCompletedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCompletedAt(new Date().toISOString());
    } finally {
      setBusy(null);
    }
  }, [applyConfig, cwd, pkg.source, pkg.scope, t]);

  const runAction = useCallback(async (actionId: string) => {
    setBusy(`action:${actionId}`);
    setError(null);
    try {
      const response = await fetch("/api/plugin-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: pkg.source, scope: pkg.scope, cwd, actionId }),
      });
      const data = await response.json() as Partial<PluginActionResponse> & { error?: string; code?: string };
      const at = data.completedAt ?? new Date().toISOString();
      if (!response.ok || data.error) {
        const actionError = formatApiError(data.error ? data : `HTTP ${response.status}`);
        setActionStates((current) => ({ ...current, [actionId]: { status: "error", message: actionError, at } }));
      } else {
        const result = data.result;
        const failed = typeof result === "object" && result !== null && "status" in result && result.status === "failed";
        let lastErrorMessage: string | undefined;
        if (failed && "lastError" in result) {
          const lastError: unknown = result.lastError;
          if (typeof lastError === "object" && lastError !== null && "message" in lastError && typeof lastError.message === "string") {
            lastErrorMessage = lastError.message;
          }
        }
        const message = failed
          ? (lastErrorMessage ?? t("pluginsConfig.actionErrorTitle", { action: actionId }))
          : t("pluginsConfig.actionCompleted");
        setActionStates((current) => ({ ...current, [actionId]: { status: failed ? "error" : "success", message, result, at } }));
      }
    } catch (cause) {
      setActionStates((current) => ({ ...current, [actionId]: { status: "error", message: cause instanceof Error ? cause.message : String(cause), at: new Date().toISOString() } }));
    } finally {
      setBusy(null);
    }
  }, [cwd, pkg.source, pkg.scope, t]);

  if (!pkg.settings || Object.keys(pkg.settings).length === 0) {
    if (!pkg.actions || Object.keys(pkg.actions).length === 0) return null;
  }
  if (loading) return <div role="status" style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("pluginsConfig.loadingSettings")}</div>;
  if (!config) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div role="alert" style={{ fontSize: 12, color: "var(--status-error)" }}>{error}</div>
        <button type="button" onClick={() => void load()}>{t("pluginsConfig.retrySettings")}</button>
      </div>
    );
  }

  const disabled = busy !== null;
  return (
    <section aria-label={t("pluginsConfig.configuration")} style={{ display: "flex", flexDirection: "column", gap: 16, borderTop: "1px solid var(--border)", paddingTop: 18 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 13, color: "var(--text)" }}>{t("pluginsConfig.configuration")}</h3>
        <p style={{ margin: "4px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>{t("pluginsConfig.configurationHelp")}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {Object.entries(config.schema).map(([key, schema]) => {
          const value = config.settings[key];
          const secretState = isSecretState(value) ? value : undefined;
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label htmlFor={`plugin-setting-${key}`} style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{key}</label>
              {schema.description && <div style={{ fontSize: 11, lineHeight: 1.45, color: "var(--text-dim)" }}>{schema.description}</div>}
              <ScalarInput
                settingKey={key}
                schema={schema}
                value={drafts[key] ?? (schema.type === "boolean" ? false : "")}
                secretState={secretState}
                disabled={disabled}
                onChange={(next) => setDrafts((current) => ({ ...current, [key]: next }))}
              />
              {secretState && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--text-dim)" }}>
                  <span>{secretState.configured ? t("pluginsConfig.secretConfigured") : t("pluginsConfig.secretNotConfigured")}</span>
                  <button
                    type="button"
                    aria-label={t("pluginsConfig.clearSecret", { key })}
                    disabled={disabled || !secretState.configured}
                    onClick={() => void clearSecret(key)}
                    style={{ border: "none", background: "none", padding: 0, color: "var(--status-error)", cursor: disabled ? "not-allowed" : "pointer", opacity: secretState.configured ? 1 : 0.5 }}
                  >
                    {busy === `clear:${key}` ? t("pluginsConfig.clearing") : t("pluginsConfig.clear")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {Object.keys(config.schema).length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" disabled={disabled} onClick={() => void saveOrValidate(false)}>{busy === "save" ? t("pluginsConfig.saving") : t("pluginsConfig.saveSettings")}</button>
          <button type="button" disabled={disabled} onClick={() => void saveOrValidate(true)}>{busy === "validate" ? t("pluginsConfig.validating") : t("pluginsConfig.validateSettings")}</button>
        </div>
      )}

      {message && <div role="status" style={{ fontSize: 12, color: "var(--status-success)" }}>{message}</div>}
      {error && <div role="alert" style={{ fontSize: 12, color: "var(--status-error)", whiteSpace: "pre-wrap" }}>{error}</div>}
      {completedAt && <time dateTime={completedAt} style={{ fontSize: 10, color: "var(--text-dim)" }}>{new Date(completedAt).toLocaleString()}</time>}

      {Object.keys(config.actions).length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h4 style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("pluginsConfig.declaredActions")}</h4>
          {Object.entries(config.actions).map(([actionId, action]) => {
            const state = Object.hasOwn(actionStates, actionId) ? actionStates[actionId] : undefined;
            return (
              <div key={actionId} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{actionId}</div>
                {action.description && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{action.description}</div>}
                <div><button type="button" disabled={disabled} onClick={() => void runAction(actionId)}>{busy === `action:${actionId}` ? t("pluginsConfig.runningAction") : t("pluginsConfig.runAction", { action: actionId })}</button></div>
                {state && (
                  <div role={state.status === "error" ? "alert" : "status"} style={{ fontSize: 11, color: state.status === "error" ? "var(--status-error)" : "var(--status-success)" }}>
                    <div>{state.message}</div>
                    <time dateTime={state.at} style={{ color: "var(--text-dim)" }}>{new Date(state.at).toLocaleString()}</time>
                    {state.result !== undefined && <pre style={{ maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-muted)", background: "var(--bg-panel)", padding: 8 }}>{JSON.stringify(state.result, null, 2)}</pre>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
