/**
 * TanasMusic AI Music OS — Cloud Functions backend
 * Endpoints (mounted under /api/* via hosting rewrite):
 *   POST /api/analyze   { storagePath }                         → audio analysis JSON
 *   POST /api/prompt    { idea }                                → Suno prompt + DNA
 *   POST /api/lyrics    { theme, mood, genre, language, structure, rhyme } → Turkish lyrics
 *   GET  /api/health                                            → ok
 *
 * Models: gemini-2.5-flash (analyze) / gemini-2.5-pro (prompt+lyrics, creative)
 * Audio: read from Firebase Storage path, inline base64 to Gemini (≤18MB).
 * Rate limit: Firestore daily counter, per user (Auth uid) or IP-hash.
 * Suno prompt: genre-aware, NO generic radio-ready clichés.
 * Turkish music expertise (Arabesk, makams, Anadolu Rock, aksak) injected.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// ---------------- SETTINGS ----------------
const MODELS = { flash: "gemini-2.5-flash", pro: "gemini-2.5-pro" };
const DAILY_LIMITS = { analyze: 5, prompt: 20, lyrics: 10 };
const MAX_AUDIO_MB = 18;
const ALLOWED_ORIGINS = [
  "https://tanasmusic.web.app",
  "https://tanasmusic.firebaseapp.com",
  "https://sunoforge.pages.dev",
  "https://ademtanas.github.io",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:8080"
];

// ---------------- EXPRESS ----------------
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "1mb" })); // small body — audio uploaded to Storage separately

const router = express.Router();

// ---------------- HELPERS ----------------
let genAI = null;
function gen() {
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  return genAI;
}

/** Strip markdown fences and safely parse JSON. Throws if no { ... } found. */
function safeJson(text) {
  const clean = String(text || "").replace(/```json|```/gi, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON bulunamadı (AI cevabı geçersiz format)");
  return JSON.parse(clean.slice(start, end + 1));
}

/** Identify caller: Auth bearer → uid; otherwise IP-hash. */
async function identify(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) {
    try {
      const dec = await admin.auth().verifyIdToken(h.slice(7));
      return { id: "u:" + dec.uid, isAuth: true };
    } catch (_) {
      /* invalid token → treat as guest */
    }
  }
  const ip = (req.headers["x-forwarded-for"] || "anon").split(",")[0].trim();
  const hashed = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
  return { id: "ip:" + hashed, isAuth: false };
}

/** Firestore-backed daily rate limit. Returns true if allowed. */
async function rateLimit(id, endpoint) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("rateLimits").doc(`${id}_${endpoint}_${day}`);
  const max = DAILY_LIMITS[endpoint] ?? 20;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const used = snap.exists ? (snap.data().count || 0) : 0;
    if (used >= max) return false;
    tx.set(
      ref,
      { count: used + 1, lastAt: Date.now(), endpoint, id },
      { merge: true }
    );
    return true;
  });
}

async function callGemini(parts, model = "flash", systemInstruction, opts = {}) {
  const instance = gen().getGenerativeModel({
    model: MODELS[model] || MODELS.flash,
    systemInstruction: systemInstruction || undefined,
    generationConfig: {
      maxOutputTokens: opts.maxTokens || 2000,
      ...(opts.json ? { responseMimeType: "application/json" } : {})
    }
  });
  const result = await instance.generateContent(parts);
  return result.response.text();
}

// ---------------- SYSTEM PROMPTS ----------------
const TURKISH_EXPERTISE = `You have deep specialization in Turkish music traditions: Arabesk (Klasik, Modern, Arabesk Pop, Fantezi, Arabesk Rap), Türk Sanat Müziği (TSM, makam-based), Türk Halk Müziği (Karadeniz, Ege, İç Anadolu, Doğu Anadolu, Trakya regions, Halay, Zeybek, Uzun Hava), Anadolu Rock (70s and modern, psychedelic), Fantezi, Özgün Müzik, Tasavvuf Müziği. You know 28 makams (Rast, Uşşak, Hüzzam, Hicaz, Hüseyni, Saba, Buselik, Nihavend, Kürdilihicazkar, Acemkürdî, Şehnaz, Beyati, etc.), Anatolian aksak meters (5/8, 7/8, 9/8 zeybek, 10/8, 12/8 shuffle), and Turkish instruments (bağlama/saz both acoustic and fuzz electric, ud, ney, kanun, kemençe, zurna, darbuka, bendir, davul, asma davul, kaval, cura). For Arabesk you recognize emotional vocal register, Arabesk strings, darbuka + riq, lyrical melancholy, slow ballad form. For Anadolu Rock you recognize fuzz baglama, psychedelic phaser, analog tape saturation, 70s production. For Türk Pop you recognize the 90s sound vs modern electro production. Identify these traits accurately when present.`;

