#!/usr/bin/env node
/**
 * OKF v0.2 conformance validator.
 *
 * 仕様 §11 の 3 条件のみをエラーとして扱う:
 *   1. 予約名以外のすべての .md がパース可能な YAML frontmatter を持つ
 *   2. すべての frontmatter が非空の `type` を持つ
 *   3. 予約名 index.md / log.md が §8 / §9 の構造に従う
 *
 * 仕様は consumer に対し、以下を理由とする拒否を明示的に禁じている (§11 MUST NOT):
 * 任意フィールドの欠落 / 未知の type / 未知の追加キー / リンク切れ / index.md の欠如。
 * これらは警告としてのみ報告し、終了コードに影響させない。
 *
 * --tag-registry を指定した場合は、OKF conformance とは別にリポジトリの
 * タグ語彙も検査する。未登録タグはリポジトリ運用エラーとして終了コード 1 にする。
 *
 * 使い方: node validate.mjs <bundle-dir> [--strict] [--tag-registry <tags.yml>]
 *   --strict: 警告も終了コード 1 にする (CI 用)
 *
 * YAML パーサは実行時に解決する (`yaml` を優先し、なければ `js-yaml`)。
 * bun でもそのまま実行できる。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);
const STATUS_VALUES = new Set(["draft", "stable", "deprecated"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * YAML パーサを実行時に解決する。
 *
 * `yaml` / `js-yaml` のどちらが入っていても動くようにし、リポジトリ側に
 * 余計な依存を強制しない。探索は実行時 cwd の node_modules → このスクリプトの
 * 隣の node_modules の順。
 */
function resolveYamlParser() {
  const requires = [createRequire(join(process.cwd(), "__okf__.js")), createRequire(import.meta.url)];
  for (const req of requires) {
    try {
      const mod = req("yaml");
      const parse = mod.parse ?? mod.default?.parse;
      if (typeof parse === "function") return (text) => parse(text);
    } catch {
      // 次の候補へ
    }
    try {
      const mod = req("js-yaml");
      const load = mod.load ?? mod.default?.load;
      if (typeof load === "function") return (text) => load(text);
    } catch {
      // 次の候補へ
    }
  }
  console.error(
    "エラー: YAML パーサが見つかりません。`yaml` か `js-yaml` を devDependency に追加してください。",
  );
  console.error("  npm i -D yaml   /   pnpm add -D yaml   /   yarn add -D yaml   /   bun add -d yaml");
  process.exit(1);
}

const parseYaml = resolveYamlParser();

/**
 * @typedef {object} Issue
 * @property {string} file
 * @property {string} message
 */

/** @type {Issue[]} */
const errors = [];
/** @type {Issue[]} */
const repositoryErrors = [];
/** @type {Issue[]} */
const warnings = [];
/** @type {Set<string> | null} */
let approvedTags = null;

/**
 * frontmatter ブロックを切り出す。
 *
 * 中身の解釈には本物の YAML パーサを使う。自前の行単位パーサでは、
 * 値に改行が混入した壊れた YAML を「読めている」と誤判定するため。
 */
function extractFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const rest = text.slice(3);
  if (!/^\r?\n/.test(rest)) return null;
  const end = rest.search(/\r?\n---(\r?\n|$)/);
  if (end === -1) return null;
  const raw = rest.slice(0, end);
  const after = rest.slice(end).replace(/^\r?\n---/, "");
  return { raw, body: after };
}

