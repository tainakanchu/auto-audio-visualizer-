import { describe, expect, it } from 'vitest';
import { parseRecipe, parseSetlist } from './vj-recipe-schema.mjs';

describe('parseRecipe', () => {
  it('parses a valid recipe', () => {
    const result = parseRecipe({
      name: 'humid-qilou-night',
      mood: ['台湾', '夜', '湿った'],
      seed: 'humid-qilou-night-v1',
      tweaks: ['src0:=qilouShutter', 'src0.density=28'],
      notes: '夜市の手前の騎楼。',
    });
    expect(result.ok).toBe(true);
    expect(result.recipe.name).toBe('humid-qilou-night');
    expect(result.recipe.tweaks).toHaveLength(2);
  });

  it('parses a valid recipe with no notes and empty tweaks', () => {
    const result = parseRecipe({
      name: 'bare-recipe',
      mood: ['夜'],
      seed: 'bare-recipe-v1',
      tweaks: [],
    });
    expect(result.ok).toBe(true);
    expect(result.recipe.notes).toBeUndefined();
    expect(result.recipe.tweaks).toEqual([]);
  });

  it('fails with a useful issue when name is missing', () => {
    const result = parseRecipe({
      mood: ['夜'],
      seed: 's1',
      tweaks: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('name'))).toBe(true);
  });

  it('fails with a useful issue when mood is missing', () => {
    const result = parseRecipe({
      name: 'r1',
      seed: 's1',
      tweaks: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('mood'))).toBe(true);
  });

  it('fails with a useful issue when seed is missing', () => {
    const result = parseRecipe({
      name: 'r1',
      mood: ['夜'],
      tweaks: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('seed'))).toBe(true);
  });

  it('fails when mood is an empty array', () => {
    const result = parseRecipe({
      name: 'r1',
      mood: [],
      seed: 's1',
      tweaks: [],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('mood'))).toBe(true);
  });
});

describe('parseSetlist', () => {
  const validSetlist = {
    id: 'set-buffet-ocha',
    title: 'BUFFFFFFFET お茶会 30min',
    context: '渋谷OTO規模・オールジャンル',
    energyArc: [0.15, 0.3, 0.45, 0.55, 0.4, 0.25],
    durationMin: 30,
    ground: {
      role: '地',
      cycleMin: 6,
      sequence: [{ tMin: 0, recipe: 'doors-pre-silence', transition: 'slow' }],
    },
    figure: {
      role: '図',
      cycleMin: 2,
      sequence: [{ tMin: 6, recipe: 'minidv-faded-memory' }],
    },
    notes: '地は生活・花布・格子。',
  };

  it('parses a valid setlist', () => {
    const result = parseSetlist(validSetlist);
    expect(result.ok).toBe(true);
    expect(result.setlist.id).toBe('set-buffet-ocha');
  });

  it('fails when ground is missing', () => {
    const { ground: _ground, ...rest } = validSetlist;
    const result = parseSetlist(rest);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('ground'))).toBe(true);
  });

  it('fails when figure is missing', () => {
    const { figure: _figure, ...rest } = validSetlist;
    const result = parseSetlist(rest);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('figure'))).toBe(true);
  });
});
