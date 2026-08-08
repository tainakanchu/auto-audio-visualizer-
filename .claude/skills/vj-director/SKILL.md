---
name: vj-director
description: VJ ツールの semantic-synth を外部から操縦する。「映像を〜な感じに」「N小節後に切り替えて」等の依頼で使う
---

# vj-director

ブラウザで動いている **Semantic Synth** シーンを、WebSocket 中継 (`scripts/vj-bridge.mjs`) 越しに
CLI (`scripts/vj-ctl.mjs`) から操縦する。叩いているのは `src/synth/control.ts` の
`getSynthControl()` — UI パネルと同じ制御サーフェスなので、ここから出した指示は
画面上の操作とまったく同じ経路を通る（検証ゲートも同じように効く）。

映像を「いま」変えるだけでなく、**Timeline に予約する**（N 秒後 / N 小節後）ことができる。
本番中に人間の手を止めずに次の展開を仕込めるのがこの経路の主目的。

## 使う前に（3 ステップ）

1. **中継を起動する**（バックグラウンドで動かしっぱなしにする）

   ```bash
   pnpm bridge          # = node scripts/vj-bridge.mjs、127.0.0.1:7877 で待ち受ける
   ```

   `vj-bridge listening on ws://127.0.0.1:7877 ...` の 1 行が出れば OK。
   127.0.0.1 にしかバインドしないので LAN には出ない（無認証なので出してはいけない）。

2. **ユーザーにアプリを開いてもらう** — URL に `bridge=1` が要る。

   ```
   https://localhost:5173/?scene=semantic-synth&bridge=1
   ```

   ポートは `pnpm dev` の出力に従う。自己署名証明書なのでブラウザに警告が出ますが、詳細設定からアクセスを許可してください。`bridge=1` が無いとブラウザ側は中継に接続しないので、
   「シーンは映っているのに `no synth connected`」になる。ここは**ユーザーに頼む**必要がある
   （こちらからブラウザは開けない）。

   サブモニタなど複数台に同じ映像を出したいときは、メイン 1 台を通常どおり
   `?scene=semantic-synth&bridge=1`（synth、応答を返す）で開き、残りを
   `?scene=semantic-synth&bridge=1&mirror=1`（表示専用）で開く。mirror は何台でも可。

3. **疎通確認**

   ```bash
   node scripts/vj-ctl.mjs state
   ```

   - JSON が返る → 準備完了
   - `{"error":"no synth connected"}` → 2 のタブが開いていない / `bridge=1` が付いていない
     （mirror だけの接続では state 等の応答は返らない。synth が 1 台要る）
   - `{"error":"timeout after 20s"}` や `ECONNREFUSED` → 1 の bridge が起動していない

## リレー経由で操縦する（Cloudflare Worker）

同じ LAN にいない・ユーザーの端末で開いてもらう・`pnpm bridge` を立てたくないときはこちら。
ローカル bridge（上の 3 ステップ）と排他ではなく、接続先が変わるだけでプロトコルもコマンドも同じ。

1. room を作る（`vj-ctl.mjs` はこの呼び出しだけ WebSocket を開かない）

   ```bash
   node scripts/vj-ctl.mjs room --host <worker のホスト名>
   ```

   `room` / `pageUrl` / `ctlArgs` が JSON で返る。

2. `pageUrl` をユーザーに開いてもらう — `?scene=semantic-synth&room=<id>` が付いている必要がある。
   ここは**ユーザーに頼む**しかない（こちらからブラウザは開けない）。

   複数台に同じ映像を出す場合:
   - メイン（synth、応答を返す 1 台）: `?scene=semantic-synth&room=<id>`
   - サブモニタ（mirror、何台でも可）: `?scene=semantic-synth&room=<id>&mirror=1`

3. 疎通確認して、以降は**すべてのコマンドに同じ `--url` を付ける**

   ```bash
   node scripts/vj-ctl.mjs --url wss://<host>/room/<id> state
   node scripts/vj-ctl.mjs --url wss://<host>/room/<id> seed "humid-night-market"
   ```

注意点:

