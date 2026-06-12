// SunoForge AI Proxy — Cloudflare Worker (çoklu model)
// Secrets (sadece eklediklerin aktif olur):
//   GEMINI_API_KEY    -> aistudio.google.com/apikey (ÜCRETSİZ katman var, önerilen)
//   ANTHROPIC_API_KEY -> console.anthropic.com (ücretli)
//   OPENAI_API_KEY    -> platform.openai.com (ücretli)
// Opsiyonel KV binding: RATELIMIT

const DAILY_LIMIT = 20;
const ALLOWED_ORIGINS = ["https://ademtanas.github.io"];
const MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-sonnet-4-20250514",
  gpt:    "gpt-4o-mini",
};

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "*";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes("*") ? "*" :
        (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/enhance"))
      return new Response("Not found", { status: 404, headers: cors });

    if (env.RATELIMIT) {
      const ip = req.headers.get("CF-Connecting-IP") || "anon";
      const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
      const used = parseInt((await env.RATELIMIT.get(key)) || "0");
      if (used >= DAILY_LIMIT) return json({ error: "daily limit" }, 429);
      await env.RATELIMIT.put(key, String(used + 1), { expirationTtl: 90000 });
    }

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const prompt = (body.prompt || "").slice(0, 4000);
    const system = (body.system || "").slice(0, 4000);
    const provider = MODELS[body.provider] ? body.provider : "gemini";
    if (!prompt) return json({ error: "empty" }, 400);

    try {
      let text = "";
      if (provider === "gemini") {
        if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 501);
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent?key=${env.GEMINI_API_KEY}`,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 600 },
            }) });
        if (!r.ok) throw new Error("gemini " + r.status);
        const d = await r.json();
        text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      } else if (provider === "claude") {
        if (!env.ANTHROPIC_API_KEY) return json({ error: "not configured" }, 501);
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: MODELS.claude, max_tokens: 600, system,
            messages: [{ role: "user", content: prompt }] }) });
        if (!r.ok) throw new Error("claude " + r.status);
        const d = await r.json();
        text = (d.content || []).map(c => c.text || "").join("");
      } else { // gpt
        if (!env.OPENAI_API_KEY) return json({ error: "not configured" }, 501);
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.OPENAI_API_KEY },
          body: JSON.stringify({ model: MODELS.gpt, max_tokens: 600,
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
        if (!r.ok) throw new Error("gpt " + r.status);
        const d = await r.json();
        text = d.choices?.[0]?.message?.content || "";
      }
      return json({ text: text.trim() });
    } catch (e) {
      return json({ error: "upstream", detail: String(e).slice(0, 200) }, 502);
    }
  },
};
