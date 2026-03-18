/**
 * PostFlow AI — WhatsApp Bot + AI Proxy
 * Fixed: multi-key rotation, gemini-2.5-flash, live mode webhook
 */

const express = require("express");
const app = express();

/* Raw body for webhook, JSON for everything else */
app.use("/webhook", express.raw({ type: "*/*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ── CORS — all routes ── */
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const allowed = [
    process.env.FRONTEND_URL || "https://postflow-ai-iota.vercel.app",
    "https://postflow-ai-iota.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
  ];
  if (!origin || allowed.some(a => origin.startsWith(a)) || process.env.NODE_ENV !== "production") {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ── ENV ── */
const {
  META_VERIFY_TOKEN    = "postflow_verify_2024",
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_DISPLAY_NUMBER  = "Check Meta dashboard",
  PORT                 = 3000,
  RATE_LIMIT_PER_HOUR  = "20",
  RATE_LIMIT_PER_DAY   = "50",
} = process.env;

/* ══════════════════════════════════════════
   MULTI-KEY ROTATION
   Add keys in Railway Variables:
   GEMINI_KEY   = AIzaSy...  (key 1)
   GEMINI_KEY_1 = AIzaSy...  (key 2)
   GEMINI_KEY_2 = AIzaSy...  (key 3)
   GEMINI_KEY_3 = AIzaSy...  (key 4)
   GEMINI_KEY_4 = AIzaSy...  (key 5)
   Server rotates automatically. If one hits
   rate limit, next key is tried instantly.
══════════════════════════════════════════ */
function getKeys() {
  const keys = [];
  if (process.env.GEMINI_KEY)   keys.push(process.env.GEMINI_KEY);
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GEMINI_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}
let keyIdx = 0;
function nextKey() {
  const keys = getKeys();
  if (!keys.length) throw new Error("No Gemini API keys set in Railway Variables");
  return keys[keyIdx++ % keys.length];
}

/* ══════════════════════════════════════════
   GEMINI AI — gemini-2.5-flash always
══════════════════════════════════════════ */
async function ai(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const key = nextKey();
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, topP: 0.95 } }) }
      );
      const d = await res.json();
      if (d.error?.status === "RESOURCE_EXHAUSTED" || d.error?.code === 429) {
        console.warn(`⚠️ Key ${i+1} rate limited, trying next...`);
        continue;
      }
      if (d.error) throw new Error(d.error.message);
      return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch(e) {
      if (i === retries - 1) throw e;
    }
  }
  throw new Error("All keys rate limited. Try again in a minute.");
}