- room id は無認証の合鍵。URL を知っている人は誰でも映像を操縦できるので、公開の場に貼らない。
  使い捨てにして、本番ごとに `room` コマンドで作り直す。
- room が違うと `no synth connected` になる（room ごとに中継が完全に分離されている）。
- ブラウザ側は `?room=<id>` があればリレーへ、`?bridge=1` だけならローカル bridge へ繋ぐ。
  両方あるときは **room が優先**。
- リレーは同一オリジンの `wss://` なので mixed content にならず、`pnpm bridge` も不要。
- **synth は 1 台のまま。** mirror は表示専用で `findSynth` に入らないので、state 等の
  応答経路は壊れない。新しい synth が来ても mirror は切断されない。

## コマンド

すべて `node scripts/vj-ctl.mjs <command>`。共通オプションは `--port <n>`（既定 7877）と `--help`。

| コマンド | 何をするか |
|---|---|
| `state` | 現在の Patch / Timeline / nowSec / barCount などを表示 |
| `catalog` | Generator の一覧（id・category・tags・parameters・cost）を表示 |
| `seed <seed>` | seed から派生した Patch へ**いま**遷移（ガチャ） |
| `patch <file.json>` | VisualPatch を**いま**適用 |
| `event add ...` | 「N 秒後 / N 小節後に切り替える」を Timeline に予約 |
| `event remove <id>` | 予約を取り消す |
| `lock <sec>` | **今から N 秒間** Timeline をロック（この間の変更を拒否する） |
| `fire <externalId>` | `external` anchor のイベントを手で発火 |
| `record start` / `record stop` | 演出の記録開始 / 停止して JSON を吐く |
| `load <recording.json>` | 記録した演出を読み込んで再現 |

```bash
# 現在の状態を見る
node scripts/vj-ctl.mjs state

# カタログから Generator と tags を眺める
node scripts/vj-ctl.mjs catalog

# いますぐ雰囲気を変える（seed ガチャ）
node scripts/vj-ctl.mjs seed "humid-night-market"

# いますぐ狙った Patch を当てる
node scripts/vj-ctl.mjs patch /tmp/patch.json

# 30 秒後に seed を切り替える（ゆっくり遷移）
node scripts/vj-ctl.mjs event add --in 30 --seed rainy-qilou --transition slow

# 8 小節後に Patch を差し替える（テンポがロックされているときだけ発火する）
node scripts/vj-ctl.mjs event add --bar 8 --patch /tmp/next.json --label "chorus"

# 予約を取り消す（id は event add の出力に入っている）
node scripts/vj-ctl.mjs event remove ctl-1785957182217

# 今から 60 秒間は誰にも触らせない（MC 中・決めの画など）
node scripts/vj-ctl.mjs lock 60

# external anchor のイベントを手で発火
node scripts/vj-ctl.mjs fire drop

# 演出を記録して保存 → 後で再現
node scripts/vj-ctl.mjs record start
node scripts/vj-ctl.mjs record stop > recording.json
node scripts/vj-ctl.mjs load recording.json
```

`event add` のオプション:

- `--in <sec>` … 今から N 秒後（`start = {kind:'seconds', atSec: nowSec + sec}`）
- `--bar <n>` … 今から N 小節後（`start = {kind:'bar', bar: floor(barCount) + n}`）。`--bar` があればこちらが優先。
  テンポがロックされていない（`state.tempoLocked === false`）と bar anchor は発火しないので、その場合は `--in` を使う。
- `--seed <s>` / `--patch <file>` / `--label <s>` … intent。最低ひとつ要る（全部無いとエラー）。
- `--transition default | slow | cut` … 既定は `default`。`slow` は default の 2 倍かけて溶ける。`cut` は 120ms で切り替わる。

`--in` / `--bar` / `lock <sec>` はすべて**相対指定**。CLI が `state` を引いて絶対値に直してから送るので、
「今から 30 秒後」「今から 60 秒ロック」とそのまま書けばよい。

## 出力の読み方

- **exit 0** … 成功。stdout に結果 JSON（整形済み）。
- **exit 1 かつ `{"ok":false, "issues":[...]}` / `{"ok":false,"issue":"..."}`**
  … 通信は成功したが**提案が却下された**。issues を読んで直して投げ直す。
