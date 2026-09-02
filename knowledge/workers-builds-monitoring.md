---
type: Playbook
title: Cloudflare Workers Builds の結果は check-runs API で見る
description: 'Workers Builds のデプロイ結果は GitHub Checks API (commits/{sha}/check-runs) に "Workers Builds: <project>" として載る。従来の commit status API (commits/{sha}/status・/statuses) には出てこない。'
tags: [verification]
status: stable
generated: { by: claude-code/2.1.258+claude-sonnet-5, at: "2026-09-02T19:08:57Z" }
sources:
  - id: check-runs-observed
    resource: https://api.github.com/repos/tainakanchu/auto-audio-visualizer-/commits/a1b1cc72a3590845961c874fa418f5e4db3154d6/check-runs
    title: 'gh api ... /check-runs の実測出力 (main head a1b1cc7, PR #64 マージコミット)'
    last_modified: "2026-09-02"
  - id: wrangler-config
    resource: wrangler.jsonc
    title: Workers プロジェクト名 (name) — check-run 名の "<project>" 部分と一致
stale_after: "2027-03-02"
---

# 結論

このリポジトリの Cloudflare Workers Builds（Git 連携による自動デプロイ）の結果は、GitHub の **Checks API** (`GET /repos/{owner}/{repo}/commits/{sha}/check-runs`) を見るのが確実。

```sh
gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | {name, status, conclusion}'
```

`name` が `"Workers Builds: <project-name>"`（`<project-name>` は `wrangler.jsonc` の `name` フィールドと一致）のエントリを見る。`status`（`queued` / `in_progress` / `completed`）と `conclusion`（`completed` のときのみ `success` / `failure` 等）で結果を判定できる。`details_url` に Cloudflare dashboard の該当ビルドへの直リンクが入る。

**旧来の commit status API（`.../status`、`.../statuses`）には Workers Builds の結果が出てこない。** commit status だけを見る仕組みでは見落とす。

# 根拠

main head（PR #64 のマージコミット `a1b1cc7`）で実測:

```sh
$ gh api repos/tainakanchu/auto-audio-visualizer-/commits/a1b1cc72.../check-runs \
    --jq '.check_runs[] | {name, status, conclusion}'
{"conclusion":"success","name":"Workers Builds: auto-audio-visualizer","status":"completed"}
{"conclusion":"success","name":"Deploy","status":"completed"}
{"conclusion":"success","name":"Build","status":"completed"}
```

`"Workers Builds: auto-audio-visualizer"` の完全な check-run オブジェクトには以下が含まれる（抜粋）:

```json
{
  "name": "Workers Builds: auto-audio-visualizer",
  "status": "completed",
  "conclusion": "success",
  "details_url": "https://dash.cloudflare.com/.../workers/services/view/auto-audio-visualizer/production/builds/13b8c65f-...",
  "app": { "slug": "cloudflare-workers-and-pages", "id": 85455, "owner": { "login": "cloudflare" } },
  "output": { "summary": "\nBuild ID: [13b8c65f-...](...)\nScript: [auto-audio-visualizer](...)\nVersion ID: 577217fc-..." }
}
```

同じコミットに対する従来の commit status API は空/pending:

```sh
$ gh api repos/tainakanchu/auto-audio-visualizer-/commits/a1b1cc72.../status
{"state":"pending","statuses":[],"total_count":0, ...}

$ gh api repos/tainakanchu/auto-audio-visualizer-/commits/a1b1cc72.../statuses
[]
```

`wrangler.jsonc` にはプロジェクト名を Workers Builds 側と一致させる必要がある旨のコメントがある:

```jsonc
// Cloudflare Workers Builds 側のプロジェクト名と一致させること。
// ずれると Git 連携のビルドが「別の Worker へのデプロイ」になる。
"name": "auto-audio-visualizer",
```

これが check-run 名の `"Workers Builds: auto-audio-visualizer"` の由来。

# 注意点

- check-runs には GitHub Actions の他ジョブ（本リポジトリでは `"Build"` / `"Deploy"`、GitHub Pages 系）も同じ SHA に同居する。`name` を `"Workers Builds: <project>"` で絞り込むこと。
- `status` と `conclusion` は別フィールド。`status !== "completed"` の間は `conclusion` が `null` になる。
- 本リポジトリの PR には `cloudflare-workers-and-pages` bot がデプロイ結果テーブルをコメントとして投稿する場合もある（`gh pr view <n> --comments` で見える）。ただしこれは PR 起点の挙動で、push 直後の main のような PR に紐付かないコミットでは確認できていない。**check-runs API のほうが確実に確認できる。**
- ここで確認できたのは「Workers Builds の結果が Checks API に出て commit status API には出ない」という事実のみ。他リポジトリ・他 Cloudflare プロダクト（Pages 等）で同じ挙動になるかは未検証。
