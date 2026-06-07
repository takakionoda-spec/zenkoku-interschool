# 全国インターナショナルスクール.com — 日本全国のインター専門ポータル

TOKYO習い事.com（https://github.com/takakionoda-spec/tokyo-naraigoto ）の姉妹サイト。同一アーキテクチャ：
**Astro + Cloudflare Pages + リポジトリ内JSON + GitHub Actions(10日毎) + Gemini無料枠 + Formspree + 口コミAI総評**

- エリア（8区分）: 北海道 / 東北 / 北陸 / 関東甲信越 / 中部 / 関西 / 中国・四国 / 九州・沖縄
- 学齢: プリ・幼稚部 / 小学部 / 中学部 / 高等部（複数タグ）
- 条件タグ: 全寮制 / 高校まで一貫教育 / 子どもの英語力必須 / 保護者の英語力必須 / IB認定 / 英語初心者サポートあり
- 口コミ: 投稿 → GitHub Issue非公開保管 → GeminiがAI総評に再構成して掲載（生口コミは公開しない）

## ローカルで動かす

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # dist/ に静的サイト生成
```

## デプロイ手順（tokyo-naraigotoと同一・約15分）

1. **GitHubリポジトリ作成**: `zenkoku-interschool`（Public）を作成しpush
2. **Cloudflare Pages**: Workers & Pages → Pages → Import an existing Git repository → 本リポジトリ → Framework preset: **Astro** → Save and Deploy
3. **Gemini APIキー**: リポジトリの Settings → Secrets and variables → Actions → `GEMINI_API_KEY` を登録（既存キーの使い回しでOK）
4. **Formspree**: 新しいフォームを作成し、`src/pages/index.astro` の `YOUR_FORM_ID` を差し替え
5. **口コミ受付トークン**: Issues(RW)のみのFine-grained tokenを発行し、Cloudflare Pagesの環境変数 `REVIEW_GITHUB_TOKEN` に登録 → Retry deployment
6. **巡回先登録**: `data/sources.json` に実在のスクール公式サイト等を登録
7. **動作確認**: Actions → auto-update → Run workflow

## 運用

| イベント | やること |
|---|---|
| 10日毎の自動更新（クロール+口コミ総評） | 何もしない |
| パートナー申込 | 該当スクールの `"partner": false` を `true` に変更してcommit |
| 修正・削除依頼 | JSONを編集してcommit |
| AIの誤データ | `git revert` で復旧 |