/** frontmatter を YAML として解析する。壊れていれば null。 */
function parseFrontmatter(raw) {
  try {
    const value = parseYaml(raw);
    // スカラーや配列は frontmatter として不正
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/** マッピングから文字列フィールドを読む。 */
function strField(value, key) {
  if (value === null || typeof value !== "object") return null;
  const v = value[key];
  return typeof v === "string" ? v : null;
}

function loadTagRegistry(path) {
  let value;
  try {
    value = parseYaml(readFileSync(path, "utf8"));
  } catch {
    repositoryErrors.push({ file: path, message: "タグ一覧をYAMLとして解析できない" });
    return null;
  }

  const isMapping = value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
  if (!isMapping) {
    repositoryErrors.push({ file: path, message: "タグ一覧のルートがマッピングではない" });
    return null;
  }

  const entries = value.tags;
  if (!Array.isArray(entries)) {
    repositoryErrors.push({ file: path, message: "`tags` がリスト形式ではない" });
    return null;
  }

  const names = new Set();
  entries.forEach((entry, index) => {
    const name = strField(entry, "name")?.trim();
    const category = strField(entry, "category")?.trim();
    const description = strField(entry, "description")?.trim();
    if (!name || !category || !description) {
      repositoryErrors.push({
        file: path,
        message: `\`tags[${index}]\` は name・category・description が必須`,
      });
      return;
    }
    if (names.has(name)) {
      repositoryErrors.push({ file: path, message: `タグ \`${name}\` が重複している` });
      return;
    }
    names.add(name);
  });
  return names;
}

function checkRegisteredTags(rel, value) {
  const registry = approvedTags;
  if (registry === null || value === undefined) return;
  if (!Array.isArray(value)) {
    repositoryErrors.push({ file: rel, message: "`tags` がリスト形式ではない" });
    return;
  }

  const seen = new Set();
  value.forEach((entry, index) => {
    const tag = typeof entry === "string" ? entry.trim() : "";
    if (!tag) {
      repositoryErrors.push({ file: rel, message: `\`tags[${index}]\` が空、または文字列でない` });
      return;
    }
    if (seen.has(tag)) {
      repositoryErrors.push({ file: rel, message: `タグ \`${tag}\` が重複している` });
      return;
    }
    seen.add(tag);
    if (!registry.has(tag)) {
      repositoryErrors.push({
        file: rel,
        message: `未登録タグ \`${tag}\` — タグ一覧へ追加するか既存タグへ統合する`,
      });
    }
  });
}

function checkConcept(rel, text) {
  const fm = extractFrontmatter(text);

  // §11-1: パース可能な frontmatter が必須
  if (!fm) {
    errors.push({ file: rel, message: "YAML frontmatter がない、または閉じられていない (§11-1)" });
    return;
  }

  const doc = parseFrontmatter(fm.raw);
  if (!doc) {
    errors.push({ file: rel, message: "frontmatter が YAML として解析できない (§11-1)" });
    return;
  }

  // §11-2: 非空の type が必須
  if (doc.type === undefined) {
    errors.push({ file: rel, message: "`type` フィールドがない (§11-2)" });
  } else if (typeof doc.type !== "string" || !doc.type.trim()) {
    errors.push({ file: rel, message: "`type` が空、または文字列でない (§11-2)" });
  }

  checkRegisteredTags(rel, doc.tags);

  // --- ここから下はすべて警告。仕様上、拒否理由にしてはならない ---

  if (typeof doc.status === "string" && !STATUS_VALUES.has(doc.status)) {
    warnings.push({
      file: rel,
      message: `\`status: ${doc.status}\` は規定値外 (draft / stable / deprecated)`,
    });
  }

  if (doc.stale_after !== undefined) {
    // YAML は日付を Date に変換しうるため文字列化して見る
    const value =
      doc.stale_after instanceof Date
        ? doc.stale_after.toISOString().slice(0, 10)
        : String(doc.stale_after);
    if (!DATE_RE.test(value)) {
      warnings.push({ file: rel, message: `\`stale_after: ${value}\` は YYYY-MM-DD 形式ではない` });
    } else if (value < new Date().toISOString().slice(0, 10)) {
      warnings.push({
        file: rel,
        message: `陳腐化している (stale_after: ${value}) — 内容を確認して更新を`,
      });
    }
  }

  if (doc.generated !== undefined) {
    if (!strField(doc.generated, "by")) {
      warnings.push({ file: rel, message: "`generated.by` がない (generated 内では必須)" });
    }
    const at = strField(doc.generated, "at");
    if (at && !DATETIME_RE.test(at)) {
      warnings.push({
        file: rel,
        message: `\`generated.at: ${at}\` は ISO 8601 datetime ではない`,
      });
    }
  }

  // 仕様上 verified は単一マッピングでもリストとして扱う (§5.2 consumer MUST)
  if (doc.verified !== undefined) {
    const entries = Array.isArray(doc.verified) ? doc.verified : [doc.verified];
    entries.forEach((entry, i) => {
      if (!strField(entry, "by")) {
        warnings.push({ file: rel, message: `\`verified[${i}].by\` がない` });
      }
    });
  }

  if (doc.sources !== undefined) {
    if (!Array.isArray(doc.sources)) {
      warnings.push({ file: rel, message: "`sources` がリスト形式ではない" });
    } else {
      doc.sources.forEach((entry, i) => {
        if (!strField(entry, "resource")) {
          warnings.push({
            file: rel,
            message: `\`sources[${i}].resource\` がない (要素内では必須)`,
          });
        }
      });
    }
  }
}

/** §9: log.md は日付見出しを持つ。 */
function checkLog(rel, text) {
  const fm = extractFrontmatter(text);
  const body = fm ? fm.body : text;
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  const dated = headings.filter((h) => DATE_RE.test(h));
  if (headings.length > 0 && dated.length === 0) {
    errors.push({ file: rel, message: "log.md に `## YYYY-MM-DD` 形式の日付見出しがない (§9)" });
  }
  // 降順(新しい順)であるべき
  for (let i = 1; i < dated.length; i++) {
    if (dated[i - 1] < dated[i]) {
      warnings.push({
        file: rel,
        message: `日付見出しが降順でない (${dated[i - 1]} の後に ${dated[i]})`,
      });
      break;
    }
  }
}

/** §8: index.md は frontmatter を持たない (ルートの okf_version のみ例外)。 */
function checkIndex(rel, text, isRoot) {
  const fm = extractFrontmatter(text);
  if (!fm) return;
  const doc = parseFrontmatter(fm.raw);
  if (!doc) {
    errors.push({ file: rel, message: "index.md の frontmatter が YAML として解析できない" });
    return;
  }
  const keys = Object.keys(doc);
  if (isRoot && keys.length === 1 && keys[0] === "okf_version") return;
  errors.push({
    file: rel,
    message: isRoot
      ? "ルート index.md の frontmatter は `okf_version` のみ許される (§8)"
      : "index.md に frontmatter は置けない (§8)",
  });
}

function walk(dir, root) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      count += walk(full, root);
      continue;
    }
    if (!entry.endsWith(".md")) continue;

    const rel = relative(root, full);
    const text = readFileSync(full, "utf8");
    count++;

    if (entry === "log.md") checkLog(rel, text);
    else if (entry === "index.md") checkIndex(rel, text, rel === "index.md");
    else if (!RESERVED.has(entry)) checkConcept(rel, text);
  }
  return count;
}