- **exit 1 かつ `{"error":"..."}`** … 通信または引数のエラー。stderr に対処のヒントが出る。
- `record stop` だけは例外で、recording の JSON を**再整形せずそのまま** stdout に出す。
  そのまま `> recording.json` して `load` に食わせられる。

## ムードを実装に翻訳する

依頼はたいてい「もっと湿った感じ」「懐かしい方向で」のような形容詞で来る。
まず `vj-gen.mjs`(後述)でムード語から生成してみると、この手順の大部分を省けることが多い。
ここでは vj-gen の結果を手で詰めるとき、または vj-gen が届かない作り込みのための手順を説明する。

**手で Patch を組む前に、カタログのコンタクトシートを目で見ること。** GLSL を読んで見た目を
推測するより、実際の描画を見た方が速いし外しにくい。ローカルだけで完結する（bridge 不要・
本番に送らない）:

```bash
# 全 Generator をグリッドで焼いた PNG（ラベル付き）。nix develop 推奨（CHROMIUM_BIN）
pnpm vj:preview --contact-sheet /tmp/contact-sheet.png
# または
node scripts/vj-preview.mjs --contact-sheet /tmp/contact-sheet.png
```

seed や手書き Patch も、送る前に同じ CLI でドライランできる:

```bash
pnpm vj:preview --seed humid-night-market /tmp/seed.png
pnpm vj:preview /tmp/patch.json /tmp/patch.png
```

プレビューは観測用。本番への適用はこれまでどおり `vj-ctl` / `vj-gen` 経由。

手順:

1. **コンタクトシートで見た目を掴む**（上記）。候補 id が分かってからタグを読む。
2. **`catalog` でタグを眺める。** 各 Generator には 5 軸のタグが付いている
   （`environment` / `culturalTexture` / `material` / `motion` / `affect`）。
   形容詞は主に **`affect`** と **`culturalTexture`** に対応する。
3. **`state` で現在の Patch を取る。** `currentPatch` をベースにする。ゼロから組むより、
   いま出ているものの operators を差し替える方が事故が少ない。
4. **operators を差し替えた Patch JSON を作る**（ステージ順・員数制限は下記）。
   送る前に `pnpm vj:preview path/to/patch.json /tmp/check.png` で見た目を確認してよい。
5. **`patch <file.json>` で適用。** 検証ゲートに落ちたら `issues` が返るので、それを見て直す。

### 実在するタグ → Generator の対応（`catalog` で確認できるもの）

| 依頼の言葉 | 引くタグ | 候補 Generator |
|---|---|---|
| 湿った・蒸し暑い・雨上がり | `affect: humid / wet` `material: wet-concrete` | `humidityLens`(field) `nightMarketCurtain`(source) `sway`(field) `wetConcrete`(material) `brakeLightRain`(material) |
| 懐かしい・昔の映像・color fade | `affect: nostalgic / 2000s / faded / analog` `culturalTexture: retro / broadcast / lo-fi` | `minidvFade` `crt` `fluorescent` `cheapLed` `misprint` `pixelate` `tapeWow`(field) |
| 台湾の街・環島・下町 | `culturalTexture: taiwan-streetscape / sinosphere` | `qilouShutter` `busJacquard` `grille` `brakeLightRain` `templeZigzag` `roadStitch` |
| 夜・街灯・湿った夜道 | `environment: urban-night` `affect: nocturnal` `material: sodium-vapor` | `sodium` `brakeLightRain` `nightMarketCurtain` `humidityLens` |
| 攻めた・不穏・壊れた | `affect: ominous / tense / broken / chaotic / unstable / eerie` `motion: glitch` | `typhoonShear`(field) `dropout`(modifier) `slice`(modifier) `noise`(field) `tapeWow`(field) |
| 静か・淡々・瞑想的 | `affect: meditative / quiet / slow / sparse / restrained / persistent` | `roadStitch` `mooringRope` `ink`(material) `points` `viaductJoints` `qilouShutter` |
| 硬い・インフラ・都市の骨格 | `affect: infrastructural / brutalist / heavy / metropolitan` `environment: urban / architectural` | `flyoverBeams` `viaductJoints` `grid` `wires` `tiles` |
| 派手・祝祭・電飾 | `affect: festive / ornate / electric / kitsch` `culturalTexture: signage / cyber` | `templeZigzag` `neon` `cheapLed` `busJacquard` |
| 生活・所帯じみた・コンビニ | `environment: domestic / late-night-store / interior` `affect: mundane / sterile / tropical` | `fanGuard` `freezerCyan` `fluorescent` |

