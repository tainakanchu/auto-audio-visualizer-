---
type: Reference
title: Jev (TypeSafe AI) は文章を生成しない「判断専用」モデル — 生成ではなく分岐・選別・採点に使う
description: 'Jev は state(テキスト/JSON)と型付き質問(Choice / Score / Noul)を受け取り、確率付きの判断だけを 70〜500ms で返す System One モデル。Patch 生成や画像の良し悪し判定には使えないが、依頼→mood 語の解決、候補 Patch の一次選別、recipe ルーティングのような「有限選択肢からの判断」には使える。'
tags: [llm]
status: stable
generated: { by: claude-code/2.1.278+claude-fable-5-1, at: "2026-09-20T07:45:39Z" }
sources:
  - id: typesafe-blog
    resource: https://typesafe.ai/blog/introducing-system-one-models-and-jev
    title: Introducing System One Models & Jev (TypeSafe AI 公式ブログ)
    last_modified: "2026-09-15"
  - id: typesafe-docs-system-one
    resource: https://docs.typesafe.ai/concepts/system-one
    title: System One — TypeSafe AI Docs
  - id: typesafe-docs-api
    resource: https://docs.typesafe.ai/api.md
    title: HTTP API Reference — TypeSafe AI Docs
  - id: typesafe-docs-sdk-js
    resource: https://docs.typesafe.ai/sdk/javascript/api.md
    title: JavaScript SDK API Reference — TypeSafe AI Docs
  - id: typesafe-docs-models
    resource: https://docs.typesafe.ai/models
    title: Models — TypeSafe AI Docs
  - id: vercel-changelog
    resource: https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
    title: TypeSafe AI's Jev now available on AI Gateway (Vercel changelog)
  - id: devto-guide
    resource: https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e
    title: How to Use Jev — a practical guide (DEV Community、二次情報)
  - id: azukiazusa-ts
    resource: https://azukiazusa.dev/blog/jev-support-routing/
    title: TypeSafe AI の Jev を TypeScript で試してみた (二次情報)
  - id: ai-native-jp
    resource: https://www.ai-native.jp/blog/typesafe-jev-system-one-model-guide
    title: TypeSafe Jev 徹底解説 — 日本語入力での実装検証 (二次情報)
  - id: uravation
    resource: https://uravation.com/media/jev-typesafe-ai-system-one-guide-2026/
    title: Jev とは — 料金・仕様・使い方 (二次情報、制限値の出典)
stale_after: "2027-03-20"
---

# 結論

**Jev は LLM の代替ではなく「知能つきの if 文」。** 文章・コード・JSON を生成する能力は意図的に持たず、
`state`(テキスト / JSON)に対して型付きの質問を投げると、確率と確信度つきの判断だけを返す[^typesafe-blog]。
TypeSafe AI(創業者 Diogo Almeida、元 OpenAI)が 2026-09-15 に early access で公開した。
このカテゴリを同社は「System One model」と呼ぶ(Kahneman の速い思考に由来)。

このリポジトリのシーン作成(`vj-director` スキル → `vj-gen` / `vj-tweak` / `vj-preview`)に対しては:

| 工程 | Jev で置き換えられるか | 理由 |
| --- | --- | --- |
| 依頼文 → mood 語(`scripts/vj-vocab.json` の 68 語)の解決 | **できる** | 有限の選択肢からの Choice / 語ごとの Noul。LLM の 1 往復が 100ms 台に落ちる |
| 依頼文 → 既存 recipe(36 本)の当たり付け | **できる** | Choice(選択肢 ≤ 64)+「新規生成が必要か」の Noul |
| `vj-gen --count N` の候補を **JSON の内容(generator の tags / palette / composition)で** 一次選別 | **できる(粗い)** | Score でランキング。ただし見た目ではなくメタデータでの判断 |
| preview PNG を見て良し悪しを判断 | **できない** | **テキスト入力のみ。画像・音声・動画は非対応**[^typesafe-docs-system-one] |
| Patch JSON / tweak トークン列を生成 | **できない** | 生成能力なし。Patch 合成は今までどおり `vj-gen`(決定的コード)が担う |
| 本番中、bar 単位で「次の recipe に進むか」を状態から判断 | **できる(新用途)** | 70〜500ms なので拍スケールの判断に間に合う |

つまり **「LLM がやっている翻訳と選別の前半」は Jev に移せるが、「preview を見て決める後半」は移せない。**
後半の高速化は Jev とは無関係に、preview のデーモン化や候補一括レンダで行う必要がある。

# 仕様(一次情報)

## 入出力

- エンドポイント: `POST https://api.typesafe.ai/v1/systemone`、`Authorization: Bearer <API_KEY>`[^typesafe-docs-api]
- リクエスト: `{ state, model, questions }`。`state` は string | object | array。`questions` は名前 → 質問のマップ
- 質問は 3 種類だけ[^typesafe-docs-api]:
  - `noul`: はい / いいえ。`instructions` と任意の `criteria`(true / false の説明)。答えは `noul`(0〜1 の確率)
  - `choice`: 選択肢から 1 つ。`criteria` は選択肢 id → 説明のマップ(API 上限 255 個)。答えは `choice` / `probabilities` / `confidence`
  - `score`: ルーブリック採点。`criteria` はレベル説明の配列(2〜10 段階)。答えは `score`(加重値、段階の間の値も返る) / `legend` / `probabilities` / `confidence`
