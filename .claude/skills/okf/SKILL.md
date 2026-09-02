---
name: okf
description: Open Knowledge Format (OKF) の読み書きエキスパート。Google Cloud が策定した、ナレッジを YAML frontmatter 付き Markdown で表現するオープン仕様。このリポジトリの `knowledge/` バンドルへの調査結果の記録、既存 OKF バンドルの読み取り、conformance 検証を行う。「調べた内容を記録して」「OKF で書いて」「knowledge/ を見て」や、調査・検証で判明した再利用価値のある事実が出たとき(明示的な依頼がなくても)使用。
---

# OKF (Open Knowledge Format)

Google Cloud が 2026-06-12 に発表した、ナレッジをベンダー中立に表現するためのオープン仕様。
**1 コンセプト = 1 Markdown ファイル**、メタデータは YAML frontmatter。

- 仕様: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>
- **本リポジトリが準拠するバージョン: v0.2**

> 注意: 発表時のブログ記事は v0.1 と記載しているが、リポジトリ上の SPEC.md は既に v0.2。
> v0.2 で `Attested Computation` が追加された。常に SPEC.md を正とすること。

## このリポジトリでの使い方

調査・検証で判明した**再利用価値のある事実**は `knowledge/` バンドルに記録する。
詳しい運用ルールは [`references/repo-conventions.md`](references/repo-conventions.md)。

**記録する**: 外部仕様の調査結果、依存ライブラリ・データの癖と落とし穴、技術選定の根拠、再現手順。
**記録しない**: そのタスク限りの作業ログ、コードを読めば分かること、git 履歴に残ること。

### 他のメモ置き場との棲み分け

`knowledge/` は **git にコミットされ、チーム全員と全エージェントが共有する、ベンダー中立な調査結果**の置き場。

| 置き場 | 何を置くか | 共有範囲 |
| --- | --- | --- |
| `knowledge/` (OKF) | 再利用価値のある調査結果・判断の根拠 | リポジトリ全体。人もエージェントも読む |
| Claude Code の memory (CLAUDE.md 等) | エージェントへの恒常的な指示・運用ルール | Claude Code 固有 |
| 作業メモ (`/note`、scratchpad、issue コメント) | 進行中タスクの経過・思考のログ | その作業のあいだだけ |

「エージェントにこう振る舞ってほしい」は memory へ、「調べたらこうだった」は `knowledge/` へ。
作業ログは `knowledge/` に入れない。バンドルが膨らむと検索性が落ちて価値が下がる。

## 最小の書き方

conformant に必要なのは `type` だけ。まずこれで書き始めてよい。

```yaml
---
type: Reference
---
```

実務上は以下を推奨(すべて任意):

```yaml
---
type: Reference
title: 外部 API の CORS 対応状況
description: カタログ API は CORS 可、バックエンド直叩きは不可という差異。
tags: [api, constraints]
status: stable
generated: { by: <producer>/<version>, at: "2026-08-18T17:40:00Z" }
sources:
  - id: catalog-api
    resource: https://example.com/docs/api
    title: 公式 API ドキュメント
    last_modified: "2026-08-01"
stale_after: "2027-02-18"
---
```

## フィールド早見表

| フィールド | 必須 | 意味 |
| --- | --- | --- |
| `type` | **必須** | コンセプトの種別。空文字不可。中央登録制ではなく自由に命名する |
| `title` / `description` | 推奨 | 表示名 / 一文要約 |
| `resource` | 任意 | 対象アセットの正規 URI |
| `tags` | 任意 | 横断分類(リスト) |
| `status` | 任意 | `draft` / `stable` / `deprecated` (既定 `stable`) |
| `stale_after` | 任意 | `YYYY-MM-DD`。当日以降は陳腐化とみなす |
| `generated` | 任意 | `{ by: <actor>, at: <ISO8601> }`。`by` は必須 |
| `verified` | 任意 | `{ by, at }` またはそのリスト |
| `sources` | 任意 | 出典。各要素の `resource` は必須 |
| `usage_window` | 任意 | `usage_count` の集計期間 |

### タグは登録済み語彙から選ぶ

このリポジトリでは `knowledge/tags.yml` がタグの唯一の定義元。
新規作成・更新の前に、次を確認する。

```sh
cat knowledge/tags.yml   # 使用可能なタグと意味
```

