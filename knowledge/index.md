---
okf_version: "0.2"
---

# knowledge バンドル

調査・検証で判明した、再利用価値のある事実を [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) v0.2 で記録している。

1 コンセプト = 1 Markdown ファイル。書き方と運用ルールは `okf` スキル (`.claude/skills/okf/`) を参照。
タグ語彙は [tags.yml](tags.yml)、更新履歴は [log.md](log.md)。

# コンセプト

* [gpu-test-nix-environment](/gpu-test-nix-environment.md) - GPU テストは nix develop -c 経由で実行する
* [workers-builds-monitoring](/workers-builds-monitoring.md) - Cloudflare Workers Builds の結果は check-runs API で見る
* [3d-generator-design-principles](/3d-generator-design-principles.md) - 3D Generator は「埋めない系」hero object を優先する
* [deck-bank-recall-decision](/deck-bank-recall-decision.md) - deck の bank recall は live look を変えない
