import type { GeneratorCatalog } from './catalog';
import type { GeneratorCategory, ParameterDefinition, VisualOperator, VisualPatch } from './types';

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export const CATEGORY_RANK: Record<GeneratorCategory, number> = {
  source: 0,
  field: 1,
  modifier: 2,
  material: 3,
};

export const COUNT_LIMITS: Record<GeneratorCategory, { min: number; max: number }> = {
  source: { min: 1, max: 2 },
  field: { min: 0, max: 2 },
  modifier: { min: 1, max: 3 },
  material: { min: 1, max: 1 },
};

/**
 * Route の source に書ける audio:* の一覧。
 *
 * **modulation.ts の `resolveSourceValue` が解決できる集合と一致させること。**
 * ここだけ広いと「検証は通るのにデッキ生成で UnknownModulationSourceError で
 * 落ちる Patch」が作れてしまうし、ここだけ狭いと拍に同期した変調（音に反応
 * している感の主役）を Patch に書けない。
 */
export const AUDIO_SOURCES = new Set([
  'audio:bass',
  'audio:mid',
  'audio:treble',
  'audio:level',
  'audio:beat',
  'audio:beatIntensity',
  'audio:gridPulse',
  'audio:barPulse',
  'audio:barPhase',
  'audio:beatPhase',
]);

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

function validateParameterValue(
  paramDef: ParameterDefinition,
  value: number | string | boolean,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  switch (paramDef.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(
          issue(
            'param_type',
            `parameter "${paramDef.id}" expects finite number, got ${typeof value}`,
            path,
          ),
        );
        break;
      }
      if (paramDef.min !== undefined && value < paramDef.min) {
        issues.push(
          issue(
            'param_range',
            `parameter "${paramDef.id}" value ${value} is below min ${paramDef.min}`,
            path,
          ),
        );
      }
      if (paramDef.max !== undefined && value > paramDef.max) {
        issues.push(
          issue(
            'param_range',
            `parameter "${paramDef.id}" value ${value} is above max ${paramDef.max}`,
            path,
          ),
        );
      }
      break;
    }
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        issues.push(
          issue(
            'param_type',
            `parameter "${paramDef.id}" expects integer, got ${String(value)}`,
            path,
          ),
        );
        break;
      }
      if (paramDef.min !== undefined && value < paramDef.min) {
        issues.push(
          issue(
            'param_range',
            `parameter "${paramDef.id}" value ${value} is below min ${paramDef.min}`,
            path,
          ),
        );
      }
      if (paramDef.max !== undefined && value > paramDef.max) {
        issues.push(
          issue(
            'param_range',
            `parameter "${paramDef.id}" value ${value} is above max ${paramDef.max}`,
            path,
          ),
        );
      }
      break;
    }
    case 'bool': {
      if (typeof value !== 'boolean') {
        issues.push(
          issue(
            'param_type',
            `parameter "${paramDef.id}" expects boolean, got ${typeof value}`,
            path,
          ),
        );
      }
      break;
    }
    case 'enum': {
      if (typeof value !== 'string') {
        issues.push(
          issue(
            'param_type',
            `parameter "${paramDef.id}" expects string enum, got ${typeof value}`,
            path,
          ),
        );
        break;
      }
      const options = paramDef.options ?? [];
      if (!options.includes(value)) {
        issues.push(
          issue(
            'param_range',
            `parameter "${paramDef.id}" value "${value}" is not in options [${options.join(', ')}]`,
            path,
          ),
        );
      }
      break;
    }
  }
  return issues;
}

function parseTarget(target: string): { opId: string; paramId: string } | null {
  const dot = target.indexOf('.');
  if (dot <= 0 || dot === target.length - 1) return null;
  // only one segment: opId.paramId
  if (target.indexOf('.', dot + 1) !== -1) return null;
  return {
    opId: target.slice(0, dot),
    paramId: target.slice(dot + 1),
  };
}

