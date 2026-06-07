/**
 * 口コミ受付API（Cloudflare Pages Functions）
 * POST /api/review
 * 受け取った口コミはサイトに即時公開せず、GitHubリポジトリのIssueとして非公開ストックに保管する。
 * 10日毎のGitHub ActionsでGeminiが全口コミを解析し、公平な「AI総評」だけをページに反映する。
 *
 * 必要な環境変数（Cloudflare Pagesのプロジェクト設定で登録）:
 *   REVIEW_GITHUB_TOKEN: Issues(Read and write)権限のみのFine-grained token
 */
const REPO = 'takakionoda-spec/zenkoku-interschool';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, 400);
  }

  // honeypot（botは隠しフィールドを埋める）→ 受理したフリをして破棄
  if (data.website) return json({ ok: true });

  const classroomId = String(data.classroomId || '').trim();
  const text = String(data.text || '').trim();
  const role = String(data.role || '不明').slice(0, 30);
  const rating = Math.min(5, Math.max(1, Number(data.rating) || 3));

  if (!/^[a-z0-9-]{3,64}$/.test(classroomId)) return json({ ok: false, error: 'invalid id' }, 400);
  if (text.length < 20 || text.length > 2000) return json({ ok: false, error: 'text length' }, 400);

  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.REVIEW_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zenkoku-interschool-review-inbox',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `[review] ${classroomId}`,
      body: JSON.stringify(
        { classroomId, role, rating, text, at: new Date().toISOString() },
        null,
        2
      ),
    }),
  });

  if (!res.ok) return json({ ok: false, error: 'storage failed' }, 502);
  return json({ ok: true });
}
