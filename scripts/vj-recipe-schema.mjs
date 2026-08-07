/**
 * recipes/*.json / recipes/setlists/*.json のスキーマ（valibot）。
 *
 * src/synth/schema.ts の parsePatch と同じパターン（v.safeParse → issue を
 * "path: message" 文字列へマップ → {ok:true,value} / {ok:false,issues} を返す）に
 * 倣っている。`scripts/*.mjs` は素の ESM として node が直接実行するので `.ts` は
 * import できないが、valibot は package.json の実 dependency なので直接 import できる
 * （vj-gen.mjs / vj-tweak.mjs が validate.ts のルールを複製しているのとは事情が違う）。
 *
 * recipe.tweaks の中身（各トークンの構文）はここでは検証しない —
 * `<opId>.<paramId>=<value>` のようなトークン構文の妥当性は vj-tweak.mjs（を
 * 経由する vj-recipe.mjs apply）が適用時に見る仕事であり、ここで重複させると
 * 二重管理になる。ここが見るのは recipe/setlist という入れ物の形（型・必須項目）だけ。
 */
import * as v from 'valibot';

// ---------------------------------------------------------------------------
// recipe
// ---------------------------------------------------------------------------

export const recipeSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  mood: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  seed: v.pipe(v.string(), v.minLength(1)),
  tweaks: v.array(v.string()),
  notes: v.optional(v.string()),
});

/** valibot の issues 配列を "path: message" 文字列の配列へ変換する（schema.ts と同じ整形）。 */
function issuesToStrings(issues) {
  return issues.map((issue) => {
    const path =
      issue.path && issue.path.length > 0
        ? issue.path.map((p) => String(p.key)).join('.')
        : '(root)';
    return `${path}: ${issue.message}`;
  });
}

export function parseRecipe(input) {
  const result = v.safeParse(recipeSchema, input);
  if (!result.success) return { ok: false, issues: issuesToStrings(result.issues) };
  return { ok: true, recipe: result.output };
}

// ---------------------------------------------------------------------------
// setlist（sets-6.json 相当。データ専用 — CLI/実行はここでは持たない）
// ---------------------------------------------------------------------------

const setlistCueSchema = v.object({
  tMin: v.pipe(v.number(), v.finite(), v.minValue(0)),
  recipe: v.pipe(v.string(), v.minLength(1)),
  transition: v.optional(v.string()),
});

const setlistLayerSchema = v.object({
  role: v.pipe(v.string(), v.minLength(1)),
  cycleMin: v.pipe(v.number(), v.finite()),
  sequence: v.array(setlistCueSchema),
});

export const setlistSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  context: v.pipe(v.string(), v.minLength(1)),
  energyArc: v.array(v.pipe(v.number(), v.finite())),
  durationMin: v.pipe(v.number(), v.finite()),
  ground: setlistLayerSchema,
  figure: setlistLayerSchema,
  notes: v.optional(v.string()),
});

export function parseSetlist(input) {
  const result = v.safeParse(setlistSchema, input);
  if (!result.success) return { ok: false, issues: issuesToStrings(result.issues) };
  return { ok: true, setlist: result.output };
}
