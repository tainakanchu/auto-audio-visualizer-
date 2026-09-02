---
type: Decision
title: deck の bank recall は live look を変えない
description: deck の bank recall (A〜H) は呼び出し時に live の見た目を変えない設計にした。recall のたびに黙って seed:set を送っていた初期実装は、メイン窓のクラッシュ/リロード時に見た目とSettings.seedがズレるバグの原因になったため廃止し、明示的な「seed を採用」ボタンに置き換えた。
tags: [deck]
status: stable
generated: { by: claude-code/2.1.258+claude-sonnet-5, at: "2026-09-02T19:08:57Z" }
sources:
  - id: pr-64
    resource: https://github.com/tainakanchu/auto-audio-visualizer-/pull/64
    title: 'feat(deck): バンクの保存と復元'
    last_modified: "2026-09-02"
  - id: commit-a69c838
    resource: a69c8381f4c9750047d0293f25b36ae092110156
    title: 'fix(deck): bank recall no longer changes live look'
    last_modified: "2026-09-02"
  - id: commit-111ea76
    resource: 111ea76a10c0d30750337bfc4e8c104fe123e233
    title: 'fix(deck): bank restore UX and drop silent seed:set'
    last_modified: "2026-09-02"
  - id: readme-deck-section
    resource: README.md
    title: 'A〜H スロットの挙動の記述 (README.md:238)'
---

# 結論

Deck の bank slot（`A`〜`H`）の recall（クリックで呼び出し）は、**バンクの中身を差し替えるだけで、pad を自動で叩かず、`seed:set` も送らない**。live の画は recall の時点では変わらず、VJ が任意のタイミングで pad（例: pad 1）を押して初めて反映される。

バンクに保存されている `mainSeed` を実際に live へ反映したい場合は、menu の明示的な「**seed を採用**」ボタンを押す必要がある。このときだけ `seed:set` が送られ、`Settings.seed` とメインの画の両方が作り直される。

この設計は PR #64 のレビューで、初期実装（recall のたびに黙って `seed:set` を送る）が原因のバグが指摘されたことを受けて確定した（コミット `a69c838` → `111ea76`）。

# 根拠

PR #64（#60 の実装、bank の保存/復元機能）の 1 回目レビューでの指摘（should-fix 1、要旨）:

> `visualSeed` を `settings.seed` から分離したが、永続化されるのは `settings.seed` だけで、semantic-synth は `variation.seed` から derive する。シナリオ: バンク A を呼び出す → `seed:set mainSeed` → パネル表示は `mainSeed` になるが画は変わらない（仕様どおり）→ 本番中にメイン窓がリロード/クラッシュ → `generateVariation(settings.seed)` で**画面に出ていたものと別の絵**になる。クラッシュ耐性のための PR が、メイン窓のクラッシュ復帰をかえって悪化させている。

さらに、既存 issue 間の矛盾も指摘された:「#58 は `seed:set` = `Settings.seed` 更新 = 画が変わる、という仕様。一方 #60 は『呼び出しで live は変えない』を求めている」。判断として、**「呼び出し時に `seed:set` を送らない」**（recall は保存内容の差し替えのみ）を採用し、`App.tsx` の `visualSeed` / `adoptedSeedRef` / `nextVisualSeed` は撤回して #58 の `seed:set` セマンティクス（= 画も変わる）を素のまま維持した。

修正コミット `a69c838`（`fix(deck): bank recall no longer changes live look`）:

> Recall stores mainSeed only; apply it with the new 採用 button. clear current stays cleared until the next explicit bank edit. Rename Escape and long-press click ignore flags reset on start. Pending autosave flushes on unmount, pagehide, and hidden.

続く `111ea76`（`fix(deck): bank restore UX and drop silent seed:set`）で、"silent" な `seed:set` 送信を明示的に廃止した旨がコミットメッセージに明記され、README / PR 本文の記述もレビュー指摘（R2）を受けて修正された。

現状の実装を反映した記述（`README.md:238`）:

> 呼び出しはバンクを差し替えるだけで **pad は自動では叩かない**し **`seed:set` も送らない**（live の画は pad 1 などを押すまで変わらない）。menu の **seed を採用** を押すと `seed:set` が送られ、Settings.seed とメインの画の両方が作り直される

**VJ の現場操作としての文脈**: bank は「仕込み」であり、`A`〜`H`（BASE + V1..V7 相当）に複数のルックを事前に用意しておき、任意のタイミング（曲の切り替わりなど）で pad を押して発火させる運用を想定している。recall のたびに live が勝手に切り替わると、VJ が意図しないタイミングで画が変わってしまい、「仕込んでおいて任意のタイミングで出す」というワークフローが成立しない。

採らなかった代替案:

- **recall のたびに `seed:set` を自動送信する**（初期実装）: メイン窓のリロード/クラッシュ時に、永続化される `Settings.seed` と実際に見えていた絵がズレるバグを生むため廃止した。
- **`visualSeed` を `settings.seed` と分離した専用 state として持つ**: 上記バグの対症療法として初期実装で採られていたが、`derivePatch` の再構築やパネル表示との整合性が崩れる（表示中の seed を再適用する手段がなくなる等）ため撤回し、`App.tsx` を素の `generateVariation(settings.seed)` に戻した。

# 注意点

- `mainSeed` はバンクスナップショットに保存されるが、明示的に「seed を採用」しない限り live には反映されない。「recall したのに画が変わらない」のはバグではなく仕様どおりの挙動。
- recall 直後 ≤500ms の自動保存（debounce）で `mainSeed` が live の seed に上書きされないよう、次の明示的なバンク操作（`R` / `G` など）まで保持するガードが入っている（2 回目レビューの nit 指摘を受けて追加）。
- `clear current` は次の明示的なバンク操作（`rebuildFromLive` / `gachaBank` / `applySnapshot` / `saveToSlot`）まで自動保存を止める `clearedRef` で保護されている。これは recall の直接の設計判断ではないが、同じ PR で確立された関連する自動保存ガードの一つ。
- `stale_after` は設定していない。内部の UX 設計判断であり外部仕様の陳腐化とは性質が異なるため、方針転換があれば追記/修正で更新する。