`tags` には `knowledge/tags.yml` の `name` だけを使う。タグは本文のキーワード列ではなく、
複数文書を横断する検索軸として付ける。製品名・API名など文書固有の語は本文検索へ任せる。

登録済み語彙で表せない場合は、既存タグへ統合できないかを先に検討する。
新しい横断軸が本当に必要なときだけ `knowledge/tags.yml` へ説明付きで追加してから使う。
現時点で1文書しかなくても、今後も使う安定した検索軸として必要性を説明できるなら追加してよい。
単なる本文キーワードの代替になるタグは追加しない。

`type` の値は自由。実例: `Reference` / `Dataset` / `Decision` / `Playbook` / `Attested Computation`。
**未知の `type` を理由に読み取りを拒否してはならない**(仕様の consumer 義務)。

### actor 表記 (§7)

| 形式 | 例 | 用途 |
| --- | --- | --- |
| `human:<id>` | `human:jane.doe` | 人間。**信頼度判定のキー** |
| `<producer>/<version>` | `<producer>/<version>` | エージェント・ツール |
| `process:<id>` | `process:ci-nightly` | 自動処理 |

エージェントが `generated.by` を書くときは、**実行中の自分の producer 名とモデル/バージョンを実際に確認して**
`<producer>/<version>` 形式で書く。推測や、このテンプレートの例のコピーで済ませない。

信頼度は `verified` から導出される: `verified` なし → **unverified** / 非 `human:` のみ → **machine-confirmed** / `human:` あり → **human-reviewed**。

**エージェントが自分で書いた内容に `verified: { by: human:... }` を付けてはならない。** 人間のレビューを経て初めて付与される。

## ディレクトリ構成

```
knowledge/
  index.md          # 任意。ディレクトリ目次(予約名)
  log.md            # 任意。更新履歴(予約名)
  <concept>.md
  <subdir>/
    index.md
    <concept>.md
```

`index.md` と `log.md` は**予約名**でコンセプト文書には使えない。それ以外の `.md` はすべてコンセプト文書。

### リンク (§6)

コンセプト間は通常の Markdown リンクで結ぶ。関係の種類は本文の散文で表す。

- バンドル相対(推奨): `[revenue](/metrics/revenue.md)` — ファイル移動に強い
- 相対: `[revenue](./revenue.md)`

**リンク切れを理由に読み取りを拒否してはならない**(consumer 義務)。

## 本文の構成 (§4.2)

見出しは慣例であり必須ではない。`# Schema` / `# Examples` / `# Computation` がよく使われる。
出典を主張単位で紐付けるときは脚注 `[^source-id]` を使い、ラベルを `sources[].id` に一致させる。

## conformance 検証

書いたら必ず検証する。

```sh
pnpm knowledge:check
```

検証内容は仕様 §11 の 3 条件:

1. 予約名以外のすべての `.md` が**パース可能な YAML frontmatter** を持つ
2. すべての frontmatter が**非空の `type`** を持つ
3. 予約名 `index.md` / `log.md` は §8 / §9 の構造に従う

以下は**エラーにしてはならない**(仕様が consumer に禁じている):
任意フィールドの欠落 / 未知の `type` / 未知の追加キー / リンク切れ / `index.md` の欠如。
検証スクリプトはこれらを警告としてのみ報告する。

## 詳細リファレンス

- [`references/spec-digest.md`](references/spec-digest.md) — 仕様の詳細(Attested Computation、index/log の構造、拡張性、バージョニング)
- [`references/repo-conventions.md`](references/repo-conventions.md) — 本リポジトリでの運用ルール

## 落とし穴

- **`verified` は単一マッピングでもリストとして扱う**(consumer の MUST)。`verified: { by: ..., at: ... }` は 1 要素リストと等価
- **未知のキーは破棄せず保持する**。round-trip で消してはならない
- `stale_after` は絶対日付。相対表現(「3ヶ月後」)は書かない
- `generated.at` は ISO 8601 datetime、`stale_after` と `sources[].last_modified` は `YYYY-MM-DD`。粒度が違う
- 日付は**必ず実際の日付を確認してから書く**。推測で書かない
- 日付・日時の値は**引用符で囲む**。パーサによっては引用符なしの日付が `Date` に変換され、形式チェックが素通りする
- Web から取り込んだ題名は改行や制御文字を含むことがある。frontmatter に入れる前に改行を空白へ畳む
