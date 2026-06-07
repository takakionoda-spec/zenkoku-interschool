/**
 * 口コミAI総評ジェネレーター
 * GitHub Actionsから実行。流れ:
 *   1. リポジトリのIssueから「[review] 」で始まる未処理口コミを収集
 *   2. data/reviews.json（全口コミの蓄積アーカイブ）に追記
 *   3. 新着があった教室ごとに、Geminiが蓄積された全口コミを解析して公平な総評を生成
 *      - 子ども本人の資質に起因する不満は教室評価に一般化しない
 *      - 事実の指摘のみ反映、誹謗中傷は除外
 *   4. classrooms.json の review フィールドを更新し、処理済みIssueをクローズ
 *
 * 必要な環境変数: GEMINI_API_KEY, GITHUB_TOKEN（Actions標準のもの）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(ROOT, 'src/data/classrooms.json');
const REVIEWS_PATH = path.join(ROOT, 'data/reviews.json');

const REPO = process.env.GITHUB_REPOSITORY || 'takakionoda-spec/zenkoku-interschool';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!GH_TOKEN || !GEMINI_API_KEY) {
  console.error('GITHUB_TOKEN / GEMINI_API_KEY が未設定です');
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'zenkoku-interschool-reviews',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) { await sleep(attempt * 30000); continue; }
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'null');
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(5000 * attempt);
    }
  }
}

function buildPrompt(classroom, reviews) {
  const lines = reviews
    .map((r, i) => `${i + 1}. [立場: ${r.role} / 満足度: ${r.rating}/5 / ${r.at?.slice(0, 10) ?? '日付不明'}]\n${r.text}`)
    .join('\n\n');
  return `あなたは子ども向け教室の口コミ解析担当です。
教室「${classroom.name}」（${classroom.description.slice(0, 80)}…）に寄せられた全${reviews.length}件の口コミを解析し、保護者向けの公平な「体験者総評」を1本、日本語200〜280字で作成してください。

解析規則（厳守）:
- 子ども本人の資質・性格・教室との相性に起因すると考えられる不満（例:「うちの子は上達しなかった」だけが根拠の酷評）は、教室自体の評価として一般化しない
- 指導内容、講師の対応、料金、連絡体制、安全面、設備などの具体的な事実の指摘は、良い内容も悪い内容も公平に反映する
- 誹謗中傷、根拠の示されない断定、人格攻撃は除外する
- 複数の口コミに共通して現れる点を優先する
- 「〜という声があります」「〜と感じる家庭もあるようです」のような伝聞調で書き、断定的な評価や順位付けはしない
- 口コミに含まれない情報を創作しない

--- 口コミ一覧 ---
${lines}

出力はJSONオブジェクト1つ: {"summary": "総評本文"}`;
}

async function listReviewIssues() {
  const issues = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/issues?state=open&per_page=100&page=${page}`,
      { headers: ghHeaders }
    );
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
    const batch = await res.json();
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues.filter((i) => i.title?.startsWith('[review] ') && !i.pull_request);
}

async function closeIssue(number) {
  await fetch(`https://api.github.com/repos/${REPO}/issues/${number}`, {
    method: 'PATCH',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
}

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const archive = fs.existsSync(REVIEWS_PATH)
    ? JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'))
    : {};
  const byId = Object.fromEntries(db.map((c) => [c.id, c]));

  const issues = await listReviewIssues();
  console.log(`未処理の口コミIssue: ${issues.length}件`);
  if (issues.length === 0) return;

  const touched = new Set();
  const processed = [];

  for (const issue of issues) {
    let review;
    try {
      review = JSON.parse(issue.body);
    } catch {
      console.log(`  ✕ #${issue.number} 本文がJSONでないためスキップ（クローズ）`);
      processed.push(issue.number);
      continue;
    }
    const id = review.classroomId;
    if (!byId[id]) {
      console.log(`  ✕ #${issue.number} 不明な教室ID: ${id}（クローズ）`);
      processed.push(issue.number);
      continue;
    }
    (archive[id] ??= []).push({
      role: String(review.role || '不明').slice(0, 30),
      rating: Math.min(5, Math.max(1, Number(review.rating) || 3)),
      text: String(review.text || '').slice(0, 2000),
      at: review.at || new Date().toISOString(),
      issue: issue.number,
    });
    touched.add(id);
    processed.push(issue.number);
    console.log(`  ✓ #${issue.number} → ${byId[id].name}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const id of touched) {
    const reviews = archive[id];
    console.log(`総評生成: ${byId[id].name}（全${reviews.length}件）`);
    try {
      const out = await callGemini(buildPrompt(byId[id], reviews));
      if (out?.summary && typeof out.summary === 'string') {
        byId[id].review = {
          summary: out.summary.trim().slice(0, 320),
          count: reviews.length,
          updatedAt: today,
        };
        console.log(`  ✓ 反映（${out.summary.length}字）`);
      } else {
        console.log('  ✕ 総評の生成結果が不正のためスキップ');
      }
    } catch (e) {
      console.log(`  ✕ 生成エラー: ${e.message}`);
    }
    await sleep(3000);
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
  fs.writeFileSync(REVIEWS_PATH, JSON.stringify(archive, null, 2) + '\n');

  for (const n of processed) {
    await closeIssue(n);
    await sleep(500);
  }
  console.log(`完了: ${processed.length}件のIssueを処理・クローズ`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
