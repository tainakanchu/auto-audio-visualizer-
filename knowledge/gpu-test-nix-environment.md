---
type: Playbook
title: GPU テストは nix develop -c 経由で実行する
description: pnpm test:gpu 等の GPU 系テストは nix develop -c を通さないと Playwright の Chromium 起動が失敗し、スイートごと黙って skip されたまま exit code 0 (緑) になる。
tags: [verification]
status: stable
generated: { by: claude-code/2.1.258+claude-sonnet-5, at: "2026-09-02T19:08:57Z" }
sources:
  - id: vitest-config
    resource: vitest.config.ts
    title: vitest の include パターン (*.gpu.test.ts も対象)
  - id: rng-gpu-test
    resource: src/synth/rng.gpu.test.ts
    title: ブラウザ起動失敗時に it.skip へフォールバックする実装
  - id: flake-nix
    resource: flake.nix
    title: nix devShell が chromium と CHROMIUM_BIN を供給する仕組み
stale_after: "2027-03-02"
---

# 結論

`pnpm test:gpu`（`vitest run gpu.test`。対象は `src/synth/**/*.gpu.test.ts` の 5 ファイル）は **`nix develop -c` を経由して実行しないと、GPU (WebGL2) 検証が実質的にスキップされたまま `vitest` が exit code 0 を返す**。

- 素の環境（`nix develop` を経ない）: Playwright の自前ダウンロード済み Chromium (`~/.cache/ms-playwright/...`) は起動しようとするが、共有ライブラリ（`libnspr4.so` 等）が見つからず起動に失敗する。テストコード側がこれを `try/catch` で捕まえ、ブラウザに依存するテストケースを `it.skip(...)` に倒す。**失敗ではなくスキップとして報告されるため、`vitest run` 自体は緑で終わる。**
- `nix develop -c` 経由: devShell が nix 提供の chromium と、その実行パスを指す `CHROMIUM_BIN` を渡す。テストコードは `CHROMIUM_BIN` があれば `executablePath` として明示的に使う。ここで初めて実際に GPU 検証が走る。

実測（本リポジトリ、2026-09-02、同一コミットで比較）:

| 実行方法 | Test Files | Tests | exit code |
| --- | --- | --- | --- |
| `pnpm test:gpu`（素の環境） | `2 passed \| 3 skipped (5)` | `2 passed \| 5 skipped (7)` | `0` |
| `nix develop -c pnpm test:gpu` | `5 passed (5)` | `19 passed (19)` | `0` |

**exit code はどちらも 0。「緑になった」ことは GPU 検証が実行された証拠にならない。** 実行件数・スキップ件数まで見る必要がある。

なお、依頼の骨子にあった「WebGPU が使えないため」という説明は誤り。実際にテストが使っているのは **WebGL2**（`canvas.getContext('webgl2')` + FBO + `readPixels`）であり、`navigator.gpu` / WebGPU API は登場しない（`src/synth/rng.gpu.test.ts:44` 等）。落ちる原因も「WebGPU 非対応」ではなく「Playwright 自前 Chromium の起動失敗」である。

# 根拠

`package.json` の該当スクリプト:

```
"test:gpu": "vitest run gpu.test"
```

`vitest.config.ts` の `include` は `src/**/*.test.ts` で、`*.gpu.test.ts` もこのパターンに含まれる（拡張子ベースの除外はない）。対象ファイル:

```
src/synth/rng.gpu.test.ts
src/synth/gl/compile.gpu.test.ts
src/synth/gl/render.gpu.test.ts
src/synth/gl/reactions.gpu.test.ts
src/synth/gl/coverage.gpu.test.ts
```

`src/synth/rng.gpu.test.ts` のブラウザ起動部分（他ファイルは `gpuHarness.ts` に切り出された同型ロジックを共有）:

```ts
const executablePath = (globalThis as { process?: { env?: { CHROMIUM_BIN?: string } } }).process
  ?.env?.CHROMIUM_BIN;
const launchOptions = {
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle'],
  ...(executablePath ? { executablePath } : {}),
};
...
try {
  browser = await chromium.launch(launchOptions);
  page = await browser.newPage();
} catch (e) {
  browserLaunchError = e;
  console.warn('[rng.gpu.test] browser unavailable — GPU parity tests will be skipped:', ...);
}

describe('synth/rng GPU parity', () => {
  if (!browser || !page) {
    it.skip(`browser unavailable — GPU parity tests skipped${...}`, () => {});
    return;
  }
  ...
});
```

`executablePath` は `process.env.CHROMIUM_BIN` があるときだけセットされる。`flake.nix` のコメントがこの理由を明記している:

```
# Playwright が自前でダウンロードする Chromium は共有ライブラリ
# (libnspr4.so 等) を見つけられないため、nix 側の chromium と
# 必要な system library を供給する。
...
shellHook = ''
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  # 注意: Playwright はこの環境変数を自動では参照しない。実測で、
  # 環境変数だけに頼った chromium.launch() は失敗する。
  # テスト側で launch({ executablePath: process.env.CHROMIUM_BIN }) の
  # ように明示的に渡すこと。
  export CHROMIUM_BIN="${pkgs.chromium}/bin/chromium"
'';
```

実測（素の環境、`pnpm test:gpu --reporter=verbose`）で実際に出たエラー:

```
[pid=...][err] .../chrome-headless-shell: error while loading shared libraries:
libnspr4.so: cannot open shared object file: No such file or directory
...
↓ src/synth/gl/render.gpu.test.ts > ... browser unavailable — GPU render tests skipped: ...
[coverage.gpu.test] browser unavailable — coverage drift tests will be skipped: ...
 Test Files  2 passed | 3 skipped (5)
      Tests  2 passed | 5 skipped (7)
```

素の環境でも `2 passed` になっている 2 ファイルは、同じファイル内にある「ブラウザ起動を要しない」テストケース（例: `coverage.gpu.test.ts` の一部）だけが実行された結果で、ブラウザ依存のケースはそのファイル内でも個別に `it.skip` されている。

`nix develop -c pnpm test:gpu` の実測:

```
 Test Files  5 passed (5)
      Tests  19 passed (19)
   Duration  50.10s (... tests 101.12s ...)
```

# 注意点

- **検知方法**: `pnpm test:gpu --reporter=verbose`（または既定 reporter でも `Test Files` / `Tests` の行）を見て、`skipped` が 0 であることを確認する。0 でなければ nix devShell の外で走っている可能性が高い。`[xxx.gpu.test] browser unavailable ...` という `console.warn` が出ていないかも確認する。
- CI やスクリプトで自動判定したい場合は、素朴に exit code だけを見ると常に緑になるため使えない。reporter 出力の `skipped` 件数、または `it.skip` メッセージの有無をパースする必要がある。
- `nix develop -c` 初回はビルドに数十秒〜数分かかる（devShell が chromium と多数の system library を取得するため）。2 回目以降はキャッシュされる。
- テスト内容は WebGL2 の CPU/GPU bit-exact 一致検証・レンダリング階調検証などであり、WebGPU API は使用していない。将来 WebGPU 系のテストを追加する場合はこの文書の前提が変わる点に注意。