存在しないタグを勝手に作らないこと。迷ったら `catalog` の出力を grep して確かめる。

### Patch の制約（守らないと検証ゲートで落ちる）

- `schemaVersion` は **1**。
- `operators` は**ステージ順に並べる**: `source` → `field` → `modifier` → `material`。
  順序が崩れているだけで落ちる。
- 有効数の上下限: **source 1–2 / field 0–2 / modifier 1–3 / material 1**。
  material はちょうど 1 個。modifier は最低 1 個要る（何もしたくないなら `repeat` を count=1 で置く等）。
- 各 operator の `id` は Patch 内で一意。`generatorVersion` は `catalog` の `version` と一致させる。
- `parameters` は Generator ごとの `parameters[].id` と min/max に従う。
- `routes` の `source` は `audio:bass|mid|treble|level|beat|barPhase|beatPhase` / `time` / `operator:<opId>`、
  `target` は `<opId>.<paramId>`。自分自身を変調する route は落ちる。

```json
{
  "schemaVersion": 1,
  "seed": "wet-qilou-night",
  "operators": [
    { "id": "src", "generatorId": "qilouShutter", "generatorVersion": 1,
      "parameters": { "density": 28, "openness": 0.3, "wear": 0.6 } },
    { "id": "lens", "generatorId": "humidityLens", "generatorVersion": 1,
      "parameters": { "blobs": 3, "refraction": 0.55, "amount": 0.25 } },
    { "id": "rep", "generatorId": "repeat", "generatorVersion": 1,
      "parameters": { "count": 2 } },
    { "id": "mat", "generatorId": "wetConcrete", "generatorVersion": 1,
      "parameters": { "hue": 205, "speckle": 0.45, "sheen": 0.4 } }
  ],
  "routes": [
    { "source": "audio:level", "target": "lens.amount",
      "amount": 0.15, "polarity": "unipolar", "smoothing": 1.2 }
  ],
  "palette": { "mode": "analogous", "hueOffset": 205, "saturation": 28, "lightness": 42 },
  "composition": { "symmetry": 1, "scale": 1, "speed": 0.35 },
  "qualityTier": "medium"
}
```

（パラメータ名・範囲は `catalog` の出力が正。上の値は形の例。）

## vj-gen.mjs / vj-tweak.mjs — 手で Patch を組む前に

「ムードを実装に翻訳する」の手順は結局のところ**手で Patch JSON を組む**作業で、タグを読んで
operator を選び、パラメータを打ち込み、検証ゲートで弾かれたら直す…を繰り返すことになる。
`scripts/vj-gen.mjs` と `scripts/vj-tweak.mjs` はこの手順をローカルで肩代わりする CLI で、
どちらも `vj-ctl.mjs` を子プロセスとして呼ぶだけ（WebSocket 通信は自前で行わない）。**まず
vj-gen を試して、狙いから外れた部分だけ vj-tweak で直す**のが速い。手で Patch を組むのは、
この2つで届かない微調整だけでいい。

両方とも `--url` か環境変数 `VJ_URL` が必要（`vj-ctl.mjs` と同じ）。送信前に
`src/synth/validate.ts` と同じ規則でローカル検証するので、検証ゲートで弾かれてからの
往復が減る。どちらも `scripts/.vj-catalog-cache.json`（gitignore 済み・コミットしない）に
catalog をキャッシュし、次回以降は `vj-ctl.mjs catalog` を叩かずに済ませる。catalog が
更新されたのに古いキャッシュが残っていると、catalog に無い generator/parameter で
ローカル検証が誤って通る/落ちることがあるので、そのときは `--refresh-catalog` を付ける。

