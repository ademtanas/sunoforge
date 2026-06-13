// TanasMusic / SunoForge — Cloudflare Worker (multi-endpoint)
// Endpoints:
//   POST /enhance   — text-only AI enhance (existing)
//   POST /analyze   — audio multimodal analysis (Gemini 2.5 Flash)
//   POST /prompt    — idea -> Suno production recipe (Gemini 2.5 Pro)
//   POST /lyrics    — Turkish songwriter (Gemini 2.5 Pro)
//   GET  /health    — { ok, ts }
//
// Bindings: MEDIA_CACHE (KV, sha256 -> analysis JSON), RATELIMIT (KV, IP daily counters)
// Secrets:  GEMINI_API_KEY (required), ANTHROPIC_API_KEY, OPENAI_API_KEY (optional)

const DAILY_LIMITS = { enhance: 30, analyze: 15, prompt: 30, lyrics: 20 };
const ALLOWED_ORIGINS = [
  "https://ademtanas.github.io",
  "https://sunoforge.pages.dev",
  "https://tanasmusic.web.app",
  "https://tanasmusic.firebaseapp.com",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:8080"
];
const MAX_AUDIO_BASE64 = 28_000_000; // ~20 MB after base64 expansion
const GEMINI_FLASH = "gemini-2.5-flash";
const GEMINI_PRO   = "gemini-2.5-pro";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const GPT_MODEL    = "gpt-4o-mini";

const TURKISH_EXPERTISE = `You have deep specialization in Turkish music traditions: Arabesk (Klasik, Modern, Arabesk Pop, Fantezi, Arabesk Rap), Türk Sanat Müziği (TSM, makam-based), Türk Halk Müziği (Karadeniz, Ege, İç Anadolu, Doğu Anadolu, Trakya regions, Halay, Zeybek, Uzun Hava), Anadolu Rock (70s and modern, psychedelic), Fantezi, Özgün Müzik, Tasavvuf Müziği. You know 28 makams (Rast, Uşşak, Hüzzam, Hicaz, Hüseyni, Saba, Buselik, Nihavend, Kürdilihicazkar, Acemkürdî, Şehnaz, Beyati, etc.), Anatolian aksak meters (5/8, 7/8, 9/8 zeybek, 10/8, 12/8 shuffle), and Turkish instruments (bağlama/saz acoustic and fuzz electric, ud, ney, kanun, kemençe, zurna, darbuka, bendir, davul, asma davul, kaval, cura). For Arabesk you recognize emotional vocal register, Arabesk strings, darbuka + riq, lyrical melancholy, slow ballad form. For Anadolu Rock you recognize fuzz baglama, psychedelic phaser, analog tape saturation, 70s production. For Türk Pop you recognize the 90s sound vs modern electro production.`;

const NO_CLICHE_RULE = `CRITICAL: NEVER use generic templates like "commercial radio-ready", "wide stereo mix", "polished modern mainstream", or boilerplate. Production style MUST be derived from the actual genre and what is heard/intended — examples: "analog tape saturation, 70s Anatolian rock with phaser-drenched fuzz baglama", "Arabesk strings drenched in plate reverb with intimate vocal close-mic", "modern reggaeton dembow groove with 808 sub and tight hi-hats", "lo-fi cassette warmth with sidechained Rhodes". Be specific, never generic.`;

const ANALYSIS_SCHEMA = `{
  "genre": "main genre (Turkish names when applicable: Arabesk, Türk Pop, Anadolu Rock, TSM, THM, Fantezi, Tasavvuf)",
  "sub_genre": "specific sub-genre or fusion",
  "bpm": 0,
  "time_signature": "4/4 or 7/8 aksak or 9/8 aksak zeybek etc",
  "key": "musical key or 'Hicaz makam' / 'Hüseyni makam' if Turkish modal",
  "mood": "primary emotional tone (one word)",
  "harmony": "Major/Minor/Modal (maqam-based)/Pentatonic/Harmonic minor/Blues",
  "instruments": {"lead":"","accompaniment":"","bass":"","percussion":""},
  "vocal_dna": {"type":"","register":"","timbre":"","technique":"","effects":"","emotion":""},
  "structure": [{"section":"Intro","start":"0:00","duration":8,"energy":"low"}],
  "hook": {"description":"","location":""},
  "production_style": "DESCRIPTIVE production aesthetic (NEVER generic radio-ready)",
  "mix_character": "Warm/Bright/Dark/Balanced",
  "suno_prompt": "ready Suno-style prompt in English, under 600 chars, derived from analysis, no clichés",
  "remix_ideas": ["3 short reinterpretation directions"],
  "user_note": "short Turkish note for the user about distinctive elements"
}`;

const PROMPT_SCHEMA = `{
  "interpretation": "Turkish: what you understood from the user's idea",
  "genre": "", "sub_genre": "", "bpm": 0, "time_signature": "", "key": "",
  "mood": "", "harmony": "",
  "instruments": {"lead":"","accompaniment":"","bass":"","percussion":""},
  "vocal_dna": {"type":"","register":"","timbre":"","technique":"","effects":""},
  "structure": ["Intro","Verse 1","Chorus","Verse 2","Chorus","Bridge","Chorus","Outro"],
  "mix_character": "",
  "production_style": "specific to genre, no generic templates",
  "suno_prompt": "ready Suno English prompt under 600 chars"
}`;