// --- entrypoint ---

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const tagRegistryIndex = args.indexOf("--tag-registry");
const tagRegistryPath = tagRegistryIndex === -1 ? null : args[tagRegistryIndex + 1];
// --tag-registry の値は対象ディレクトリの候補から除く。
// tagRegistryIndex が -1 のときに index 0 を除外しないよう、明示的に条件を分ける。
const target = args.find(
  (arg, index) => !arg.startsWith("--") && !(tagRegistryIndex !== -1 && index === tagRegistryIndex + 1),
);

if (!target) {
  console.error("使い方: node validate.mjs <bundle-dir> [--strict] [--tag-registry <tags.yml>]");
  process.exit(2);
}
if (tagRegistryIndex !== -1 && !tagRegistryPath) {
  console.error("エラー: --tag-registry にファイルを指定してください");
  process.exit(2);
}

let stat;
try {
  stat = statSync(target);
} catch {
  console.error(`エラー: ディレクトリが見つかりません: ${target}`);
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(`エラー: ディレクトリではありません: ${target}`);
  process.exit(2);
}

if (tagRegistryPath) approvedTags = loadTagRegistry(tagRegistryPath);

const total = walk(target, target);

for (const e of errors) console.error(`✗ ${e.file}: ${e.message}`);
for (const e of repositoryErrors) console.error(`✗ ${e.file}: ${e.message}`);
for (const w of warnings) console.warn(`⚠ ${w.file}: ${w.message}`);

const summary = `${total} ファイル検査 / OKFエラー ${errors.length} / タグ運用エラー ${repositoryErrors.length} / 警告 ${warnings.length}`;

if (errors.length > 0) {
  console.error(`\n✗ OKF v0.2 非準拠 — ${summary}`);
  process.exit(1);
}
if (repositoryErrors.length > 0) {
  console.error(`\n✗ OKF v0.2 準拠 / リポジトリ運用違反 — ${summary}`);
  process.exit(1);
}
if (strict && warnings.length > 0) {
  console.error(`\n✗ 警告あり (--strict) — ${summary}`);
  process.exit(1);
}
console.log(`\n✓ OKF v0.2 準拠 — ${summary}`);