**この2つのローカル検証は `src/synth/validate.ts` の手作業による複製で、しかも
budget/cost チェックを含まない。** 複製は放っておくと古くなる実例が実際にあった —
`src/synth/validate.ts` の `AUDIO_SOURCES`（route の `source` に書ける `audio:*` の
集合、10 種類）に対し、`vj-gen.mjs` 側の複製は `audio:beatIntensity` /
`audio:gridPulse` / `audio:barPulse` の3つが抜けたまま7種類しかなく、この3つを使う
正当な Patch をローカル検証が誤って弾いていた（修正済み・
`scripts/constants-drift.test.mjs` がドリフトを恒久的にガードしている）。加えて、
`src/synth/cost.ts` の `fitsBudget(estimateCost(...))`（render budget 超過チェック）は
どちらのローカル検証にも**まったく実装されていない**。つまりこの2つのローカル検証を
通っても、サーバ側で budget 超過として弾かれることがある。**送信前には
`scripts/vj-validate.mjs`（後述）も併せて通すこと。** 複製ではなく本物の `.ts` を
実行するので、ルールのズレも budget チェックの欠落も構造的に起きない。

## vj-gen.mjs — ムード語から生成する

`"雲 静寂 青"` のような気分語（日本語 / 英語 / ローマ字が混在してよい）を
`scripts/vj-vocab.json` で引き、101 個の Generator カタログに対してタグ制約付きの
**決定的な重み付きサンプリング**（Efraimidis–Spirakis）で operators / palette / composition /
routes を組み立てる。**手書きプリセットは無い** — 同じ小さな語彙から無限のバリエーションが
出る。同じ語 + 同じ seed なら常に同じ Patch になる（Math.random は使わない）。

```bash
# 生成してそのまま送る（seed は語から自動導出）
node scripts/vj-gen.mjs --url wss://example.workers.dev/room/xxxx "雲 静寂 青"

# 検証だけ通して中身を見る（送信しない）
node scripts/vj-gen.mjs --url wss://example.workers.dev/room/xxxx --dry-run "雲 静寂 青"

# 候補を3つ並べて比較する（送信は絶対にしない）
node scripts/vj-gen.mjs --url wss://example.workers.dev/room/xxxx --count 3 "攻めた 派手"

# seed を固定して再現する
node scripts/vj-gen.mjs --url wss://example.workers.dev/room/xxxx --seed take2 "夜 青"

# 今アクティブな Patch をベースに、タグの合わない operator だけ差し替える
# （palette/composition は変えない）
node scripts/vj-gen.mjs --url wss://example.workers.dev/room/xxxx --base --dry-run "夜 青"
```

オプション:

| オプション | 効果 |
|---|---|
| `--dry-run` | 検証済みの Patch を stdout に出すだけで送信しない |
| `--count <n>` | n 個の独立候補を配列で出す。**送信は絶対にしない**（比較専用） |
| `--seed <s>` | 実効 seed を上書き（省略時は語から決定的に導出） |
| `--base` | 今の Patch をベースに、タグが合わない operator だけ入れ替える |
| `--refresh-catalog` | catalog キャッシュを無視して取り直す |

収録語は `scripts/vj-vocab.json`。1語 = `{ aliases, tags(5軸), composition/palette の数値ヒント,
energy }` の素の JSON マップで、**追記して育てられる**。手で足りない語に当たったら、近い
既存語のエントリを真似て追加すればよい（`tags` の軸は catalog 側の Generator が持つ軸 —
`affect` / `motion` / `material` / `environment` / `culturalTexture` — と一致させること）。

## vj-tweak.mjs — 今の Patch の一部だけ差し替える

vj-gen が「だいたい欲しい絵」を作る道具なら、vj-tweak は「今出ている絵から狙った箇所だけ
動かす」道具。今アクティブな Patch を取得し、`<change>` トークン列で差分を表現し、送信前に
ローカルで検証する。