/**
 * images のキーは `<opId>.<slot>` で、実在する Operator の実在するテクスチャ
 * スロットを指していなければならない。
 *
 * 参照が指す画像が手元に無いこと自体は issue にしない（そのときは v=0 で描く、
 * というのが Semantic Replay の契約）。ここで弾くのは「どのスロットにも
 * 結び付かない参照」＝ 明確な構成ミスだけ。
 */
function validateImages(patch: VisualPatch, catalog: GeneratorCatalog): ValidationIssue[] {
  const images = patch.images;
  if (!images) return [];

  const issues: ValidationIssue[] = [];
  const opById = new Map(patch.operators.map((op) => [op.id, op]));

  for (const key of Object.keys(images)) {
    const path = `images.${key}`;
    const parsed = parseTarget(key);
    if (!parsed) {
      issues.push(issue('invalid_image_key', `image key "${key}" must be "<opId>.<slot>"`, path));
      continue;
    }
    const op = opById.get(parsed.opId);
    if (!op) {
      issues.push(
        issue('invalid_image_key', `image operator "${parsed.opId}" does not exist`, path),
      );
      continue;
    }
    const def = catalog.get(op.generatorId);
    if (!def) continue; // unknown_generator は上流で報告済み
    // parseTarget の第2セグメント = ここではスロット名。
    const slot = parsed.paramId;
    const slots = def.textures ?? [];
    if (!slots.includes(slot)) {
      issues.push(
        issue(
          'unknown_texture_slot',
          `generator "${op.generatorId}" has no texture slot "${slot}"` +
            (slots.length > 0 ? ` (declared: ${slots.join(', ')})` : ' (declares none)'),
          path,
        ),
      );
    }
  }

  return issues;
}

