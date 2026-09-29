---
type: Reference
title: Pro DJ Link ビートパケット (UDP 50001 / type 0x28) のレイアウト
description: CDJ/DJM が再生中に UDP 50001 へ流す 96 バイトのビートパケットのオフセット、pitch/BPM の換算式、ミキサー (device 0x21) の振る舞い。
tags: [tempo]
status: stable
generated: { by: claude-code/2.1.284+claude-opus-5-5, at: "2026-09-29T11:34:34Z" }
sources:
  - id: djl-beats
    resource: https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html
    title: "Deep Symmetry, DJ Link Ecosystem Analysis: Beats (Beat Packets 節)"
  - id: prolink-packet
    resource: scripts/prolink-packet.mjs
    title: 本リポジトリのパーサ / 生成器 (フィクスチャテストは scripts/prolink-packet.test.mjs)
stale_after: "2027-03-29"
---

# 結論

ビートパケットは **受信するだけで取れる**(仮想 CDJ として announce しなくてよい)。port 50001 を bind すれば、再生中の CDJ とミキサーがブロードキャストしてくる[^djl-beats]。

| オフセット | サイズ | 内容 |
| --- | --- | --- |
| `0x00`-`0x09` | 10 | magic `Qspt1WmJOL` (`51 73 70 74 31 57 6d 4a 4f 4c`) |
| `0x0a` | 1 | type = `0x28` |
| `0x0b`-`0x1e` | 20 | device name (ASCII、`00` 埋め)。`0x1f` は常に `01` |
| `0x20` | 1 | subtype = `00` |
| `0x21` | 1 | device number D (プレーヤー番号。ミキサーは `0x21` = 33。rekordbox は別の値) |
| `0x22`-`0x23` | 2 | len_r = `0x003c` (これ以降のバイト数)。**全長は 0x24 + 0x3c = 0x60 = 96 バイト** |
| `0x24`-`0x3b` | 4×6 | nextBeat / 2ndBeat / nextBar / 4thBeat / 2ndBar / 8thBeat までの ms (u32 BE) |
| `0x3c`-`0x53` | | `ff` 埋め |
| `0x54`-`0x57` | 4 | pitch (u32 BE)。`0x00100000` = ±0%、`0` = −100%、`0x00200000` = +100% |
| `0x5a`-`0x5b` | 2 | track BPM × 100 (u16 BE) |
| `0x5c` | 1 | 小節内の拍 Bb (1→2→3→4 循環) |
| `0x5f` | 1 | D の冗長コピー |

換算:

- pitch% = (raw − 0x100000) / 0x100000 × 100
- effective BPM = trackBpm × (1 + pitch/100)
- タイミング欄 (nextBeat など) は **pitch 0% 換算の値**。実時間にするには (1 + pitch/100) で割る。曲がその拍より前に終わるなら `0xffffffff`。

# 根拠

2026-09-29 に上記 URL を取得し、パケット図と本文の記述をオフセットごとに照合した[^djl-beats]。本文には "The 60-byte packets" とあるが、これは **16 進の 0x60** (= 96 バイト) で、len_r `003c` とも整合する。10 進の 60 バイトと読むと pitch/BPM に届かない。

パーサはこの図を 1 バイトずつ手で書き起こしたフィクスチャで検証している[^prolink-packet]。

# 注意点

- CDJ がビートを送るのは **再生中かつ rekordbox 解析済みの曲** のときだけ (CDJ-3000 は未解析曲も自前解析する)[^djl-beats]。
- ミキサーは **何も再生していなくても常に送る** (予備メトロノーム)。pitch は常に +0% で、BPM は master プレーヤーの値を中継する[^djl-beats]。
- Bb で小節頭が分かるのは **master プレーヤー由来のとき** (かつ DJ がビートグリッドを正しく打っているとき) だけ。ミキサー由来の Bb がどこに揃うかは資料に記述が無く未確認。
- port 50001 には 0x28 以外 (on-air 通知の短いパケット、CDJ-3000 の絶対位置パケット) も流れる。type で必ず弾く。
- 本リポジトリでの実装は実機 (CDJ/DJM) では未検証。シミュレータ (`pnpm prolink:sim`) とフィクスチャでのみ確認している。

[^djl-beats]: https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html
[^prolink-packet]: scripts/prolink-packet.mjs / scripts/prolink-packet.test.mjs
