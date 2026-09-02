# OKF v0.2 仕様ダイジェスト

出典: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

SKILL.md に載せきらなかった詳細をまとめる。**迷ったら常に原典 SPEC.md を正とすること。**

## バージョニング (§12–13)

v0.2 は v0.1 のマイナー版だが、**「完全な後方互換」ではない**。
§13.1 に **2 つの意図的な破壊的変更**が明記されている。

| v0.1 | v0.2 | consumer の扱い |
| --- | --- | --- |
| `timestamp` | `generated.at` (§5.2) | `generated` がなければ legacy `timestamp` に fallback **MAY** |
| 本文の `# Citations` リスト | `sources` (§5.1、frontmatter へ移動) | `sources` を読む **SHOULD**、legacy の `# Citations` も解釈して **MAY** |

**新規に書くときは `timestamp` と `# Citations` を使わない。** 既存の v0.1 文書を読む場合のみ考慮する。

追加は純粋な additive: `sources` / `generated` / `verified` / `status` / `stale_after`、
`Attested Computation` とその関連キー、`# Computation` 見出し、actor 表記 (§7)。
それ以外(バンドル構造、予約名、必須の `type`、リンク、index/log、寛容な conformance)は
すべて v0.1 から引き継がれている。

> v0.2 を「後方互換なマイナー更新」と要約している二次情報があるが、SPEC.md §13.1 の
> 記述とは食い違う。Appendix A に v0.1 → v0.2 の移行例がある。

バンドルルートの `index.md` の frontmatter に `okf_version: "0.2"` を書ける。
**これは index.md に frontmatter が許される唯一の場所。**

## provenance ファミリ (§5.1)

```yaml
sources:
  - id: <stable-key>            # 任意。脚注 [^id] での主張単位の帰属に使う
    resource: <url|path|scope>  # ★ 要素内では必須
    title: <string>             # 任意
    author: <actor>             # 任意。信頼性シグナル
    usage_count: <integer>      # 任意。利用頻度シグナル
    last_modified: <YYYY-MM-DD> # 任意。鮮度シグナル
usage_window: { from: <YYYY-MM-DD>, to: <YYYY-MM-DD> }
```

`usage_count` は `usage_window` とセットで意味を持つ。期間なしの回数は解釈できない。

## trust ファミリ (§5.2)

```yaml
generated:
  by: <actor>   # ★ generated 内では必須
  at: <ISO-8601-datetime>

verified:
  - { by: <actor>, at: <ISO-8601-datetime> }
```

`verified` は**単一マッピングでも可**。consumer はそれを 1 要素リストとして扱う **MUST**。

### 信頼度ティア

| 条件 | ティア |
| --- | --- |
| `verified` キーなし | unverified |
| `human:` 以外の actor のみ | machine-confirmed |
| `human:<id>` の actor を含む | human-reviewed |

判定は `by` の `human:` プレフィックスで行う。エージェントが自称で human を名乗ってはならない。

## lifecycle ファミリ (§5.4–5.5)

- `status`: `draft` / `stable` / `deprecated`。既定は `stable`
- `stale_after`: `YYYY-MM-DD`。`today >= stale_after` で陳腐化

`deprecated` にする際は、本文冒頭に後継への Markdown リンクを置くのが実例での慣例
(公式サンプル `metrics/gross-margin-legacy.md` 参照)。**削除ではなく deprecated + 後継リンク**が推奨される。
過去の成果物の再現性が保たれるため。

## Attested Computation (§10) — v0.2 の目玉

「サンクションされた計算」を検証可能な形で持つための型。`type: Attested Computation` のときのみ有効。

```yaml
type: Attested Computation
runtime: bigquery            # ★ 必須。bigquery / postgres / dbt / python / Looker など
parameters:                  # 任意。型付きの穴
  - { name: year, type: integer, required: true }
computation: <path>          # 任意。省略時は本文の ``` フェンスに書く
executor:
  resource: <path>           # 実行手順・コードの場所
  receipt: [job_id, executed_sql, result]   # 実行が返すフィールド
attester:
  resource: <path>           # 決定的検証コード(LLM を使わない)の場所
```

**attester は「LLM を使わない決定的なチェック」**である点が要。
consumer は失敗した attestation を**黙って捨てず、必ず表面化させる SHOULD**。

使いどころは、集計値・指標の再現性を担保したいときなど。多くのリポジトリでは
この型を使う場面は少なく、`Reference` 系の文書から書き始めてよい。

## index.md (§8)

任意。各ディレクトリに置ける。frontmatter は原則不可(ルートの `okf_version` のみ例外)。

```markdown
# Subdirectories

* [tables](tables/index.md) - 説明
* [metrics](metrics/index.md) - 説明
```

## log.md (§9)

任意。変更履歴。日付降順のフラットな構成。

```markdown
## YYYY-MM-DD

- **Update**: 説明と [リンク](path.md)。
```

慣例のアクションラベル: `Update` / `Creation` / `Deprecation`(強制ではない)。

> 実装メモ: 公式サンプルの `log.md` は `type: Log` の frontmatter を持つ。
> 仕様上 log.md は予約名で conformance の `type` 必須ルールの対象外だが、付けても問題ない。

## 拡張性 (§5.3)

producer は**任意の追加キー**を frontmatter に置ける。
consumer は未知キーを round-trip で**保持しなければならない (MUST)**。破棄は仕様違反。

同様に、本文に任意のセクションを追加してよい。

## パス値の扱い (§6)

`resource` / `sources[].resource` / `computation` / `executor.resource` / `attester.resource` は
以下を受け付ける:

- 絶対 URL — `https://...`
- バンドル相対 — `/path/to/file`(先頭 `/`。移動に強い)
- 相対 — `../other.md`

## `references/` 慣例

外部資料のミラー、実行手順、コードをバンドル内の第一級コンセプトとして置くための命名慣例。
**要件ではない。** 例: `references/attesters/revenue.py`。

## consumer の義務(再掲・重要)

以下を理由に**バンドルやコンセプトを拒否してはならない (MUST NOT)**:

- 任意 frontmatter フィールドの欠落
- 未知の `type` 値
- 未知の追加 frontmatter キー
- リンク切れ
- `index.md` の欠如

OKF は「壊れていても読める」ことを優先した設計になっている。
厳格なスキーマ検証を期待してはならない。