```bash
# パラメータを1つ変える
node scripts/vj-tweak.mjs --url wss://example.workers.dev/room/xxxx src0.frequency=4.2

# operator を追加する（id 省略時は src0 のように自動採番）
node scripts/vj-tweak.mjs --url wss://example.workers.dev/room/xxxx --dry-run +threshold:th1 th1.thresholdValue=0.6

# operator を削除しつつ palette / qualityTier も変える
node scripts/vj-tweak.mjs --url wss://example.workers.dev/room/xxxx -fld1 palette.mode=rainbow qualityTier=high

# generator を差し替える（parameters はその generator の default に初期化される）
node scripts/vj-tweak.mjs --url wss://example.workers.dev/room/xxxx --refresh-catalog src0:=noise-field
```

`<change>` トークン（7種、この順でチェックされる）:

| トークン | 効果 | 例 |
|---|---|---|
| `-<opId>` | operator を削除 | `-fld1` |
| `+<generatorId>[:<opId>]` | operator を追加（id 省略時は自動採番） | `+threshold:th1` |
| `<opId>:=<generatorId>` | generator を差し替え（parameters は初期化） | `src0:=noise-field` |
| `<opId>.<paramId>=<value>` | パラメータを変更 | `src0.frequency=4.2` |
| `palette.<key>=<value>` | palette を変更（mode/hueOffset/saturation/lightness） | `palette.mode=triadic` |
| `composition.<key>=<value>` | composition を変更（symmetry/scale/speed） | `composition.speed=1.5` |
| `qualityTier=<value>` | qualityTier を変更（low/medium/high） | `qualityTier=high` |

送信前のローカル検証は `src/synth/validate.ts` の主要ルール（generator/parameter の実在・型・
範囲、enum、ステージ本数の上下限、`palette.mode`）を複製したもの。**この複製は一度
古くなって実害を出したことがある**（`AUDIO_SOURCES` に `audio:beatIntensity` /
`audio:gridPulse` / `audio:barPulse` が抜けていた — 上の節を参照。修正済み・
`scripts/constants-drift.test.mjs` がドリフトを恒久的にガードしている）が、
budget/cost チェックは今も一切含まない。
かつては「CLI は `.ts` を import できない」ことがこの複製の理由だったが、**それはもう
正しくない** — `scripts/vj-validate.mjs`（後述）が Vite の SSR モジュールローダーで
`.ts` を直接実行できることを示している。サーバ側のルールを変えたらここも合わせて直す、
という運用は変わらず必要だが、**送信前の最終確認は複製であるここではなく
`vj-validate.mjs` で行うこと。**

**operator の差し替え・削除をしたときは route の追従に注意。** `<opId>:=<generatorId>` や
`-<opId>` で operator の generator が変わる/消えると、その operator のパラメータを target に
していた route（や `operator:<opId>` を source にしていた route）が壊れたまま残ることが
ある。vj-tweak は差し替え・削除のたびに route を洗い直し、実在しなくなった operator /
パラメータを参照する route を自動的に落とす。**黙っては消さない** — 何を落としたかは必ず
stderr に警告として出る。

## vj-validate.mjs — 送信前に本物の検証ゲートを通す

`vj-gen.mjs` / `vj-tweak.mjs` のローカル検証は `src/synth/validate.ts` の手作業による
複製で、budget/cost チェックが無く、サーバ側のルールが変わると気付かないまま古くなる
（上の節で触れた `AUDIO_SOURCES` の欠落が実例）。`scripts/vj-validate.mjs` はこれを
解消する CLI。**「CLI は `.ts` を import できない」という前提はもう成り立たない** —
Vite の SSR モジュールローダー（`server.ssrLoadModule`。`measure-coverage.mjs` と同じ
手法）で `src/synth/{schema,validate,cost,catalog,generators/index}.ts` をそのまま
実行する。複製ではなく本物を呼ぶので、サーバ側のゲート（`gatePatchProposal`、
`src/synth/apply.ts`）とルールが食い違うことは構造的に無い。`vj-ctl.mjs` は一切
呼ばない（WebSocket 通信もしない）ので `--url` は不要 — 完全にローカルで完結する。

