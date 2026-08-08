import { describe, expect, it } from 'vitest';
import type { AudioFrame } from '../audio/types';
import type { InlineGenerator, InlineGeneratorCatalog } from './generators/types';
import {
  applyModulation,
  createModulationEngine,
  DEFAULT_SMOOTHING,
  UnknownModulationSourceError,
} from './modulation';
import type { SwellState } from './swell';
import type { GeneratorDefinition, ModulationRoute, VisualPatch } from './types';

/** テスト用 AudioFrame ダミー。指定フィールドだけ上書きする。 */
function makeAudio(partial: Partial<AudioFrame> = {}): AudioFrame {
  return {
    freq: new Uint8Array(0),
    wave: new Uint8Array(0),
    level: 0,
    levelRaw: 0,
    peak: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    beat: false,
    beatIntensity: 0,
    running: true,
    bpm: 120,
    beatPhase: 0,
    barPhase: 0,
    beatInBar: 0,
    barCount: 0,
    gridBeat: false,
    gridBar: false,
    gridPulse: 0,
    barPulse: 0,
    tempoConfidence: 1,
    tempoLocked: true,
    tempoMode: 'auto',
    ...partial,
  };
}

function route(
  partial: Partial<ModulationRoute> & Pick<ModulationRoute, 'source' | 'target'>,
): ModulationRoute {
  return {
    amount: 1,
    polarity: 'unipolar',
    smoothing: 0,
    ...partial,
  };
}

function makeDef(id: string, parameters: GeneratorDefinition['parameters']): GeneratorDefinition {
  return {
    id,
    version: 1,
    category: 'source',
    costClass: 'light',
    impl: 'inline',
    output: 'field',
    tags: {},
    parameters,
    cost: { passes: 0, relativeFill: 1, stateful: false },
  };
}

function makeCatalog(defs: GeneratorDefinition[]): InlineGeneratorCatalog {
  const gens: InlineGenerator[] = defs.map((def) => ({
    def,
    emit: () => '',
  }));
  const byId = new Map(gens.map((g) => [g.def.id, g]));
  return {
    get: (id) => byId.get(id),
    all: () => gens,
  };
}

const genDef = makeDef('gen-a', [
  {
    id: 'amount',
    label: 'Amount',
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.5,
    modulatable: true,
  },
  {
    id: 'scale',
    label: 'Scale',
    kind: 'number',
    min: 0,
    max: 10,
    default: 1,
    modulatable: true,
  },
  {
    id: 'locked',
    label: 'Locked',
    kind: 'number',
    min: 0,
    max: 1,
    default: 0.2,
    modulatable: false,
  },
  {
    id: 'mode',
    label: 'Mode',
    kind: 'enum',
    options: ['a', 'b'],
    default: 'a',
    modulatable: false,
  },
  {
    id: 'enabled',
    label: 'Enabled',
    kind: 'bool',
    default: true,
    modulatable: false,
  },
]);

const catalog = makeCatalog([genDef]);

function patch(params: Record<string, number | string | boolean> = {}): VisualPatch {
  return {
    schemaVersion: 1,
    seed: 'mod-test',
    operators: [
      {
        id: 'op0',
        generatorId: 'gen-a',
        generatorVersion: 1,
        parameters: {
          amount: 0.5,
          scale: 1,
          locked: 0.2,
          mode: 'a',
          enabled: true,
          ...params,
        },
      },
    ],
    routes: [],
    palette: { mode: 'mono', hueOffset: 0, saturation: 50, lightness: 50 },
    composition: { symmetry: 1, scale: 1, speed: 1 },
    qualityTier: 'medium',
  };
}