/* ══════════════════════════════════════════
   WHATSAPP SEND
══════════════════════════════════════════ */
async function sendWA(to, text) {
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
    console.error("❌ META_ACCESS_TOKEN or META_PHONE_NUMBER_ID not set!");
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    { method: "POST", headers: { "Content-Type": "application/json",
        Authorization: `Bearer ${META_ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to,
        type: "text", text: { body: text } }) }
  );
  const d = await res.json();
  if (d.error) console.error("❌ WA send error:", JSON.stringify(d.error));
  else console.log(`✅ Sent to ${to}`);
}

/* ══════════════════════════════════════════
   RATE LIMITER
══════════════════════════════════════════ */
const rl = {};
const RL_H = parseInt(RATE_LIMIT_PER_HOUR);
const RL_D = parseInt(RATE_LIMIT_PER_DAY);
function checkRate(ip) {
  const now = Date.now(), H = 3600000, D = 86400000;
  if (!rl[ip]) rl[ip] = { h: [], d: [] };
  rl[ip].h = rl[ip].h.filter(t => now - t < H);
  rl[ip].d = rl[ip].d.filter(t => now - t < D);
  if (rl[ip].h.length >= RL_H) {
    const min = Math.ceil((rl[ip].h[0] + H - now) / 60000);
    return { ok: false, reason: `Hourly limit (${RL_H}/hr). Resets in ${min} min.` };
  }
  if (rl[ip].d.length >= RL_D) {
    const hr = Math.ceil((rl[ip].d[0] + D - now) / 3600000);
    return { ok: false, reason: `Daily limit (${RL_D}/day). Resets in ${hr} hrs.` };
  }
  rl[ip].h.push(now); rl[ip].d.push(now);
  return { ok: true };
}
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(rl)) {
    rl[ip].d = rl[ip].d.filter(t => now - t < 86400000);
    if (!rl[ip].d.length) delete rl[ip];
  }
}, 3600000);

/* ══════════════════════════════════════════
   CONVERSATION STATE
══════════════════════════════════════════ */
const state = {};

/* ══════════════════════════════════════════
   MESSAGE HANDLER
══════════════════════════════════════════ */
async function handleMessage(from, text, rawText) {
  if (!state[from]) state[from] = { step: "new" };
  const s = state[from];
  console.log(`[${from}] step=${s.step} text="${text.slice(0,40)}"`);

  /* ── NEW / RESTART ── */
  if (s.step === "new" || ["hi","hello","start","hey"].includes(text)) {
    s.step = "pick_tone";
    await sendWA(from,
      `⚡ *Welcome to PostFlow AI!*\n\nI turn your rough ideas into polished LinkedIn posts in seconds.\n\n*Pick your post format:*\n\n1️⃣ *Story* — Personal journey & lessons\n2️⃣ *Hot Take* — Bold opinion + data\n3️⃣ *List Post* — Actionable tips\n4️⃣ *Mistake* — Failure + lessons\n\nReply with 1, 2, 3 or 4\nOr just send your idea directly! 💡`
    );
    return;
  }

  /* ── PICK TONE ── */
  if (s.step === "pick_tone") {
    const map = { "1":"story","2":"insight","3":"list","4":"mistake",
      "story":"story","hot":"insight","take":"insight","list":"list","mistake":"mistake" };
    const tone = map[text] || (rawText.length > 20 ? "story" : null);
    if (tone) {
      s.tone = tone;
      s.step = "get_idea";
      if (rawText.length > 20) {
        /* They sent their idea directly — process it */
        await processIdea(from, rawText);
        return;
      }
      const names = {story:"📖 Story",insight:"💡 Hot Take",list:"📋 List Post",mistake:"❌ Mistake"};
      await sendWA(from,
        `${names[tone]} selected ✅\n\nNow send me your idea!\n\nExamples:\n• "I grew LinkedIn to 5k in 90 days. Here's how"\n• "Cold outreach tip that got me 40% reply rate"\n• Bullet points you want expanded into a post`
      );
    } else {
      await sendWA(from, `Reply with:\n1️⃣ Story\n2️⃣ Hot Take\n3️⃣ List Post\n4️⃣ Mistake\n\nOr just send your idea directly!`);
    }
    return;
  }

  /* ── GET IDEA → GENERATE ── */
  if (s.step === "get_idea") {
    if (rawText.length < 10) {
      await sendWA(from, `Send me your idea — a sentence is enough! 💡`);
      return;
    }
    await processIdea(from, rawText);
    return;
  }

  /* ── POST DONE ── */
  if (s.step === "done") {
    if (text === "1" || text.includes("new")) {
      s.step = "new"; s.tone = null;
      await handleMessage(from, "hi", "hi");
      return;
    }
    if (text === "2" || text.includes("change") || text.includes("redo")) {
      s.step = "get_idea";
      await sendWA(from, `Send your idea again and I'll write a different version 🔄`);
      return;
    }
    if (text === "3" || text.includes("image")) {
      const styles = {
        story:   "warm cinematic golden hour, 35mm film grain, shallow depth of field, meaningful silhouette",
        insight: "bold abstract, dramatic side lighting, dark background, electric color accent",
        list:    "clean minimal flat lay, soft overhead light, editorial magazine style",
        mistake: "moody chiaroscuro, lone figure, cinematic fog, contemplative atmosphere"
      };
      const style = styles[s.tone||"story"];
      await sendWA(from,
        `🎨 *AI Image Prompt for your cover:*\n\n_"${s.lastIdea||"professional LinkedIn"}: ${style}, deep navy and blue palette, no text, no watermark, ultra HD 4K, 16:9 landscape"_\n\nGenerate free at:\n🌸 *image.pollinations.ai*\n\nOr use PostFlow AI website for more AI models 🚀`
      );
      return;
    }
    /* New idea sent directly */
    if (rawText.length > 15) {
      s.step = "get_idea";
      await processIdea(from, rawText);
      return;
    }
    await sendWA(from, `Reply *1* for new post, *2* to redo, *3* for image prompt\nOr just send a new idea! 💡`);
    return;
  }

  /* ── GENERATING (prevent double) ── */
  if (s.step === "generating") {
    await sendWA(from, `⏳ Still writing your post... just a few seconds!`);
    return;
  }

  /* Fallback */
  s.step = "new";
  await handleMessage(from, "hi", "hi");
}

