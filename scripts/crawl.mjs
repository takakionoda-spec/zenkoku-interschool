/**
 * 全国インターナショナルスクール.com 自動クローラ
 * GitHub Actions から10日毎に実行される。
 *
 * 流れ:
 *   1. data/sources.json のURLを巡回し、本文テキストを抽出
 *   2. Gemini(無料枠) に渡し、スクール情報を構造化JSONで抽出
 *      （エリア/学齢/特徴タグ判定・200字紹介文の生成）
 *   3. 既存データと重複排除して src/data/classrooms.json に追記
 *
 * 必要な環境変数: GEMINI_API_KEY
 * 依存パッケージ: なし（Node 20+ 標準のfetchのみ）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(ROOT, 'src/data/classrooms.json');
const SOURCES_PATH = path.join(ROOT, 'data/sources.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 15);
const MAX_CHARS_PER_PAGE = 18000;

const AREAS = ['hokkaido', 'tohoku', 'hokuriku', 'kanto', 'chubu', 'kansai', 'chushikoku', 'kyushu'];
const STAGES = ['preschool', 'elementary', 'middle', 'high'];
const FEATURES = ['boarding', 'k12', 'english-required', 'parent-english', 'ib', 'support-ja'];

if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY が未設定です。GitHub Secrets に登録してください。');
  process.exit(1);
}

// ---------- ユーティリティ ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS_PER_PAGE);
}

async function isAllowedByRobots(url) {
  try {
    const u = new URL(url);
    const res = await fetch(`${u.origin}/robots.txt`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return true;
    const txt = await res.text();
    let applies = false;
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (/^user-agent:\s*\*/i.test(line)) applies = true;
      else if (/^user-agent:/i.test(line)) applies = false;
      else if (applies) {
        const m = line.match(/^disallow:\s*(\S*)/i);
        if (m && m[1] && u.pathname.startsWith(m[1])) return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ZenkokuInterschoolBot/1.0; national international-school portal)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text());
}

const nameKey = (name) =>
  name.replace(/[\s　・,、。．.\-–—()（）「」『』]/g, '').toLowerCase();

const slugify = (name, area) => {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = [...name].reduce((h, ch) => ((h * 31 + ch.codePointAt(0)) >>> 0), 0).toString(36);
  return `${area}-${ascii || 'school'}-${hash}`.slice(0, 64);
};

// ---------- Gemini ----------
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.log(`  Gemini rate limit。${attempt * 30}秒待機...`);
        await sleep(attempt * 30000);
        continue;
      }
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Geminiの応答が空です');
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(5000 * attempt);
    }
  }
}

function buildPrompt(pageText, sourceUrl, areaHint) {
  return `あなたは日本全国のインターナショナルスクール専門ポータル「全国インターナショナルスクール.com」のデータ整備担当です。
以下のWebページ本文から、0歳〜18歳の子ども向け「インターナショナルスクール・プリスクール・ボーディングスクール」の情報を抽出し、JSON配列で出力してください。
該当する学校情報が見つからない場合は空配列 [] を返してください。学習塾・英会話教室・大学・広告・求人は除外してください。

【最重要ルール】出力の単位は「スクール（学校）」であり、「学年・コース・キャンパス内のクラス」ではありません。
- 同一スクールの幼稚部/小学部/中学部/高等部は1件にまとめ、stagesフィールドで表現すること
- 同一運営の複数キャンパスが明確に別の学校として運営されている場合のみ、キャンパス単位で分けてよい
- 1ページからの出力は最大5件まで

各要素のスキーマ（全フィールド必須）:
{
  "name": "スクールの正式名称（日本語表記が一般的な場合は日本語、なければ英語）",
  "area": "${AREAS.join(' | ')} のいずれか。hokkaido=北海道、tohoku=青森/岩手/宮城/秋田/山形/福島、hokuriku=新潟を除く富山/石川/福井、kanto=東京/神奈川/千葉/埼玉/茨城/栃木/群馬/山梨/長野/新潟、chubu=愛知/岐阜/静岡/三重、kansai=大阪/京都/兵庫/滋賀/奈良/和歌山、chushikoku=中国地方と四国、kyushu=九州と沖縄。所在地が不明ならエリアヒント "${areaHint}" を使う",
  "stages": "[${STAGES.join(', ')}] から該当する学齢の配列。preschool=0〜6歳のプリ/幼稚部、elementary=小学部、middle=中学部、high=高等部",
  "features": "[${FEATURES.join(', ')}] から該当するものの配列（なければ[]）。boarding=寮がある全寮制/ボーディング、k12=高校までの一貫教育、english-required=入学時に子どもの英語力要件（テスト/面接）がある、parent-english=保護者にも英語力が実質必要（連絡が英語のみ等）、ib=国際バカロレア(IB)認定校、support-ja=英語初心者でも入学可/日本語サポートあり。本文に明確な根拠がある場合のみ付与する",
  "address": "所在地（番地まで不明なら市区町村まで）",
  "station": "最寄り駅やアクセス（不明なら'要問い合わせ'）",
  "ages": "対象年齢・学齢（例: '3歳〜18歳（K-12一貫）'。不明なら'要問い合わせ'）",
  "price": "年間学費の目安（例: '年間学費目安 180万円〜'。不明なら'要問い合わせ'）",
  "description": "保護者向けの紹介文。スクールの特徴・カリキュラム・入学要件・どんな家庭に向くかを、ページ本文の事実のみに基づいて日本語180〜220文字で書く。誇張や創作は禁止",
  "url": "スクールの公式URL（不明なら出典ページのURL '${sourceUrl}'）"
}

出典ページURL: ${sourceUrl}

--- ページ本文 ---
${pageText}`;
}