function corsFor(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function safeJson(text) {
  const clean = String(text || "").replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON bulunamadı");
  return JSON.parse(clean.slice(start, end + 1));
}

async function checkRate(env, ip, endpoint) {
  if (!env.RATELIMIT) return { allowed: true, increment: async () => {} };
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${endpoint}:${ip}:${day}`;
  const used = parseInt((await env.RATELIMIT.get(key)) || "0", 10);
  const max = DAILY_LIMITS[endpoint] ?? 20;
  if (used >= max) return { allowed: false, increment: async () => {} };
  return {
    allowed: true,
    increment: async () => {
      await env.RATELIMIT.put(key, String(used + 1), { expirationTtl: 90000 });
    }
  };
}

async function callGemini(env, model, system, parts, maxTokens, jsonMode) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: "application/json" } : {})
        }
      })
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gemini ${r.status} ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  if (d.promptFeedback?.blockReason) {
    throw new Error(`Gemini içeriği engelledi: ${d.promptFeedback.blockReason}`);
  }
  const cand = d.candidates?.[0];
  if (!cand) {
    throw new Error("Gemini boş cevap döndü (candidate yok)");
  }
  const text = (cand.content?.parts || []).map(p => p.text || "").join("");
  if (!text.trim()) {
    const reason = cand.finishReason || "UNKNOWN";
    if (reason === "MAX_TOKENS") throw new Error("Gemini cevabı token sınırına takıldı");
    if (reason === "SAFETY") throw new Error("Gemini güvenlik filtresine takıldı");
    if (reason === "RECITATION") throw new Error("Gemini telif filtresine takıldı");
    throw new Error(`Gemini boş cevap (finishReason: ${reason})`);
  }
  return text;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "*";
    const cors = corsFor(origin);
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { ...cors, "Content-Type": "application/json" }
    });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const pathname = new URL(req.url).pathname;
    const ip = req.headers.get("CF-Connecting-IP") || "anon";

    // GET /health
    if (req.method === "GET" && pathname.endsWith("/health")) {
      return json({ ok: true, ts: Date.now(), endpoints: ["/enhance","/analyze","/prompt","/lyrics"] });
    }

    if (req.method !== "POST") return new Response("Not found", { status: 404, headers: cors });

    // POST /analyze — audio multimodal
    if (pathname.endsWith("/analyze")) {
      const rate = await checkRate(env, ip, "analyze");
      if (!rate.allowed) return json({ error: "Günlük analiz hakkınız doldu (15/gün). Yarın tekrar deneyin." }, 429);

      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const audio = body.audio;
      const mime = body.mime || "audio/mpeg";
      if (!audio) return json({ error: "audio gerekli (base64 string)" }, 400);
      if (audio.length > MAX_AUDIO_BASE64) return json({ error: "Dosya 20MB'ı aşıyor" }, 413);
      if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 501);

      const sha = body.sha256;
      if (sha && env.MEDIA_CACHE) {
        const cached = await env.MEDIA_CACHE.get(`an:${sha}`);
        if (cached) {
          try {
            const obj = JSON.parse(cached);
            return json({ ...obj, cached: true });
          } catch (_) { /* fallthrough */ }
        }
      }

      const system = `You are a senior music producer and ethnomusicologist. ${TURKISH_EXPERTISE}\n\n${NO_CLICHE_RULE}\n\nAnalyze the audio. Return ONLY valid JSON matching the schema. NO prose, NO markdown. Every string MUST be a valid JSON string — escape any inner quotes as \\". Never include literal newlines inside string values.`;
      try {
        const text = await callGemini(
          env, GEMINI_FLASH, system,
          [
            { text: `Analyze this track. Return ONLY JSON with this schema:\n${ANALYSIS_SCHEMA}\n\nIMPORTANT: Keep structure array to at most 8 sections. Keep all string fields concise.` },
            { inlineData: { mimeType: mime, data: audio } }
          ],
          8000, true
        );
        let dna;
        try { dna = safeJson(text); }
        catch (parseErr) {
          console.error("safeJson fail; raw first 1500:", String(text).slice(0, 1500));
          console.error("raw last 500:", String(text).slice(-500));
          throw new Error("AI cevabı parse edilemedi (büyük ihtimal Gemini cevabı kesildi veya bozuk karakter içeriyor). Tekrar deneyin veya daha kısa bir parça yükleyin.");
        }
        if (sha && env.MEDIA_CACHE) {
          await env.MEDIA_CACHE.put(`an:${sha}`, JSON.stringify(dna), { expirationTtl: 60 * 60 * 24 * 30 });
        }
        await rate.increment();
        return json({ ...dna, cached: false });
      } catch (e) {
        return json({ error: "Analiz başarısız: " + String(e.message || e).slice(0, 200) }, 502);
      }
    }

    // POST /prompt — idea -> Suno recipe
    if (pathname.endsWith("/prompt")) {
      const rate = await checkRate(env, ip, "prompt");
      if (!rate.allowed) return json({ error: "Günlük prompt hakkınız doldu (30/gün)." }, 429);

      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const idea = (body.idea || "").trim();
      if (!idea) return json({ error: "Bir fikir girin (örn. 'yağmurlu gecede ayrılık, arabesk, erkek vokal')" }, 400);
      if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 501);

      const system = `You are an expert Suno prompt engineer. ${TURKISH_EXPERTISE}\n\n${NO_CLICHE_RULE}\n\nGiven a user idea (Turkish or English), produce a Suno production recipe as STRICT JSON only. Be musical and specific to the chosen genre.`;
      try {
        const text = await callGemini(
          env, GEMINI_FLASH, system,
          [{ text: `User idea: ${idea.slice(0, 800)}\n\nReturn ONLY JSON matching this schema:\n${PROMPT_SCHEMA}` }],
          2000, true
        );
        const parsed = safeJson(text);
        await rate.increment();
        return json(parsed);
      } catch (e) {
        return json({ error: "Prompt üretimi başarısız: " + String(e.message || e).slice(0, 200) }, 502);
      }
    }

    // POST /lyrics — Turkish songwriter
    if (pathname.endsWith("/lyrics")) {
      const rate = await checkRate(env, ip, "lyrics");
      if (!rate.allowed) return json({ error: "Günlük söz hakkınız doldu (20/gün)." }, 429);

      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const theme = (body.theme || "").trim();
      const mood = body.mood || "";
      const genre = body.genre || "";
      const language = body.language || "Türkçe";
      const structure = body.structure || "Intro, Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus, Outro";
      const rhyme = body.rhyme || "";
      if (!theme) return json({ error: "Tema gerekli (örn. 'yağmurlu gecede ayrılık')" }, 400);
      if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 501);

      const system = `You are a professional Turkish songwriter with deep cultural fluency (Arabesk, Anadolu Rock, Türk Pop, modern indie, Tasavvuf). Write song lyrics matching the given context. Use Suno's [Section] tag format ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro] etc). Default language is Turkish unless explicitly otherwise. Match the mood and genre. Use clear Turkish pronunciation (avoid hard consonant clusters). Include a memorable hook in the chorus. Output ONLY the lyrics text, NO explanation, NO markdown — start with the first [Section] tag.`;

      const userMsg =
        `Theme: ${theme.slice(0, 400)}\n` +
        `Mood: ${mood}\n` +
        `Genre: ${genre}\n` +
        `Language: ${language}\n` +
        `Structure (in this exact order): ${structure}\n` +
        `Rhyme: ${rhyme}\n\n` +
        `Write the song lyrics now. Start with the first [Section] tag.`;

      try {
        const text = await callGemini(env, GEMINI_FLASH, system, [{ text: userMsg }], 2000, false);
        const lyrics = String(text || "").replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
        await rate.increment();
        return json({ lyrics });
      } catch (e) {
        return json({ error: "Söz üretimi başarısız: " + String(e.message || e).slice(0, 200) }, 502);
      }
    }

    // POST /enhance — text-only AI enhance (existing)
    if (pathname.endsWith("/enhance")) {
      const rate = await checkRate(env, ip, "enhance");
      if (!rate.allowed) return json({ error: "Günlük AI hakkı doldu (30/gün)" }, 429);

      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const prompt = (body.prompt || "").slice(0, 4000);
      const userSys = (body.system || "").slice(0, 4000);
      const provider = ["gemini","claude","gpt"].includes(body.provider) ? body.provider : "gemini";
      if (!prompt) return json({ error: "empty" }, 400);

      try {
        let text = "";
        const combined = TURKISH_EXPERTISE + "\n\n" + userSys;
        if (provider === "gemini") {
          if (!env.GEMINI_API_KEY) return json({ error: "not configured" }, 501);
          text = await callGemini(env, GEMINI_FLASH, combined, [{ text: prompt }], 2000, false);
        } else if (provider === "claude") {
          if (!env.ANTHROPIC_API_KEY) return json({ error: "not configured" }, 501);
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, system: combined, messages: [{ role: "user", content: prompt }] })
          });
          if (!r.ok) throw new Error("claude " + r.status);
          const d = await r.json();
          text = (d.content || []).map(c => c.text || "").join("");
        } else {
          if (!env.OPENAI_API_KEY) return json({ error: "not configured" }, 501);
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.OPENAI_API_KEY },
            body: JSON.stringify({ model: GPT_MODEL, max_tokens: 2000, messages: [{ role: "system", content: combined }, { role: "user", content: prompt }] })
          });
          if (!r.ok) throw new Error("gpt " + r.status);
          const d = await r.json();
          text = d.choices?.[0]?.message?.content || "";
        }
        const out = text.trim();
        await rate.increment();
        return json({ text: out });
      } catch (e) {
        return json({ error: "upstream", detail: String(e.message || e).slice(0, 200) }, 502);
      }
    }

    return new Response("Not found", { status: 404, headers: cors });
  }
};
