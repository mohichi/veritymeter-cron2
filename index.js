// veritymeter-cron2 Worker
// 朝日・読売・日経・東洋経済・文春・新潮の6媒体を3個のCronで処理。
// 1回のCronで2媒体を順番に処理（30秒待機を挟む）。
// アカウント全体のCron上限（5個）の制約により、veritymeter-cronと合わせて2+3=5個の配分。

const MEDIA_PAIRS = [
  // Cron1: 朝日・読売
  [
    { id: "asahi", name: "朝日新聞デジタル", domain: "asahi.com" },
    { id: "yomiuri", name: "読売新聞オンライン", domain: "yomiuri.co.jp" },
  ],
  // Cron2: 日経・東洋経済
  [
    { id: "nikkei", name: "日本経済新聞", domain: "nikkei.com" },
    { id: "toyokeizai", name: "東洋経済オンライン", domain: "toyokeizai.net" },
  ],
  // Cron3: 文春・新潮
  [
    { id: "bunshun", name: "週刊文春デジタル", domain: "bunshun.jp" },
    { id: "shincho", name: "デイリー新潮", domain: "dailyshincho.jp" },
  ],
];

const CRON_SCHEDULE = [
  "32 21 * * *",  // 朝日・読売    JST 6:32
  "48 21 * * *",  // 日経・東洋経済 JST 6:48
  "4 22 * * *",   // 文春・新潮    JST 7:04
];

async function fetchMediaNews(media, apiKey, retryCount = 0) {
  const systemPrompt = `あなたはニュース調査の専門AIです。指定されたメディアの本日の主要記事を必ずウェブ検索で見つけてJSONのみで返答してください。最初の文字は必ず「{」。コードブロックマーカー不要。

JSON形式：
{"articles":[{"title":"記事タイトル","url":"記事URL","excerpt":"1文要約(30字)","score":数値(0-100),"comment":"総評(40字)"}]}

重要：
- 必ず検索を実行して記事を見つけること。見つからないと判断する前に複数回検索すること。
- タイトルにダブルクォートやシングルクォートが含まれる場合は削除またはスペースに置換すること。
- 最大2件まで。本当に記事が見つからない場合のみ {"articles": []} を返すこと。`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: `${media.name}（サイト：${media.domain}）の最新の主要ニュース記事を検索して2件見つけてください。本日または直近の記事でお願いします。` }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      if (apiRes.status === 429 && retryCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 30000));
        return fetchMediaNews(media, apiKey, retryCount + 1);
      }
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `API error (${apiRes.status})` };
    }

    const data = await apiRes.json();
    const fullText = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const braceIdx = fullText.indexOf('{"articles"');
    const braceIdx2 = fullText.indexOf('{ "articles"');
    const startIdx = braceIdx >= 0 ? braceIdx : (braceIdx2 >= 0 ? braceIdx2 : fullText.indexOf('{'));

    let candidate = null;
    if (startIdx >= 0) {
      let depth = 0, endIdx = -1;
      for (let i = startIdx; i < fullText.length; i++) {
        if (fullText[i] === '{') depth++;
        else if (fullText[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx >= 0) candidate = fullText.slice(startIdx, endIdx + 1);
    }
    if (!candidate) {
      let clean = fullText.replace(/```json[\r\n]*/gi, "").replace(/```[\r\n]*/g, "").trim();
      const matches = clean.match(/\{[\s\S]*\}/g);
      candidate = matches && matches.length ? matches[matches.length - 1] : clean;
    }

    // シングルクォートで囲まれた値をダブルクォートに修正
    candidate = candidate.replace(/:\s*'([^']*)'/g, ': "$1"');

    let parsed;
    try {
      if (!candidate || candidate.trim().length === 0) throw new Error("empty");
      parsed = JSON.parse(candidate);
    } catch (e) {
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `JSON解析失敗: ${fullText.slice(0, 200)}` };
    }

    return { mediaId: media.id, mediaName: media.name, articles: (parsed.articles || []).slice(0, 2), error: false };
  } catch (e) {
    return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: String(e) };
  }
}