function validate(item) {
  return (
    item &&
    typeof item.name === 'string' && item.name.length >= 2 &&
    AREAS.includes(item.area) &&
    Array.isArray(item.stages) && item.stages.length > 0 && item.stages.every((s) => STAGES.includes(s)) &&
    Array.isArray(item.features) && item.features.every((f) => FEATURES.includes(f)) &&
    typeof item.description === 'string' && item.description.length >= 50
  );
}

// ---------- メイン ----------
async function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  const { sources } = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const existingKeys = new Set(db.map((c) => nameKey(c.name)));
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;

  for (const src of sources) {
    if (added >= MAX_NEW_PER_RUN) break;
    console.log(`\n▶ ${src.url}`);
    try {
      if (!(await isAllowedByRobots(src.url))) {
        console.log('  robots.txt により巡回をスキップ');
        continue;
      }
      const text = await fetchPage(src.url);
      if (text.length < 200) {
        console.log('  本文が短すぎるためスキップ');
        continue;
      }
      const items = await callGemini(buildPrompt(text, src.url, src.areaHint || 'kanto'));
      if (!Array.isArray(items)) {
        console.log('  応答が配列でないためスキップ');
        continue;
      }
      for (const item of items) {
        if (added >= MAX_NEW_PER_RUN) break;
        if (!validate(item)) { console.log(`  ✕ 不正データを破棄: ${item?.name ?? '?'}`); continue; }
        const key = nameKey(item.name);
        if (existingKeys.has(key)) { console.log(`  − 重複スキップ: ${item.name}`); continue; }
        db.push({
          id: slugify(item.name, item.area),
          name: item.name.trim(),
          area: item.area,
          stages: [...new Set(item.stages)],
          features: [...new Set(item.features)],
          address: String(item.address || '要問い合わせ').trim(),
          station: String(item.station || '要問い合わせ').trim(),
          ages: String(item.ages || '要問い合わせ').trim(),
          price: String(item.price || '要問い合わせ').trim(),
          description: item.description.trim().slice(0, 230),
          url: String(item.url || src.url).trim(),
          partner: false, // 有料パートナー化は人間がフォーム受付後にtrueへ変更
          addedAt: today,
        });
        existingKeys.add(key);
        added++;
        console.log(`  ✓ 追加: ${item.name} [${item.area}/${item.stages.join('+')}]`);
      }
      await sleep(4000); // 巡回先・APIへの負荷配慮
    } catch (e) {
      console.error(`  ! エラー（このソースをスキップ）: ${e.message}`);
    }
  }

  if (added > 0) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
    console.log(`\n完了: ${added}件追加（合計 ${db.length}件）`);
  } else {
    console.log('\n完了: 新規追加なし');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