const NO_CLICHE_RULE = `CRITICAL: NEVER use generic production templates like "commercial radio-ready", "wide stereo mix", "polished modern mainstream", or any boilerplate. The production style MUST be derived from the actual genre and what is heard/intended (e.g. "analog tape saturation, 70s Anatolian rock with phaser-drenched fuzz baglama", "Arabesk strings drenched in plate reverb, intimate vocal close-mic", "modern reggaeton dembow groove with 808 sub and tight hi-hats", "lo-fi cassette warmth with sidechained Rhodes").`;

const ANALYSIS_SYSTEM = `You are a senior music producer and ethnomusicologist. ${TURKISH_EXPERTISE}\n\n${NO_CLICHE_RULE}\n\nAnalyze the audio you receive. Return ONLY a valid JSON object — no prose, no markdown fences, no apologies. Match the schema exactly.`;

const ANALYSIS_SCHEMA = `{
  "genre": "main genre (use Turkish names when applicable: Arabesk, Türk Pop, Anadolu Rock, TSM, THM, Fantezi, Tasavvuf)",
  "sub_genre": "specific sub-genre or fusion",
  "bpm": 0,
  "time_signature": "4/4 or 7/8 aksak or 9/8 aksak zeybek etc",
  "key": "musical key or 'Hicaz makam' / 'Hüseyni makam' if Turkish modal",
  "mood": "primary emotional tone (one word)",
  "harmony": "Major/Minor/Modal (maqam-based)/Pentatonic/Harmonic minor/Blues",
  "instruments": {
    "lead": "specific lead instrument with playing style",
    "accompaniment": "accompaniment description",
    "bass": "bass description",
    "percussion": "percussion details — kit, darbuka, bendir, drum machine, etc."
  },
  "vocal_dna": {
    "type": "Male vocal / Female vocal / Duet / Child vocal / Choir / Instrumental, no vocals",
    "register": "Soprano/Mezzo-soprano/Alto/Tenor/Baritone/Bass or empty",
    "timbre": "Clear/Husky/Breathy/Warm and smoky/Gravelly/Rich",
    "technique": "Belt/Mixed voice/Maqam taksim/Melodic rap/Spoken/Chest voice",
    "effects": "Hall reverb/Plate reverb/Dry/Doubled vocals/Auto-tune",
    "emotion": "emotional character"
  },
  "structure": [
    {"section":"Intro","start":"0:00","duration":8,"energy":"low"},
    {"section":"Verse 1","start":"0:08","duration":16,"energy":"medium"},
    {"section":"Chorus","start":"0:24","duration":16,"energy":"high"}
  ],
  "hook": {
    "description": "short description of the catchiest/most memorable element",
    "location": "where it appears (e.g. Chorus, 1:12)"
  },
  "production_style": "DESCRIPTIVE production aesthetic derived from what you actually hear (NOT a generic 'commercial / radio-ready' label)",
  "mix_character": "Warm/Bright/Dark/Balanced mixing",
  "suno_prompt": "ready Suno-style prompt in English, under 600 characters, no lyrics, includes genre + tempo + mood + key instruments + vocal description + production style — derived from analysis, no clichés",
  "remix_ideas": [
    "3 short directions to reinterpret this style"
  ],
  "user_note": "short Turkish note for the user about distinctive elements"
}`;

const PROMPT_SYSTEM = `You are an expert Suno prompt engineer. ${TURKISH_EXPERTISE}\n\n${NO_CLICHE_RULE}\n\nGiven a user idea (Turkish or English), produce a complete Suno production recipe as STRICT JSON only. Production style MUST be derived from the genre/mood/idea — never a generic template. For Arabesk → emotional Arabesk strings, darbuka and riq, slow lament tempo. For Anadolu Rock → fuzz baglama, analog tape, 70s aesthetic, aksak meters. For Reggaeton → dembow groove, 808, sharp hi-hats. Be specific and musical.`;

const PROMPT_SCHEMA = `{
  "interpretation": "what you understood from the user's idea, in Turkish",
  "genre": "",
  "sub_genre": "",
  "bpm": 0,
  "time_signature": "",
  "key": "",
  "mood": "",
  "harmony": "",
  "instruments": { "lead": "", "accompaniment": "", "bass": "", "percussion": "" },
  "vocal_dna": { "type": "", "register": "", "timbre": "", "technique": "", "effects": "" },
  "structure": ["Intro","Verse 1","Chorus","Verse 2","Chorus","Bridge","Chorus","Outro"],
  "production_style": "specific to genre, NO 'commercial radio-ready' templates",
  "suno_prompt": "ready Suno prompt in English under 600 chars"
}`;

const LYRICS_SYSTEM = `You are a professional Turkish songwriter with deep cultural fluency (Arabesk, Anadolu Rock, Türk Pop, modern indie). Write song lyrics matching the given context. Use Suno's [Section] tag format ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro] etc). Default language is Turkish unless explicitly otherwise. Respect the requested structure order. Match mood and genre tonality. Use clear Turkish pronunciation (avoid hard-to-sing consonant clusters where possible). Include a memorable hook in the chorus. Output ONLY the lyrics text, no explanation, no markdown, starting with the first [Section] tag.`;

// ---------------- ENDPOINTS ----------------