サーバ側の `proposePatch` と同じ3段階をそのままなぞる:

1. `parsePatch`（schema.ts）— スキーマ検証（valibot）
2. `validatePatch`（validate.ts）— 構造ルール（id 一意性・generator 実在・ステージ順・
   員数・パラメータ型域・route・画像テクスチャスロット参照）
3. `fitsBudget(estimateCost(...))`（cost.ts）— **budget/cost チェック。vj-gen.mjs /
   vj-tweak.mjs のローカル検証には無い、この3段のうち唯一サーバ側でしか弾けなかったもの。**

```bash
node scripts/vj-validate.mjs patch.json              # 1 ファイル
node scripts/vj-validate.mjs dir/*.json               # 複数ファイル
node scripts/vj-validate.mjs --stdin < patch.json      # stdin から1つ
node scripts/vj-validate.mjs --quality low patch.json  # budget チェックだけ低い tier で試す（what-if）
```

- **OK** … operator 構成（`category:generatorId` の並び）・estimated cost
  （total/passes/heavy/stateful）・qualityTier を1ブロックで表示。exit 0。
- **NG** … 失敗した段階（`json` / `schema` / `structural` / `budget`）ごとに issue を
  列挙。budget 起因の NG は実測コストと budget の上限を構造化した行で必ず併記する
  （メッセージ文字列だけに頼らない）。exit 1。
- `--quality <tier>` は budget チェックに使う tier だけを上書きする what-if
  オプション。省略時は本番の `proposePatch` と同じく **patch 自身の `qualityTier`**
  を使う（`src/scenes/semanticSynth.ts` が `DEFAULT_BUDGETS[parsed.patch.qualityTier]`
  を渡しているのに合わせてある）。`estimateCost` 自体は常に `patch.qualityTier` を
  見るので、`--quality` を変えても cost の実測値は変わらない。

**`vj-ctl.mjs patch <file>` で送る前は、必ず `vj-validate.mjs` を通すこと。** 特に
budget 超過はローカル検証（vj-gen.mjs / vj-tweak.mjs）では一切検出できず、送ってから
`{"ok":false,"issues":[...]}` で初めて分かる。手で組んだ Patch はもちろん、vj-gen /
vj-tweak の `--dry-run` の出力も対象にすること。

## いつ何を使うか

- **「〜な感じにして」「ムードで」「とりあえず変えて」** → `vj-gen.mjs "<mood words>"` を
  まず試す。狙いが緩いときはそのまま送り、外れていたら `--count` で比較するか
  `vj-tweak.mjs` で寄せる。手で Patch JSON を組むのは最後の手段。
- **手で組んだ Patch JSON、または vj-gen/vj-tweak の `--dry-run` 結果を送る前** →
  `vj-validate.mjs <file>` を通す。budget 超過はここでしか検出できない。
- **「すぐ変えて」** → `seed <s>`（狙いが緩いとき・ガチャでよいとき）か `patch <file>`（狙いが明確なとき）。
- **「後で変えて」「サビで」「あと 1 分くらいしたら」** → `event add`。
  秒で言われたら `--in`、小節で言われたら `--bar`。予約した id は出力に入っているので控えておく。
- **「今のを保存して」「さっきの流れをもう一回」** → `record start` … `record stop > file.json` → `load file.json`。
- **「しばらくいじらないで」** → `lock <sec>`（今から N 秒）。

## ユーザーの美的傾向

台湾の生活素材（騎楼のシャッター、鉄格子、ビニールカーテン、バスの座席柄）、環島の道中、
PA 機材やスピーカーのような即物的な構造物、2000 年代の映像機器（MiniDV・CRT・安い LED）を好む。
湿度と夜の街灯、蛍光灯の下の生活感が基調で、色は低彩度に寄る。時間の作り方はアンビエントで、
**変化は秒スケールでゆっくり**。ビートに合わせて爆発させたり、フラッシュで殴ったりはしない。
迷ったら `--transition slow`、`composition.speed` は低め、audio route の `amount` は控えめ・
`smoothing` は長めにする。`cut` と強い audio 変調は、明確に「切って」と言われたときだけ。