async function processIdea(from, rawText) {
  const s = state[from];
  s.step = "generating";
  s.lastIdea = rawText;
  await sendWA(from, `✍️ Writing your post...\n_~10 seconds_`);
  const tone = s.tone || "story";
  const toneGuide = {
    story:   "Hook (bold claim not a question) → blank → 3-4 story lines (one idea per line) → blank → 'Here's what I learned:' → 3 numbered lessons → blank → CTA asking their story",
    insight: "Controversial opener ≤10 words → blank → 'Here's what most miss:' → 3-4 argument lines → blank → counter-argument → rebuttal → blank → polarizing yes/no question",
    list:    "'X things [audience] should do instead of [mistake]:' → blank → 5-7 numbered insights (Bold: explanation) → blank → 'Save this.'",
    mistake: "Mistake stated upfront, no buildup → blank → what happened 2-3 lines → blank → 'The moment I realized:' → turning point → blank → 3 things you'd do differently → 'Still figuring it out.'"
  };
  try {
    const [post, tags] = await Promise.all([
      ai(`Write a LinkedIn post about: "${rawText}"\nFormat: ${toneGuide[tone]}\nRules: 150-220 words, first person, conversational, no em-dashes, no "excited to share", blank lines between sections\nReturn ONLY the post text.`),
      ai(`5 LinkedIn hashtags for: "${rawText.slice(0,80)}". Return ONLY hashtags separated by spaces, nothing else.`)
    ]);
    s.lastPost = post;
    s.step = "done";
    await sendWA(from,
      `✅ *Your LinkedIn Post:*\n\n━━━━━━━━━━━━━━━\n\n${post}\n\n━━━━━━━━━━━━━━━\n\n*Hashtags:* ${tags.trim()}`
    );
    await new Promise(r => setTimeout(r, 800));
    await sendWA(from,
      `*What next?*\n\n1️⃣ New post\n2️⃣ Redo this post\n3️⃣ Get AI image prompt\n\nOr just send a new idea directly! 💡`
    );
  } catch(err) {
    console.error("Generation error:", err.message);
    s.step = "get_idea";
    await sendWA(from, `❌ ${err.message}\n\nPlease try again!`);
  }
}

/* ══════════════════════════════════════════
   WEBHOOK — VERIFY (GET)
══════════════════════════════════════════ */
app.get("/webhook", (req, res) => {
  const mode  = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chal  = req.query["hub.challenge"];
  console.log(`🔍 Webhook verify: mode=${mode} token=${token}`);
  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    return res.status(200).send(chal);
  }
  console.error("❌ Verify failed! Expected:", META_VERIFY_TOKEN, "Got:", token);
  res.sendStatus(403);
});

