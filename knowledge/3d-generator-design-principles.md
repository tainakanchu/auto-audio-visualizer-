---
type: Decision
title: 3D Generator は「埋めない系」hero object を優先する
description: SDF レイマーチ系の 3D generator は画面を埋める背景型を避け、背景 density を 0 にし、面内グラデーションを必須にする方針を PR #35 で確立した。overlay ツールとしての透過性と噛み合う。
tags: [generator]
status: stable
generated: { by: claude-code/2.1.258+claude-sonnet-5, at: "2026-09-02T19:08:57Z" }
sources:
  - id: pr-35
    resource: https://github.com/tainakanchu/auto-audio-visualizer-/pull/35
    title: 'feat(synth): 3D (SDF レイマーチ) Generator を追加する'
    last_modified: "2026-08-06"
  - id: sdf-cube
    resource: src/synth/generators/sdfCube.ts
    title: 面内グラデーション（距離減衰・fresnel・AO）の実装例
  - id: render-gpu-test
    resource: src/synth/gl/render.gpu.test.ts
    title: レイマーチ source の distinct alpha 階調数を検査する permanent test
---

# 結論

3D (SDF レイマーチ) generator（PR #35 で追加された `sdfTunnel` / `sdfLattice` / `sdfBlob` / `sdfCube` の 4 個、以後の 3D generator にも適用される方針）の設計原則:

1. **画面を埋め尽くす背景型ではなく、「埋めない系」hero object を優先する。**
2. **背景（レイが何にも当たらない箇所）の density は 0** にする。
3. **面の陰影を NdotL 単色だけで決めない。** 面内で法線が一定な平面は NdotL だけだと段差状に量子化されるため、距離減衰・fresnel・AO などで**面内グラデーションを必須**にする。

採用理由: 本ツールは OBS 向けの透過オーバーレイであり、下のレイヤー（配信画面や他の映像ソース）が透けて見えることが前提。画面を隙間なく埋めるジオメトリは overlay としての存在意義（透過性）と衝突する。

# 根拠

PR #35 本文、`sdfCube` の shading に関する注記:

> 面の法線は面内で一定なので、単純な NdotL だと 3 面が 3 段のフラット値になり後段 Material に渡る情報がほぼゼロになる。ヘッドライトの距離減衰 `1/(1+k·t²)`・per-pixel の fresnel リム・AO を効かせて面内にグラデーションを出している。

実測 distinct alpha levels（256px フレーム、`render.gpu.test.ts` の permanent test 基準は「40 階調以上」）:

```
sdfTunnel 173   sdfLattice 192   sdfBlob 182   sdfCube 144
```

比較対象としてフラット系の既存 generator `nightMarketCurtain` は **4 階調**。NdotL 単色だけの設計だと一桁の階調しか出ない、という反例として PR 内で引用されている。この量子化を防ぐため `render.gpu.test.ts` に「レイマーチ source は 40 階調以上」という恒久的な回帰テストが追加された。

画面占有度の実測（`pnpm measure:coverage`、全 105 generator 中の順位。**降順 = 最も画面を埋める**）:

| id | meanAlpha (p50) | 順位 | solidFraction (p50) | 順位 |
| --- | --- | --- | --- | --- |
| `sdfTunnel` | 0.3260 | 82/105 | 0.0484 | 99/105 |
| `sdfLattice` | 0.2408 | 85/105 | 0.0753 | 94/105 |
| `sdfBlob` | 0.0300 | 103/105 | 0.0103 | 102/105 |
| `sdfCube` | 0.1259 | 95/105 | 0.0385 | 100/105 |
| （基準）`grid` | 0.7809 | 21/105 | 0.8086 | 26/105 |

4 個とも `solidFraction` では下位 11% に収まっており、「埋めない系」として設計どおりに着地したことが実測で確認されている。特に `sdfTunnel` は全画素の 98%（64121/65536）に何か描画しているが `solidFraction` は 0.048 と低く、density が中間調に収まることで下の映像をほとんど塞がない —— `meanAlpha` と `solidFraction` を別々に見るべき例として PR 内で言及されている。

採らなかった選択肢:

- **背景を埋める密なジオメトリ**（画面を隙間なく満たすデザイン）: overlay ツールとしての透過性という目的と衝突するため採用しなかった。
- **NdotL 単色シェーディングのみ**: 面内で情報量がほぼゼロになり量子化された縞・ベタ割れになるため採用しなかった（`nightMarketCurtain` が反例として引用されている）。

# 注意点

- この方針は `render.gpu.test.ts` の permanent test（distinct alpha ≥ 40）としてコード化されている。将来 3D generator を追加する際はこのテストが実質的な basis になる。
- `costClass: 'heavy'` な generator は `derivePatch` の tier-aware フィルタにより low tier では単体候補から除外される。3D generator を増やす際はこの budget 制約も踏まえる必要がある（PR #35 の core 部分の一つ）。
- 既存の 2D generator は `passes: 0` / `stateful: false` / `relativeFill` 最大 0.8 のため、この PR の tier フィルタ追加による medium/high tier の見た目への影響はない（low tier のみ影響）。
- `stale_after` は設定していない。内部設計方針であり外部仕様の陳腐化とは性質が異なるため、方針転換があれば追記/修正で更新する。
