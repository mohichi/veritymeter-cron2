// veritymeter-cron2 Worker（東洋経済・文春・新潮担当）
// Cron Triggerが「1回につき1媒体」を担当する設計に変更。
// Anthropic APIのレート制限（1分あたり入力トークン数）に対し、
// 複数媒体をまとめて処理すると確実に抵触するため、Cron自体を媒体数ぶん用意し、
// 時間をずらして1媒体ずつ実行する。
//
// KVのbinding名は "NEWS_KV"、環境変数は "ANTHROPIC_API_KEY" を使用する想定。
//
// 各Cronの実行時刻と対象媒体の対応は、wrangler.toml の crons 配列の並び順と
// 下記 MEDIA_LIST の並び順を一致させることで決めている（インデックスで対応付け）。

const MEDIA_LIST = [
  { id: "toyokeizai", name: "東洋経済オンライン", domain: "toyokeizai.net" },
  { id: "bunshun", name: "週刊文春デジタル", domain: "bunshun.jp" },
  { id: "shincho", name: "デイリー新潮", domain: "dailyshincho.jp" },
];

// wrangler.toml の crons 配列と同じ並び順（時刻順）。
// scheduled() が呼ばれたとき、event.cron の値からこの配列内の位置を特定し、対応するメディアを処理する。
const CRON_SCHEDULE = [
  "40 21 * * *",  // toyokeizai
  "48 21 * * *",  // bunshun
  "56 21 * * *",  // shincho
];

async function fetchMediaNews(media, apiKey, retryCount = 0) {
  const systemPrompt = `あなたはニュース調査・信憑性診断の専門AIです。
Web検索を使って、「${media.name}」（ドメイン: ${media.domain}）が本日掲載している主要記事を調査してください。

手順：
1. "${media.domain}" のサイトで本日報じられている主要なニュース記事を、検索を使って最大2件見つける
2. 見つかった各記事について、タイトル・URL・簡潔な要約・信憑性スコアを判定する
3. 必ずJSON形式のみで返答する。コードブロックマーカーは絶対に使わないこと。余計な前置きや説明も不要。最初の文字は必ず「{」であること。

JSON形式：
{
  "articles": [
    {
      "title": "記事タイトル",
      "url": "記事の実際のURL",
      "excerpt": "記事内容の1文要約（30文字程度）",
      "score": 数値(0-100、記事内容の信憑性スコア),
      "comment": "簡潔な総評（1文、40文字程度）"
    }
  ]
}

スコア基準：
- 80-100：根拠が明確、一次情報や事実報道が中心
- 60-79：概ね妥当
- 40-59：事実と意見・憶測が混在
- 20-39：根拠が薄い、誇張・扇情的な見出しが目立つ
- 0-19：信憑性に重大な問題

記事が見つからない、またはアクセスできない場合は {"articles": []} を返してください。
最大2件まで、実際に確認できた記事のみを含めてください。`;

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
        messages: [
          { role: "user", content: `${media.name}（${media.domain}）の本日の主要記事を調査してください。` },
        ],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      if (apiRes.status === 429 && retryCount < 2) {
        await new Promise(resolve => setTimeout(resolve, 30000));
        return fetchMediaNews(media, apiKey, retryCount + 1);
      }
      console.error(`API error for ${media.id}:`, errText);
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `API error (${apiRes.status}): ${errText.slice(0, 300)}` };
    }

    const data = await apiRes.json();
    const fullText = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // {から始まる部分だけを直接抽出（最も確実な方法）
    const braceStart = fullText.indexOf('{"articles"');
    const braceStart2 = fullText.indexOf('{ "articles"');
    const startIdx = braceStart >= 0 ? braceStart : (braceStart2 >= 0 ? braceStart2 : fullText.indexOf('{'));
    
    let candidate = null;
    if (startIdx >= 0) {
      // 対応する閉じ括弧を探す
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < fullText.length; i++) {
        if (fullText[i] === '{') depth++;
        else if (fullText[i] === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        }
      }
      if (endIdx >= 0) {
        candidate = fullText.slice(startIdx, endIdx + 1);
      }
    }
    
    if (!candidate) {
      // フォールバック：コードブロック除去してから抽出
      let clean = fullText.replace(/```json[\r\n]*/gi, "").replace(/```[\r\n]*/g, "").trim();
      const matches = clean.match(/\{[\s\S]*\}/g);
      candidate = matches && matches.length ? matches[matches.length - 1] : clean;
    }

    let parsed;
    try {
      if (!candidate || candidate.trim().length === 0) {
        throw new Error("empty response");
      }
      parsed = JSON.parse(candidate);
    } catch (e) {
      const preview = fullText && fullText.length > 0 ? fullText.slice(0, 800) : "(空のレスポンス。web検索の結果が得られなかった可能性があります)";
      console.error(`Parse error for ${media.id}:`, preview);
      return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: `JSON解析失敗: ${preview}` };
    }

    return {
      mediaId: media.id,
      mediaName: media.name,
      articles: (parsed.articles || []).slice(0, 2),
      error: false,
    };
  } catch (e) {
    console.error(`Fetch error for ${media.id}:`, e);
    return { mediaId: media.id, mediaName: media.name, articles: [], error: true, errorMessage: String(e) };
  }
}