/* ══════════════════════════════════════════
   WEBHOOK — RECEIVE MESSAGES (POST)
══════════════════════════════════════════ */
app.post("/webhook", async (req, res) => {
  /* Respond 200 immediately — Meta requires within 5s */
  res.sendStatus(200);
  try {
    /* Parse body — may come as Buffer due to raw middleware */
    let body = req.body;
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString());

    /* Log EVERYTHING for debugging */
    console.log("📨 Webhook received:", JSON.stringify(body).slice(0, 500));

    if (body.object !== "whatsapp_business_account") {
      console.log("⚠️ Not a whatsapp_business_account object:", body.object);
      return;
    }

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    console.log("📋 Changes field:", changes?.field);
    console.log("📋 Value type:", value?.messaging_product);

    const messages = value?.messages;
    if (!messages?.length) {
      /* Could be a status update — ignore silently */
      console.log("ℹ️ No messages in webhook (status update or other)");
      return;
    }

    const msg  = messages[0];
    const from = msg.from;
    console.log(`📱 Message from: ${from} | Type: ${msg.type}`);

    let rawText = "";
    if (msg.type === "text")        rawText = msg.text?.body || "";
    else if (msg.type === "interactive") rawText = msg.interactive?.button_reply?.title || "";
    else {
      await sendWA(from, "Please send a text message 💬");
      return;
    }

    if (!rawText.trim()) return;
    console.log(`💬 Processing: "${rawText.slice(0,60)}" from ${from}`);
    await handleMessage(from, rawText.toLowerCase().trim(), rawText.trim());

  } catch(err) {
    console.error("❌ Webhook error:", err.message, err.stack?.slice(0,300));
  }
});

/* ══════════════════════════════════════════
   AI PROXY — Free tier for frontend
══════════════════════════════════════════ */
app.post("/api/ai", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const check = checkRate(ip);
  if (!check.ok) return res.status(429).json({
    error: check.reason,
    upgrade: "Get your free Gemini key at aistudio.google.com/app/apikey"
  });
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.length > 8000)
    return res.status(400).json({ error: "Invalid prompt" });
  try {
    const text = await ai(prompt);
    res.json({ text });
  } catch(err) {
    console.error("AI proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   REGISTRATION
══════════════════════════════════════════ */
app.post("/register", async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "Name and phone required" });
  let clean = phone.replace(/[\s\-\(\)]/g, "");
  if (!clean.startsWith("91")) clean = "91" + clean.replace("+91","").replace("+","");
  state[clean] = { step: "new", name };
  res.json({ success: true, bot_number: META_DISPLAY_NUMBER,
    instruction: `Hi ${name}! Open WhatsApp and send "hi" to ${META_DISPLAY_NUMBER}` });
});

/* ══════════════════════════════════════════
   USAGE + HEALTH
══════════════════════════════════════════ */
app.get("/api/usage", (req, res) => {
  const keys = getKeys();
  res.json({
    status: "running",
    gemini_keys_loaded: keys.length,
    key_index: keyIdx % (keys.length || 1),
    rate_limits: { per_hour: RL_H, per_day: RL_D },
    active_ips: Object.keys(rl).length,
    whatsapp_users: Object.keys(state).length
  });
});

app.get("/", (req, res) => res.json({
  status: "✅ PostFlow AI running",
  keys: getKeys().length + " Gemini keys loaded",
  model: "gemini-2.5-flash",
  whatsapp_users: Object.keys(state).length,
  time: new Date().toISOString()
}));

app.listen(PORT, () => {
  const keys = getKeys();
  console.log(`⚡ PostFlow AI running on port ${PORT}`);
  console.log(`🔑 ${keys.length} Gemini key(s) loaded`);
  console.log(`📱 Webhook: /webhook | AI Proxy: /api/ai`);
  if (!META_ACCESS_TOKEN) console.warn("⚠️ META_ACCESS_TOKEN not set — WhatsApp won't send messages");
  if (!keys.length) console.warn("⚠️ No GEMINI_KEY set — AI proxy won't work");
});