export function validatePatch(patch: VisualPatch, catalog: GeneratorCatalog): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const operators = patch.operators;
  const opById = new Map<string, VisualOperator>();
  const seenIds = new Set<string>();

  // 1. unique operator ids
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i]!;
    const path = `operators[${i}]`;
    if (seenIds.has(op.id)) {
      issues.push(issue('duplicate_operator_id', `duplicate operator id "${op.id}"`, path));
    } else {
      seenIds.add(op.id);
      opById.set(op.id, op);
    }
  }

  // 2–3. generator existence + version; collect categories for stage/count
  const categories: (GeneratorCategory | undefined)[] = [];
  for (let i = 0; i < operators.length; i++) {
    const op = operators[i]!;
    const path = `operators[${i}]`;
    const latest = catalog.get(op.generatorId);
    if (!latest) {
      issues.push(
        issue(
          'unknown_generator',
          `generator "${op.generatorId}" not found in catalog`,
          `${path}.generatorId`,
        ),
      );
      categories.push(undefined);
      continue;
    }
    if (latest.version !== op.generatorVersion) {
      issues.push(
        issue(
          'version_mismatch',
          `generator "${op.generatorId}" version ${op.generatorVersion} does not match catalog version ${latest.version}`,
          `${path}.generatorVersion`,
        ),
      );
    }
    categories.push(latest.category);

    // 6. parameters
    const paramDefs = new Map(latest.parameters.map((p) => [p.id, p]));
    for (const [paramId, value] of Object.entries(op.parameters)) {
      const paramPath = `${path}.parameters.${paramId}`;
      const def = paramDefs.get(paramId);
      if (!def) {
        issues.push(
          issue(
            'unknown_parameter',
            `parameter "${paramId}" is not defined on generator "${op.generatorId}"`,
            paramPath,
          ),
        );
        continue;
      }
      issues.push(...validateParameterValue(def, value, paramPath));
    }
  }

  // 4. stage order: non-decreasing category rank
  let lastRank = -1;
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (cat === undefined) continue;
    const rank = CATEGORY_RANK[cat];
    if (rank < lastRank) {
      issues.push(
        issue(
          'stage_order',
          `operators must be ordered Source → Field → Modifier → Material; found "${cat}" after higher stage`,
          `operators[${i}]`,
        ),
      );
    }
    lastRank = Math.max(lastRank, rank);
  }

  // 5. count limits
  const counts: Record<GeneratorCategory, number> = {
    source: 0,
    field: 0,
    modifier: 0,
    material: 0,
  };
  for (const cat of categories) {
    if (cat !== undefined) counts[cat] += 1;
  }
  for (const cat of Object.keys(COUNT_LIMITS) as GeneratorCategory[]) {
    const { min, max } = COUNT_LIMITS[cat];
    const n = counts[cat];
    if (n < min || n > max) {
      issues.push(
        issue('count_limit', `${cat} count must be ${min}–${max}, got ${n}`, 'operators'),
      );
    }
  }

  // 7–10. routes
  for (let i = 0; i < patch.routes.length; i++) {
    const route = patch.routes[i]!;
    const basePath = `routes[${i}]`;

    // amount / smoothing
    if (typeof route.amount !== 'number' || !Number.isFinite(route.amount)) {
      issues.push(
        issue('invalid_amount', 'route amount must be a finite number', `${basePath}.amount`),
      );
    }
    if (typeof route.smoothing !== 'number' || !Number.isFinite(route.smoothing)) {
      issues.push(
        issue(
          'invalid_smoothing',
          'route smoothing must be a finite number',
          `${basePath}.smoothing`,
        ),
      );
    } else if (route.smoothing < 0) {
      issues.push(
        issue('invalid_smoothing', 'route smoothing must be >= 0', `${basePath}.smoothing`),
      );
    }

    // target
    const parsedTarget = parseTarget(route.target);
    if (!parsedTarget) {
      issues.push(
        issue(
          'invalid_target',
          `route target "${route.target}" must be "<opId>.<paramId>"`,
          `${basePath}.target`,
        ),
      );
    } else {
      const targetOp = opById.get(parsedTarget.opId);
      if (!targetOp) {
        issues.push(
          issue(
            'invalid_target',
            `route target operator "${parsedTarget.opId}" does not exist`,
            `${basePath}.target`,
          ),
        );
      } else {
        const gen = catalog.get(targetOp.generatorId);
        const paramDef = gen?.parameters.find((p) => p.id === parsedTarget.paramId);
        if (!gen || !paramDef) {
          issues.push(
            issue(
              'invalid_target',
              `route target parameter "${parsedTarget.paramId}" not found on operator "${parsedTarget.opId}"`,
              `${basePath}.target`,
            ),
          );
        } else if (!paramDef.modulatable) {
          issues.push(
            issue(
              'target_not_modulatable',
              `parameter "${parsedTarget.paramId}" on operator "${parsedTarget.opId}" is not modulatable`,
              `${basePath}.target`,
            ),
          );
        }
      }

      // 9. self-modulation: source operator:X targeting X.*
      if (route.source.startsWith('operator:')) {
        const sourceOpId = route.source.slice('operator:'.length);
        if (sourceOpId === parsedTarget.opId) {
          issues.push(
            issue(
              'self_modulation',
              `operator "${sourceOpId}" cannot modulate itself in the same frame`,
              basePath,
            ),
          );
        }
      }
    }

    // source
    const source = route.source;
    if (source === 'time' || AUDIO_SOURCES.has(source)) {
      // ok
    } else if (source.startsWith('operator:')) {
      const sourceOpId = source.slice('operator:'.length);
      if (!sourceOpId || !opById.has(sourceOpId)) {
        issues.push(
          issue(
            'invalid_source',
            `route source operator "${sourceOpId}" does not exist`,
            `${basePath}.source`,
          ),
        );
      }
    } else {
      issues.push(
        issue(
          'invalid_source',
          `route source "${source}" is not a known form (audio:*, time, operator:<opId>)`,
          `${basePath}.source`,
        ),
      );
    }
  }

  // 11. images: every reference must land on a declared texture slot
  issues.push(...validateImages(patch, catalog));

  return issues;
}