// 1媒体分を処理し、その日のKVデータに「追記」する
async function updateOneMedia(env, media) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY is not set" };
  }
  if (!env.NEWS_KV) {
    return { ok: false, error: "NEWS_KV binding is not set" };
  }

  const today = new Date().toISOString().slice(0, 10);
  const result = await fetchMediaNews(media, apiKey);

  const existingRaw = await env.NEWS_KV.get("latest");
  let payload;
  try {
    payload = existingRaw ? JSON.parse(existingRaw) : null;
  } catch (e) {
    payload = null;
  }

  if (!payload || payload.date !== today) {
    payload = { updatedAt: new Date().toISOString(), date: today, media: [] };
  }

  const idx = payload.media.findIndex(m => m.mediaId === media.id);
  if (idx >= 0) {
    payload.media[idx] = result;
  } else {
    payload.media.push(result);
  }
  payload.updatedAt = new Date().toISOString();

  await env.NEWS_KV.put("latest", JSON.stringify(payload));
  await env.NEWS_KV.put(`archive:${today}`, JSON.stringify(payload));

  return { ok: true, date: today, mediaId: media.id, articles: result.articles.length, error: result.error, errorMessage: result.errorMessage || null };
}

export default {
  async scheduled(event, env, ctx) {
    const idx = CRON_SCHEDULE.indexOf(event.cron);
    if (idx === -1 || !MEDIA_LIST[idx]) {
      console.error(`Unknown cron schedule: ${event.cron}`);
      return;
    }
    const media = MEDIA_LIST[idx];
    ctx.waitUntil(
      updateOneMedia(env, media).then(async (result) => {
        await env.NEWS_KV.put("last_run_result", JSON.stringify(result));
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/reset") {
      // reutersなど不要な媒体を除いてKVをリセットする
      const validIds = MEDIA_LIST.map(m => m.mediaId || m.id);
      const existingRaw = await env.NEWS_KV.get("latest");
      if (existingRaw) {
        const payload = JSON.parse(existingRaw);
        payload.media = payload.media.filter(m => validIds.includes(m.mediaId));
        payload.updatedAt = new Date().toISOString();
        await env.NEWS_KV.put("latest", JSON.stringify(payload));
        return new Response(JSON.stringify({ ok: true, remaining: payload.media.map(m => m.mediaId) }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "No data found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/run") {
      const mediaId = url.searchParams.get("media");
      if (!mediaId) {
        return new Response(
          JSON.stringify({
            error: "media パラメータを指定してください。例: /run?media=nhk",
            availableMedia: MEDIA_LIST.map(m => m.id),
          }, null, 2),
          { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }
      const media = MEDIA_LIST.find(m => m.id === mediaId);
      if (!media) {
        return new Response(
          JSON.stringify({ error: `不明な media id: ${mediaId}`, availableMedia: MEDIA_LIST.map(m => m.id) }, null, 2),
          { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      const result = await updateOneMedia(env, media);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/run-all") {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey || !env.NEWS_KV) {
        return new Response(JSON.stringify({ error: "APIキーまたはKVが未設定です" }), {
          status: 500, headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      ctx.waitUntil((async () => {
        for (let i = 0; i < MEDIA_LIST.length; i++) {
          await updateOneMedia(env, MEDIA_LIST[i]);
          if (i < MEDIA_LIST.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 30000));
          }
        }
      })());
      return new Response(
        JSON.stringify({ started: true, message: "全媒体の順次実行をバックグラウンドで開始しました。完了まで5分程度かかります。/status で確認してください。" }, null, 2),
        { status: 202, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    if (url.pathname === "/last-run") {
      const data = await env.NEWS_KV.get("last_run_result");
      return new Response(data || JSON.stringify({ message: "まだ実行結果がありません" }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/status") {
      const data = await env.NEWS_KV.get("latest");
      return new Response(data || "No data yet", {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/envcheck") {
      const keys = Object.keys(env);
      const info = keys.map(k => {
        const v = env[k];
        const type = typeof v;
        return { key: k, type, hasValue: !!v, length: (type === 'string' ? v.length : null) };
      });
      return new Response(JSON.stringify({ envKeys: info }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response(
      `veritymeter-cron worker.\n使い方:\n  /run?media=nhk  ... 1媒体だけ即時実行\n  /run-all        ... 全媒体を順次バックグラウンド実行\n  /status         ... 保存済みデータの確認\n  /last-run       ... 直近のCron実行結果\n  /envcheck       ... 環境変数の設定確認\n\n対象媒体: ${MEDIA_LIST.map(m => m.id).join(", ")}`,
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  },
};
