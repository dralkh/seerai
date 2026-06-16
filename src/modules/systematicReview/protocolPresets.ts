import { z } from "zod";
import { config } from "../../../package.json";
import { EligibilityRule, ProtocolDimension, ProtocolRevision } from "./types";

const ProtocolPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  researchQuestion: z.string(),
  framework: z.string(),
  frameworkReason: z.string().optional(),
  dimensions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      value: z.string(),
      keywordAids: z.array(z.string()),
      evidenceLabels: z.array(z.string()),
    }),
  ),
  eligibilityRules: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["include", "exclude"]),
      text: z.string(),
      dimensionKey: z.string().optional(),
    }),
  ),
  includeKeywordAids: z.array(z.string()),
  excludeKeywordAids: z.array(z.string()),
});

const ProtocolPresetFileSchema = z.object({
  version: z.literal(1),
  presets: z.array(ProtocolPresetSchema),
});

export interface ProtocolPreset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  researchQuestion: string;
  framework: string;
  frameworkReason?: string;
  dimensions: ProtocolDimension[];
  eligibilityRules: EligibilityRule[];
  includeKeywordAids: string[];
  excludeKeywordAids: string[];
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function presetPath(): string {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    config.addonRef,
    "sr_protocol_presets.json",
  );
}

async function ensureDirectory(): Promise<void> {
  const directory = PathUtils.join(Zotero.DataDirectory.dir, config.addonRef);
  if (!(await IOUtils.exists(directory))) {
    await IOUtils.makeDirectory(directory, { ignoreExisting: true });
  }
}

export async function loadProtocolPresets(): Promise<ProtocolPreset[]> {
  const path = presetPath();
  if (!(await IOUtils.exists(path))) return [];
  try {
    const raw = (await Zotero.File.getContentsAsync(path)) as string;
    return ProtocolPresetFileSchema.parse(JSON.parse(raw)).presets;
  } catch (error) {
    Zotero.debug(`[seerai] Could not load protocol presets: ${error}`);
    return [];
  }
}

async function writeProtocolPresets(presets: ProtocolPreset[]): Promise<void> {
  await ensureDirectory();
  const data = ProtocolPresetFileSchema.parse({
    version: 1,
    presets,
  });
  await Zotero.File.putContentsAsync(
    presetPath(),
    JSON.stringify(data, null, 2),
  );
}

export async function saveProtocolPreset(
  name: string,
  revision: ProtocolRevision,
  existingId?: string,
): Promise<ProtocolPreset> {
  const presets = await loadProtocolPresets();
  const now = new Date().toISOString();
  const existing = existingId
    ? presets.find((preset) => preset.id === existingId)
    : undefined;
  if (
    !existing &&
    presets.some(
      (preset) =>
        preset.name.trim().toLowerCase() === name.trim().toLowerCase(),
    )
  ) {
    throw new Error("A protocol preset with this name already exists");
  }
  const preset: ProtocolPreset = {
    id:
      existing?.id ||
      `protocol_preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    researchQuestion: revision.researchQuestion,
    framework: revision.framework,
    frameworkReason: revision.frameworkReason,
    dimensions: deepCopy(revision.dimensions),
    eligibilityRules: deepCopy(revision.eligibilityRules),
    includeKeywordAids: [...revision.includeKeywordAids],
    excludeKeywordAids: [...revision.excludeKeywordAids],
  };
  const next = presets.filter((candidate) => candidate.id !== preset.id);
  next.push(preset);
  next.sort((a, b) => a.name.localeCompare(b.name));
  await writeProtocolPresets(next);
  return preset;
}

export async function deleteProtocolPreset(id: string): Promise<void> {
  const presets = await loadProtocolPresets();
  await writeProtocolPresets(presets.filter((preset) => preset.id !== id));
}

export function applyProtocolPreset(
  revision: ProtocolRevision,
  preset: ProtocolPreset,
): ProtocolRevision {
  return {
    ...revision,
    researchQuestion: preset.researchQuestion,
    framework: preset.framework,
    frameworkReason: preset.frameworkReason,
    dimensions: deepCopy(preset.dimensions),
    eligibilityRules: deepCopy(preset.eligibilityRules),
    includeKeywordAids: [...preset.includeKeywordAids],
    excludeKeywordAids: [...preset.excludeKeywordAids],
    provenance: [],
    warnings: [],
  };
}

export function protocolPresetToJson(preset: ProtocolPreset): string {
  return JSON.stringify(preset, null, 2);
}

export function revisionToProtocolPreset(
  revision: ProtocolRevision,
  name: string,
): ProtocolPreset {
  return {
    id: "",
    name: name.trim() || "Protocol",
    createdAt: revision.createdAt,
    updatedAt: new Date().toISOString(),
    researchQuestion: revision.researchQuestion,
    framework: revision.framework,
    frameworkReason: revision.frameworkReason,
    dimensions: deepCopy(revision.dimensions),
    eligibilityRules: deepCopy(revision.eligibilityRules),
    includeKeywordAids: [...revision.includeKeywordAids],
    excludeKeywordAids: [...revision.excludeKeywordAids],
  };
}

export function parseProtocolPresetJson(text: string): ProtocolPreset {
  const data = JSON.parse(text);
  return ProtocolPresetSchema.parse(data);
}

export async function importProtocolPreset(
  preset: ProtocolPreset,
): Promise<ProtocolPreset> {
  const presets = await loadProtocolPresets();
  if (
    presets.some(
      (existing) =>
        existing.name.trim().toLowerCase() === preset.name.trim().toLowerCase(),
    )
  ) {
    throw new Error("A protocol preset with this name already exists");
  }
  const now = new Date().toISOString();
  const imported: ProtocolPreset = {
    ...preset,
    id: `protocol_preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: preset.createdAt || now,
    updatedAt: now,
  };
  const next = presets.filter((existing) => existing.id !== imported.id);
  next.push(imported);
  next.sort((a, b) => a.name.localeCompare(b.name));
  await writeProtocolPresets(next);
  return imported;
}