router.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now(), models: MODELS });
});

router.post("/analyze", async (req, res) => {
  try {
    const who = await identify(req);
    if (!(await rateLimit(who.id, "analyze"))) {
      return res.status(429).json({ error: "Günlük analiz hakkınız doldu (5/gün). Yarın tekrar deneyin." });
    }

    const { storagePath } = req.body || {};
    if (!storagePath || typeof storagePath !== "string") {
      return res.status(400).json({ error: "storagePath gerekli" });
    }
    if (!storagePath.startsWith("uploads/")) {
      return res.status(400).json({ error: "Geçersiz dosya yolu (uploads/ altında olmalı)" });
    }

    const file = bucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: "Yüklenen dosya bulunamadı" });

    const [meta] = await file.getMetadata();
    const sizeMB = Number(meta.size || 0) / (1024 * 1024);
    if (sizeMB > MAX_AUDIO_MB) {
      return res.status(413).json({ error: `Dosya ${MAX_AUDIO_MB}MB'ı aşıyor` });
    }
    const mime = meta.contentType || "audio/mpeg";
    if (!mime.startsWith("audio/")) {
      return res.status(400).json({ error: "Sadece ses dosyaları analiz edilebilir" });
    }

    // Cache: client provides SHA256 in custom metadata
    const sha = meta.metadata && meta.metadata.sha256;
    if (sha) {
      const cachedSnap = await db.collection("analyses").doc(sha).get();
      if (cachedSnap.exists) {
        return res.json({ ...cachedSnap.data(), cached: true });
      }
    }

    const [buf] = await file.download();
    const text = await callGemini(
      [
        { inlineData: { mimeType: mime, data: buf.toString("base64") } },
        { text: "Analyze this track. Return ONLY JSON matching the schema below.\n\nSchema:\n" + ANALYSIS_SCHEMA }
      ],
      "flash",
      ANALYSIS_SYSTEM,
      { maxTokens: 2500, json: true }
    );
    const dna = safeJson(text);

    if (sha) {
      await db.collection("analyses").doc(sha).set({ ...dna, createdAt: Date.now() });
    }
    res.json({ ...dna, cached: false });
  } catch (e) {
    console.error("[analyze]", e);
    res.status(500).json({ error: "Analiz başarısız: " + (e.message || "sunucu hatası") });
  }
});

router.post("/prompt", async (req, res) => {
  try {
    const who = await identify(req);
    if (!(await rateLimit(who.id, "prompt"))) {
      return res.status(429).json({ error: "Günlük prompt hakkınız doldu (20/gün)." });
    }

    const { idea } = req.body || {};
    if (!idea || typeof idea !== "string" || !idea.trim()) {
      return res.status(400).json({ error: "Bir fikir girin (örn. 'yağmurlu gecede ayrılık, arabesk, erkek vokal')" });
    }

    const text = await callGemini(
      [{ text: `User idea (Turkish/English): ${idea.slice(0, 800)}\n\nReturn ONLY JSON matching the schema:\n${PROMPT_SCHEMA}` }],
      "pro",
      PROMPT_SYSTEM,
      { maxTokens: 2000, json: true }
    );
    const out = safeJson(text);
    res.json(out);
  } catch (e) {
    console.error("[prompt]", e);
    res.status(500).json({ error: "Prompt üretimi başarısız: " + (e.message || "sunucu hatası") });
  }
});

router.post("/lyrics", async (req, res) => {
  try {
    const who = await identify(req);
    if (!(await rateLimit(who.id, "lyrics"))) {
      return res.status(429).json({ error: "Günlük söz hakkınız doldu (10/gün)." });
    }

    const {
      theme = "",
      mood = "",
      genre = "",
      language = "Türkçe",
      structure = "Intro, Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus, Outro",
      rhyme = ""
    } = req.body || {};

    if (!String(theme).trim()) {
      return res.status(400).json({ error: "Tema gerekli (örn. 'yağmurlu gecede ayrılık')" });
    }

    const userMsg =
      `Theme: ${String(theme).slice(0, 400)}\n` +
      `Mood: ${mood}\n` +
      `Genre: ${genre}\n` +
      `Language: ${language}\n` +
      `Structure (in this exact order): ${structure}\n` +
      `Rhyme preference: ${rhyme}\n\n` +
      `Write the song lyrics now. Start with the first [Section] tag. NO prose, NO explanation.`;

    const text = await callGemini(
      [{ text: userMsg }],
      "pro",
      LYRICS_SYSTEM,
      { maxTokens: 2000, json: false }
    );
    const lyrics = String(text || "").replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    res.json({ lyrics });
  } catch (e) {
    console.error("[lyrics]", e);
    res.status(500).json({ error: "Söz üretimi başarısız: " + (e.message || "sunucu hatası") });
  }
});

app.use("/api", router);

exports.api = onRequest(
  {
    secrets: [GEMINI_API_KEY],
    region: "europe-west1",
    memory: "512MiB",
    timeoutSeconds: 60,
    cors: ALLOWED_ORIGINS
  },
  app
);
