import * as v from 'valibot';
import type { VisualPatch } from './types';

export const CURRENT_SCHEMA_VERSION = 1;

const modulationPolaritySchema = v.picklist(['unipolar', 'bipolar']);
export const paletteModeSchema = v.picklist([
  'mono',
  'analogous',
  'complementary',
  'triadic',
  'rainbow',
]);
export const qualityTierSchema = v.picklist(['low', 'medium', 'high']);

const paramValueSchema = v.union([v.number(), v.string(), v.boolean()]);

const visualOperatorSchema = v.object({
  id: v.string(),
  generatorId: v.string(),
  generatorVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  parameters: v.record(v.string(), paramValueSchema),
});

const modulationRouteSchema = v.object({
  source: v.string(),
  target: v.string(),
  amount: v.pipe(v.number(), v.finite()),
  polarity: modulationPolaritySchema,
  smoothing: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

export const paletteSpecSchema = v.object({
  mode: paletteModeSchema,
  hueOffset: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(360)),
  saturation: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
  lightness: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
});

export const compositionSpecSchema = v.object({
  symmetry: v.pipe(v.number(), v.finite()),
  scale: v.pipe(v.number(), v.finite()),
  speed: v.pipe(v.number(), v.finite()),
});

/** 画像そのものではなく参照だけ。ピクセルは Patch に入らない。 */
const imageRefSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  hash: v.pipe(v.string(), v.minLength(1)),
});

export const visualPatchSchema = v.object({
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  seed: v.string(),
  operators: v.array(visualOperatorSchema),
  routes: v.array(modulationRouteSchema),
  palette: paletteSpecSchema,
  composition: compositionSpecSchema,
  qualityTier: qualityTierSchema,
  // 任意フィールド。既存の Patch（images 無し）はそのまま通るので
  // schemaVersion は 1 のまま据え置く（後方互換な追加）。
  images: v.optional(v.record(v.string(), imageRefSchema)),
});

/** Recursively sort object keys for deterministic JSON serialization. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Migration chain: key is the version being migrated FROM.
 * migrations[n] transforms a patch at schemaVersion n into n+1.
 */
const migrations: Record<number, (input: unknown) => unknown> = {
  // version 1 is current; no migration from 1 needed yet
};

export function migratePatch(input: unknown): unknown {
  if (input === null || typeof input !== 'object') {
    throw new Error('migratePatch: input must be an object');
  }
  const obj = input as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new Error('migratePatch: schemaVersion must be an integer');
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `migratePatch: unsupported schemaVersion ${version} (current is ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  if (version < 1) {
    throw new Error(`migratePatch: invalid schemaVersion ${version}`);
  }

  let current: unknown = input;
  let vNum = version;
  while (vNum < CURRENT_SCHEMA_VERSION) {
    const migrate = migrations[vNum];
    if (!migrate) {
      throw new Error(`migratePatch: missing migration from version ${vNum}`);
    }
    current = migrate(current);
    vNum += 1;
    if (current && typeof current === 'object') {
      (current as Record<string, unknown>).schemaVersion = vNum;
    }
  }
  return current;
}

export function parsePatch(
  input: unknown,
): { ok: true; patch: VisualPatch } | { ok: false; issues: string[] } {
  let migrated: unknown;
  try {
    migrated = migratePatch(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, issues: [message] };
  }

  const result = v.safeParse(visualPatchSchema, migrated);
  if (!result.success) {
    const issues = result.issues.map((issue) => {
      const path =
        issue.path && issue.path.length > 0
          ? issue.path.map((p) => String(p.key)).join('.')
          : '(root)';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, issues };
  }

  return { ok: true, patch: result.output as VisualPatch };
}

export function serializePatch(patch: VisualPatch): string {
  return JSON.stringify(sortKeysDeep(patch));
}