async function updateOneMedia(env, media) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
  if (!env.NEWS_KV) return { ok: false, error: "NEWS_KV binding is not set" };

  const today = new Date().toISOString().slice(0, 10);
  const result = await fetchMediaNews(media, apiKey);

  const existingRaw = await env.NEWS_KV.get("latest");
  let payload;
  try { payload = existingRaw ? JSON.parse(existingRaw) : null; } catch (e) { payload = null; }

  if (!payload || payload.date !== today) {
    payload = { updatedAt: new Date().toISOString(), date: today, media: [] };
  }

  const idx = payload.media.findIndex(m => m.mediaId === media.id);
  if (idx >= 0) payload.media[idx] = result;
  else payload.media.push(result);
  payload.updatedAt = new Date().toISOString();

  await env.NEWS_KV.put("latest", JSON.stringify(payload));
  await env.NEWS_KV.put(`archive:${today}`, JSON.stringify(payload));

  return { ok: true, date: today, mediaId: media.id, articles: result.articles.length, error: result.error };
}

export default {
  async scheduled(event, env, ctx) {
    const idx = CRON_SCHEDULE.indexOf(event.cron);
    if (idx === -1 || !MEDIA_PAIRS[idx]) {
      console.error(`Unknown cron schedule: ${event.cron}`);
      return;
    }
    const pair = MEDIA_PAIRS[idx];
    ctx.waitUntil((async () => {
      // 1媒体目
      const r1 = await updateOneMedia(env, pair[0]);
      // 30秒待機してから2媒体目
      await new Promise(resolve => setTimeout(resolve, 30000));
      const r2 = await updateOneMedia(env, pair[1]);
      await env.NEWS_KV.put("last_run_result", JSON.stringify({ cron: event.cron, results: [r1, r2] }));
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const mediaId = url.searchParams.get("media");
      if (!mediaId) {
        const allMedia = MEDIA_PAIRS.flat();
        return new Response(JSON.stringify({ error: "mediaパラメータを指定してください", availableMedia: allMedia.map(m => m.id) }, null, 2), {
          status: 400, headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const allMedia = MEDIA_PAIRS.flat();
      const media = allMedia.find(m => m.id === mediaId);
      if (!media) {
        return new Response(JSON.stringify({ error: `不明なmedia id: ${mediaId}`, availableMedia: allMedia.map(m => m.id) }, null, 2), {
          status: 400, headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const result = await updateOneMedia(env, media);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/run-pair") {
      const pairIdx = parseInt(url.searchParams.get("pair") || "0");
      if (pairIdx < 0 || pairIdx >= MEDIA_PAIRS.length) {
        return new Response(JSON.stringify({ error: "pair=0,1,2 のいずれかを指定してください" }), {
          status: 400, headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const pair = MEDIA_PAIRS[pairIdx];
      const r1 = await updateOneMedia(env, pair[0]);
      await new Promise(resolve => setTimeout(resolve, 30000));
      const r2 = await updateOneMedia(env, pair[1]);
      return new Response(JSON.stringify({ pair: pairIdx, results: [r1, r2] }, null, 2), {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/last-run") {
      const data = await env.NEWS_KV.get("last_run_result");
      return new Response(data || JSON.stringify({ message: "まだ実行結果がありません" }), {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/status") {
      const data = await env.NEWS_KV.get("latest");
      return new Response(data || "No data yet", {
        status: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const allMedia = MEDIA_PAIRS.flat();
    return new Response(
      `veritymeter-cron2\n対象媒体: ${allMedia.map(m => m.id).join(", ")}\n/run?media=asahi ... 1媒体実行\n/run-pair?pair=0 ... ペア実行(0=朝日読売, 1=日経東洋経済, 2=文春新潮)`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
