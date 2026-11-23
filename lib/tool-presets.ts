export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export function isToolPreset(value: unknown): value is ToolPreset {
  return value === "none" || value === "default" || value === "full";
}

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {

  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return undefined;
  return [...PRESET_DEFAULT];
}

export function getPresetForToolNames(toolNames: string[] | undefined): ToolPreset | null {
  if (toolNames === undefined) return "full";
  if (toolNames.length === 0) return "none";
  const key = [...toolNames].map((name) => name.toLowerCase()).sort().join(",");
  return key === [...PRESET_DEFAULT].sort().join(",") ? "default" : null;
}

/** How many tools a preset grants: null for "full" (unrestricted — whatever omp ships). */
export function getToolPresetToolCount(preset: ToolPreset): number | null {
  const names = getToolNamesForPreset(preset);
  return names === undefined ? null : names.length;
}