- 複数の質問は **1 リクエストで並列に評価される**。質問を増やしても時間はほぼ増えない(コストは入力トークン分だけ)[^typesafe-blog]
- 同期 API。ストリーミングは無い(生成しないので不要)

## モデル

- `jev-latest` と `jev-preview` はどちらも現行の `jev-1.13.0` を指す(2026-09-20 時点)。固定したいときは `jev-1.13.0` を指定する[^typesafe-docs-models]
- **英語が主学習言語。日本語・CJK は動くが精度は同等ではないと公式が明記**[^typesafe-docs-models]。二次情報では日本語の問い合わせ 12 件 × 60 問のトリアージで正答率 100%、ガードレール判定で 85.7% という報告がある[^ai-native-jp]が、自分のタスクで検証してから使うこと

## 上限・レート

- 1 リクエスト 64k トークン(state + 全質問)、かつ state + 最長の質問 1 つで 32k トークン[^typesafe-docs-models]
- レート: 1,200 req/min、250,000 tok/s。予告なく変わると公式が明記[^uravation]
- 二次情報に「1 リクエスト 32 質問まで、choice の選択肢 64 個まで」というゲートウェイ側の上限が出てくる(API リファレンスの 255 個より小さい)。**どちらが有効かは未検証**。安全側は 32 質問 / 64 選択肢

## 料金・速度

- 入力 $0.042 / 100 万トークン、**出力は無料**[^typesafe-blog]
- エンドツーエンド 70〜500ms(公式値。日本からの実測は未確認)[^typesafe-blog]
- 公式ベンチの「最大 193.6 倍高速 / 444.6 倍安価」は公式自身が「高めの見積もり」と注記している[^typesafe-blog]

## SDK(TypeScript)

- `npm install @typesafe-ai/sdk`(Node 20+)。`TYPESAFE_API_KEY` を環境変数から読む[^typesafe-docs-sdk-js]
- `TypeSafeClient` を生成し、`choice()` / `score()` / `noul()` ヘルパーで質問を組み、`client.systemOne({ state, questions })` を呼ぶ
- エラー型: `AuthenticationError` / `BadRequestError`(422) / `RateLimitError`(429) / `APITimeoutError` など。429 は SDK が指数バックオフで再試行する

```ts
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';

const client = new TypeSafeClient(); // TYPESAFE_API_KEY を読む。model 既定は jev-latest

const result = await client.systemOne({
  state: { request: '夜市の手前、湿った騎楼。ゆっくり漂う感じで', vocab: ['台湾', '夜', '湿った', '騎楼', '夜市'] },
  questions: {
    primaryMood: choice('依頼にいちばん近い mood 語', { 台湾: '台湾の街並み', 夜: '夜・街灯', 湿った: '湿度・雨上がり' }),
    isSlow: noul('依頼は「ゆっくり」「漂う」など秒スケールの動きを求めているか'),
    energy: score('依頼のエネルギー', ['静か', 'ふつう', '攻めた']),
  },
});
// result.answers.primaryMood.choice / .confidence, result.answers.isSlow.noul, result.answers.energy.score
```

(引数の細部は SDK リファレンスで要確認。上は記事のコードと公式の型名から起こした形の例で、実行して検証はしていない。)

## アクセス経路(2026-09-20 時点)

- 直接 API は **waitlist**。typesafe.ai で登録し、招待後に console.typesafe.ai でキーを発行する
- **Vercel AI Gateway** ではモデル id `typesafe-ai/jev` で即使える。AI SDK の `experimental_evaluate({ model, state, questions })` を使う(`generateText` ではない)[^vercel-changelog]。二次情報では 2026-09-25 まで無料とされる
- OpenRouter / Cloudflare / Netlify のゲートウェイ経由の提供も報じられているが、質問 API がそのまま通るかは未確認

# 使い方の指針(公式・二次情報の共通見解)

- **state には判断に要る情報だけ**を入れる。無関係な情報が増えると精度が落ちる(context rot)[^devto-guide]
- 独立した判断はまとめて 1 リクエストで投げる(speculative fan-out)。質問を後から足しても時間は増えない
- `confidence` の閾値は用途ごとに決める。読み取り専用の分岐は低め、本番の絵を変える操作は高め。閾値未満は LLM か人に回す(cascade)
- **文字どおりに読む**。否定・暗黙の前提・皮肉は拾えない。数え上げ・日付計算も苦手
- state はユーザー入力として扱われ、敵対的とはみなされない。外部入力をそのまま入れない

# 注意点

- 「型は必ず合う」と「判断が正しい」は別。schema の正しさは保証されるが、選択の正しさは確率でしか返らない
- 早期アクセス中で仕様・レート・料金は変わりうる。本文の数値は 2026-09-20 時点
- このリポジトリでは 2026-09-20 時点で **未導入・未検証**。上の表の「できる」は仕様上の判断であり、日本語の依頼文で実測した結果ではない

[^typesafe-blog]: https://typesafe.ai/blog/introducing-system-one-models-and-jev
[^typesafe-docs-system-one]: https://docs.typesafe.ai/concepts/system-one
[^typesafe-docs-api]: https://docs.typesafe.ai/api.md
[^typesafe-docs-sdk-js]: https://docs.typesafe.ai/sdk/javascript/api.md
[^typesafe-docs-models]: https://docs.typesafe.ai/models
[^vercel-changelog]: https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
[^devto-guide]: https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e
[^ai-native-jp]: https://www.ai-native.jp/blog/typesafe-jev-system-one-model-guide
[^uravation]: https://uravation.com/media/jev-typesafe-ai-system-one-guide-2026/