describe('createModulationEngine', () => {
  it('is deterministic for the same (routes, audio series, dt series)', () => {
    const routes = [
      route({
        source: 'audio:bass',
        target: 'op0.amount',
        amount: 0.4,
        polarity: 'unipolar',
        smoothing: 0.5,
      }),
    ];
    const frames = [
      makeAudio({ bass: 0.1 }),
      makeAudio({ bass: 0.8 }),
      makeAudio({ bass: 0.3 }),
      makeAudio({ bass: 0.9 }),
    ];
    const dts = [1 / 60, 1 / 60, 1 / 30, 1 / 60];

    const run = () => {
      const engine = createModulationEngine(routes);
      const out: number[] = [];
      let t = 0;
      for (let i = 0; i < frames.length; i++) {
        const dt = dts[i]!;
        t += dt;
        const { offsets } = engine.update(frames[i]!, t, dt);
        out.push(offsets.get('op0.amount') ?? NaN);
      }
      return out;
    };

    expect(run()).toEqual(run());
  });

  it('tracks slower when smoothing tau is larger; ~63% at t = tau (step response)', () => {
    const tau = 1.0;
    const dt = 1 / 120;
    const steps = Math.round(tau / dt); // exactly tau seconds of integration

    const makeSeries = (smoothing: number) => {
      const engine = createModulationEngine([
        route({
          source: 'audio:level',
          target: 'op0.amount',
          amount: 1,
          polarity: 'unipolar',
          smoothing,
        }),
      ]);
      let last = 0;
      let t = 0;
      // step: level 0 → 1 from the first frame; internal state starts at 0
      for (let i = 0; i < steps; i++) {
        t += dt;
        const { offsets } = engine.update(makeAudio({ level: 1 }), t, dt);
        last = offsets.get('op0.amount') ?? 0;
      }
      return last;
    };

    const atTau = makeSeries(tau);
    const faster = makeSeries(0.3);
    const slower = makeSeries(2.0);

    // 1 - e^{-1} ≈ 0.6321205588; discrete steps converge to that from below/near
    expect(atTau).toBeGreaterThan(0.62);
    expect(atTau).toBeLessThan(0.65);
    expect(Math.abs(atTau - (1 - Math.exp(-1)))).toBeLessThan(0.01);

    // larger smoothing → slower tracking toward the step
    expect(faster).toBeGreaterThan(atTau);
    expect(slower).toBeLessThan(atTau);
  });

  it('applies raw source immediately when smoothing = 0', () => {
    const engine = createModulationEngine([
      route({
        source: 'audio:mid',
        target: 'op0.amount',
        amount: 0.5,
        polarity: 'unipolar',
        smoothing: 0,
      }),
    ]);

    const r1 = engine.update(makeAudio({ mid: 0.8 }), 0, 1 / 60);
    expect(r1.offsets.get('op0.amount')).toBeCloseTo(0.4, 10);

    const r2 = engine.update(makeAudio({ mid: 0.2 }), 1 / 60, 1 / 60);
    expect(r2.offsets.get('op0.amount')).toBeCloseTo(0.1, 10);
  });

  it('differs in sign behavior between unipolar and bipolar', () => {
    const uni = createModulationEngine([
      route({
        source: 'audio:bass',
        target: 'op0.amount',
        amount: 1,
        polarity: 'unipolar',
        smoothing: 0,
      }),
    ]);
    const bi = createModulationEngine([
      route({
        source: 'audio:bass',
        target: 'op0.amount',
        amount: 1,
        polarity: 'bipolar',
        smoothing: 0,
      }),
    ]);

    // source 0 → unipolar 0, bipolar -1
    const low = makeAudio({ bass: 0 });
    expect(uni.update(low, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(0, 10);
    expect(bi.update(low, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(-1, 10);

    // source 1 → both +1
    const high = makeAudio({ bass: 1 });
    expect(uni.update(high, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(1, 10);
    expect(bi.update(high, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(1, 10);

    // source 0.25 → uni +0.25, bi -0.5
    const mid = makeAudio({ bass: 0.25 });
    expect(uni.update(mid, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(0.25, 10);
    expect(bi.update(mid, 0, 0.016).offsets.get('op0.amount')).toBeCloseTo(-0.5, 10);
  });

  it('sums multiple routes targeting the same parameter', () => {
    const engine = createModulationEngine([
      route({
        source: 'audio:bass',
        target: 'op0.amount',
        amount: 0.3,
        polarity: 'unipolar',
        smoothing: 0,
      }),
      route({
        source: 'audio:treble',
        target: 'op0.amount',
        amount: 0.5,
        polarity: 'unipolar',
        smoothing: 0,
      }),
    ]);

    const { offsets } = engine.update(makeAudio({ bass: 1, treble: 0.4 }), 0, 0.016);
    // 1*0.3 + 0.4*0.5 = 0.5
    expect(offsets.get('op0.amount')).toBeCloseTo(0.5, 10);
  });

  it('reads time as raw elapsed seconds (not normalized)', () => {
    const engine = createModulationEngine([
      route({
        source: 'time',
        target: 'op0.scale',
        amount: 0.1,
        polarity: 'unipolar',
        smoothing: 0,
      }),
    ]);
    const { offsets } = engine.update(makeAudio(), 12.5, 0.016);
    expect(offsets.get('op0.scale')).toBeCloseTo(1.25, 10);
  });

  it('throws on operator: sources (not silent zero)', () => {
    expect(() =>
      createModulationEngine([
        route({ source: 'operator:op0', target: 'op0.amount', smoothing: 0 }),
      ]),
    ).toThrow(UnknownModulationSourceError);

    expect(() =>
      createModulationEngine([
        route({ source: 'operator:op0', target: 'op0.amount', smoothing: 0 }),
      ]),
    ).toThrow(/not supported yet|operator/);
  });

  it('throws on unknown source strings (not silent zero)', () => {
    expect(() =>
      createModulationEngine([
        route({ source: 'audio:mystery', target: 'op0.amount', smoothing: 0 }),
      ]),
    ).toThrow(UnknownModulationSourceError);

    expect(() =>
      createModulationEngine([route({ source: 'lfo', target: 'op0.amount', smoothing: 0 })]),
    ).toThrow(UnknownModulationSourceError);
  });

  describe('swell:* sources', () => {
    const SWELL: SwellState = { wave: 0.2, group: 0.6, set: 0.4, surge: 0.8 };

    it('resolves each layer from the SwellState it is handed', () => {
      for (const [source, expected] of [
        ['swell:wave', SWELL.wave],
        ['swell:group', SWELL.group],
        ['swell:set', SWELL.set],
        ['swell:surge', SWELL.surge],
      ] as const) {
        const engine = createModulationEngine([
          route({ source, target: 'op0.amount', amount: 1, smoothing: 0 }),
        ]);
        const { offsets } = engine.update(makeAudio(), 0, 1 / 60, SWELL);
        expect(offsets.get('op0.amount'), source).toBeCloseTo(expected, 10);
      }
    });

    it('still rejects an unknown swell layer at construction time', () => {
      // 網が swell:* をまとめて通す作りになっていないことの確認。
      expect(() =>
        createModulationEngine([route({ source: 'swell:tide', target: 'op0.amount' })]),
      ).toThrow(UnknownModulationSourceError);
    });

    it('reads 0 when no SwellState is passed (engine owns no clock of its own)', () => {
      const engine = createModulationEngine([
        route({ source: 'swell:group', target: 'op0.amount', amount: 1, smoothing: 0 }),
      ]);
      expect(engine.update(makeAudio(), 0, 1 / 60).offsets.get('op0.amount')).toBe(0);
    });

    it('contributes nothing while the sea is calm — silence cannot dim the picture', () => {
      const engine = createModulationEngine([
        route({ source: 'swell:group', target: 'op0.amount', amount: 0.5, smoothing: 0.8 }),
        route({ source: 'swell:set', target: 'op0.scale', amount: 0.5, smoothing: 0.8 }),
      ]);
      const calm: SwellState = { wave: 0, group: 0, set: 0, surge: 0 };
      for (let i = 0; i < 600; i++) {
        const { offsets } = engine.update(makeAudio(), i / 60, 1 / 60, calm);
        expect(offsets.get('op0.amount')).toBe(0);
        expect(offsets.get('op0.scale')).toBe(0);
      }
    });
  });

  it('reset() clears smoothing state', () => {
    const engine = createModulationEngine([
      route({
        source: 'audio:level',
        target: 'op0.amount',
        amount: 1,
        polarity: 'unipolar',
        smoothing: 1.0,
      }),
    ]);

    // warm up toward 1
    for (let i = 0; i < 30; i++) {
      engine.update(makeAudio({ level: 1 }), i / 60, 1 / 60);
    }
    const warm = engine.update(makeAudio({ level: 1 }), 0.5, 1 / 60).offsets.get('op0.amount')!;
    expect(warm).toBeGreaterThan(0.3);

    engine.reset();

    // after reset, first step from 0 with same input is a small step again
    const after = engine.update(makeAudio({ level: 1 }), 0, 1 / 60).offsets.get('op0.amount')!;
    expect(after).toBeLessThan(0.05);
    expect(after).toBeLessThan(warm / 5);
  });

  it('exports ambient-scale DEFAULT_SMOOTHING', () => {
    expect(DEFAULT_SMOOTHING).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_SMOOTHING).toBeLessThanOrEqual(2);
  });
});

describe('applyModulation', () => {
  it('clamps final values to parameter min/max', () => {
    const mod = {
      offsets: new Map<string, number>([['op0.amount', 10]]),
    };
    const values = applyModulation(patch({ amount: 0.5 }), catalog, mod);
    expect(values.get('op0.amount')).toBe(1); // max

    const modLow = {
      offsets: new Map<string, number>([['op0.amount', -10]]),
    };
    const valuesLow = applyModulation(patch({ amount: 0.5 }), catalog, modLow);
    expect(valuesLow.get('op0.amount')).toBe(0); // min
  });

  it('ignores modulation on modulatable: false parameters', () => {
    const mod = {
      offsets: new Map<string, number>([
        ['op0.locked', 0.9],
        ['op0.amount', 0.1],
      ]),
    };
    const values = applyModulation(patch({ locked: 0.2, amount: 0.5 }), catalog, mod);
    expect(values.get('op0.locked')).toBe(0.2);
    expect(values.get('op0.amount')).toBeCloseTo(0.6, 10);
  });

  it('does not modulate enum / bool parameters', () => {
    const mod = {
      offsets: new Map<string, number>([
        ['op0.mode', 1],
        ['op0.enabled', 1],
      ]),
    };
    const values = applyModulation(patch(), catalog, mod);
    expect(values.get('op0.mode')).toBe('a');
    expect(values.get('op0.enabled')).toBe(true);
  });

  it('returns all base parameters with offsets applied where valid', () => {
    const mod = {
      offsets: new Map<string, number>([['op0.scale', 2]]),
    };
    const values = applyModulation(patch({ scale: 3 }), catalog, mod);
    expect(values.get('op0.scale')).toBe(5);
    expect(values.get('op0.amount')).toBe(0.5);
    expect(values.get('op0.mode')).toBe('a');
  });
});
