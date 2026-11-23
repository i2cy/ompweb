export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
  /** False when the SKILL.md sits outside the user-owned skill roots
   * (plugin, registry, custom directory): listed, but not rewritable. */
  togglable?: boolean;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

interface PluginSettingBase {
  description?: string;
  secret?: boolean;
  env?: string;
}

export type PluginSettingSchema =
  | (PluginSettingBase & { type: "string"; default?: string })
  | (PluginSettingBase & { type: "number"; default?: number; min?: number; max?: number; step?: number })
  | (PluginSettingBase & { type: "boolean"; default?: boolean })
  | (PluginSettingBase & { type: "enum"; values: string[]; default?: string });

export interface PluginActionInfo {
  description?: string;
}

export type PluginSettingValue = string | number | boolean;
export interface PluginSecretState {
  configured: boolean;
  redacted: true;
}

export interface PluginConfigResponse {
  source: string;
  scope: PluginScope;
  schema: Record<string, PluginSettingSchema>;
  settings: Record<string, PluginSettingValue | PluginSecretState>;
  actions: Record<string, PluginActionInfo>;
}

export interface PluginConfigListResponse {
  plugins: Array<Pick<PluginConfigResponse, "source" | "scope" | "schema" | "actions">>;
}

export interface PluginConfigValidationError {
  key: string;
  code: "unknown_setting" | "invalid_setting" | "not_a_secret";
  message: string;
}

export interface PluginConfigWriteResponse {
  valid: boolean;
  errors: PluginConfigValidationError[];
  config?: PluginConfigResponse;
}

export interface PluginActionResponse {
  actionId: string;
  result: unknown;
  completedAt: string;
}

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  settings?: Record<string, PluginSettingSchema>;
  actions?: Record<string, PluginActionInfo>;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}
