// recipes/*.json（36本）と recipes/setlists/*.json（6本）が実ファイルとして
// schema を満たしていること、そして各 setlist の sequence[].recipe が
// recipes/ 内の実在する recipe 名を指していることを確認する。
// vj-gen.mjs / vj-tweak.mjs / catalog には一切触れない、純粋なデータ整合性チェック。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRecipe, parseSetlist } from './vj-recipe-schema.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const RECIPES_DIR = join(SCRIPT_DIR, '..', 'recipes');
const SETLISTS_DIR = join(RECIPES_DIR, 'setlists');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const recipeFiles = readdirSync(RECIPES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const setlistFiles = readdirSync(SETLISTS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('recipes/*.json', () => {
  it('has 36 recipe files', () => {
    expect(recipeFiles).toHaveLength(36);
  });

  for (const file of recipeFiles) {
    it(`${file} parses as a valid recipe and name matches filename`, () => {
      const parsed = parseRecipe(readJson(join(RECIPES_DIR, file)));
      expect(parsed.ok, parsed.ok ? '' : parsed.issues.join('\n')).toBe(true);
      expect(`${parsed.recipe.name}.json`).toBe(file);
    });
  }
});

describe('recipes/setlists/*.json', () => {
  it('has 6 setlist files', () => {
    expect(setlistFiles).toHaveLength(6);
  });

  const recipeNames = new Set(recipeFiles.map((f) => f.slice(0, -'.json'.length)));

  for (const file of setlistFiles) {
    it(`${file} parses as a valid setlist and every sequence[].recipe resolves`, () => {
      const parsed = parseSetlist(readJson(join(SETLISTS_DIR, file)));
      expect(parsed.ok, parsed.ok ? '' : parsed.issues.join('\n')).toBe(true);

      const missing = [];
      for (const layer of [parsed.setlist.ground, parsed.setlist.figure]) {
        for (const cue of layer.sequence) {
          if (!recipeNames.has(cue.recipe)) missing.push(cue.recipe);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
