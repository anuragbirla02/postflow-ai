/**
 * PostFlow AI — WhatsApp Bot + AI Proxy
 * Supports BOTH Meta Business API + Twilio Sandbox
 * Multi Gemini key rotation — gemini-2.5-flash
 */

const express = require("express");
const app = express();

app.use("/webhook", express.raw({ type: "*/*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ── CORS ── */
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

/* ══════════════════════════════════════════
   ENV — set all in Railway Variables
══════════════════════════════════════════ */
const {
  META_VERIFY_TOKEN   = "postflow_verify_2024",
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_DISPLAY_NUMBER = "Not configured",
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_FROM,
  PORT                = 3000,
  RATE_LIMIT_PER_HOUR = "20",
  RATE_LIMIT_PER_DAY  = "50",
} = process.env;

/* ══════════════════════════════════════════
   MULTI-KEY ROTATION
   Railway Variables:
   GEMINI_KEY   = AIzaSy... (key 1)
   GEMINI_KEY_1 = AIzaSy... (key 2)
   GEMINI_KEY_2 = AIzaSy... (key 3)
   GEMINI_KEY_3 = AIzaSy... (key 4)
   GEMINI_KEY_4 = AIzaSy... (key 5)
══════════════════════════════════════════ */
function getKeys() {
  const keys = [];
  if (process.env.GEMINI_KEY) keys.push(process.env.GEMINI_KEY);
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`GEMINI_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}
let keyIdx = 0;
function nextKey() {
  const keys = getKeys();
  if (!keys.length) throw new Error("No Gemini API keys in Railway Variables");
  return keys[keyIdx++ % keys.length];
}

/* ══════════════════════════════════════════
   GEMINI AI
══════════════════════════════════════════ */
async function ai(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const key = nextKey();
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, topP: 0.95 }
          })
        }
      );
      const d = await res.json();
      if (d.error?.status === "RESOURCE_EXHAUSTED" || d.error?.code === 429) {
        console.warn(`Key ${i+1} rate limited, trying next...`);
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
   SEND MESSAGE
   platform = "meta" or "twilio"
══════════════════════════════════════════ */
async function send(to, text, platform) {
  if (platform === "twilio") {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
      console.error("Twilio credentials not set"); return;
    }
    const toFmt = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const auth  = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const body  = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: toFmt, Body: text });
    const res   = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      { method: "POST",
        headers: { "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }
    );
    const d = await res.json();
    if (d.error_code) console.error("Twilio error:", d.error_message);
    else console.log(`Twilio sent to ${to}`);
    return;
  }
  /* Meta */
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
    console.error("Meta tokens not set"); return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    { method: "POST",
      headers: { "Content-Type": "application/json",
        Authorization: `Bearer ${META_ACCESS_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp",
        to, type: "text", text: { body: text } })
    }
  );
  const d = await res.json();
  if (d.error) console.error("Meta error:", JSON.stringify(d.error));
  else console.log(`Meta sent to ${to}`);
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
async function handleMessage(from, rawText, platform) {
  if (!state[from]) state[from] = { step: "new" };
  const s   = state[from];
  const txt = rawText.toLowerCase().trim();
  console.log(`[${platform}][${from}] step=${s.step} msg="${rawText.slice(0,50)}"`);

  /* NEW / RESTART */
  if (s.step === "new" || ["hi","hello","start","hey"].includes(txt)) {
    s.step = "pick_tone";
    await send(from,
      `⚡ *Welcome to PostFlow AI!*\n\nI turn your rough ideas into polished LinkedIn posts in seconds.\n\n*Pick your post format:*\n\n1️⃣ *Story* — Personal journey & lessons\n2️⃣ *Hot Take* — Bold opinion + data\n3️⃣ *List Post* — Actionable tips\n4️⃣ *Mistake* — Failure + lessons\n\nReply 1, 2, 3 or 4\nOr just send your idea directly! 💡`,
      platform
    );
    return;
  }

  /* PICK TONE */
  if (s.step === "pick_tone") {
    const map = {
      "1":"story","2":"insight","3":"list","4":"mistake",
      "story":"story","hot":"insight","take":"insight",
      "list":"list","mistake":"mistake","fail":"mistake"
    };
    const tone = map[txt] || (rawText.length > 20 ? "story" : null);
    if (tone) {
      s.tone = tone; s.step = "get_idea";
      if (rawText.length > 20) { await processIdea(from, rawText, platform); return; }
      const names = {story:"📖 Story",insight:"💡 Hot Take",list:"📋 List Post",mistake:"❌ Mistake"};
      await send(from,
        `${names[tone]} selected ✅\n\nNow send me your idea!\n\nExamples:\n• "I grew LinkedIn to 5k in 90 days"\n• "Cold outreach tip that got me 40% reply rate"\n• Bullet points you want expanded into a post`,
        platform
      );
    } else {
      await send(from,
        `Reply with:\n1️⃣ Story\n2️⃣ Hot Take\n3️⃣ List Post\n4️⃣ Mistake\n\nOr just send your idea directly!`,
        platform
      );
    }
    return;
  }

  /* GET IDEA */
  if (s.step === "get_idea") {
    if (rawText.length < 10) {
      await send(from, `Send me your idea — a sentence is enough! 💡`, platform);
      return;
    }
    await processIdea(from, rawText, platform);
    return;
  }

  /* POST DONE */
  if (s.step === "done") {
    if (txt === "1" || txt.includes("new")) {
      s.step = "new"; s.tone = null;
      await handleMessage(from, "hi", platform);
      return;
    }
    if (txt === "2" || txt.includes("redo") || txt.includes("change")) {
      s.step = "get_idea";
      await send(from, `Send your idea again and I'll write a different version 🔄`, platform);
      return;
    }
    if (txt === "3" || txt.includes("image")) {
      const styles = {
        story:   "warm cinematic golden hour, 35mm film grain, shallow depth of field",
        insight: "bold abstract composition, dramatic side lighting, dark background",
        list:    "clean minimal flat lay, soft diffused overhead light, editorial style",
        mistake: "moody chiaroscuro, lone figure at turning point, cinematic fog"
      };
      const style = styles[s.tone||"story"];
      await send(from,
        `🎨 *AI Image Prompt:*\n\n_"${s.lastIdea||"professional LinkedIn content"}: ${style}, deep navy and blue palette, no text, no watermark, ultra HD 4K, 16:9"_\n\nGenerate free at:\n🌸 *image.pollinations.ai*\n\nOr use the PostFlow AI website 🚀`,
        platform
      );
      return;
    }
    if (rawText.length > 15) {
      s.step = "get_idea";
      await processIdea(from, rawText, platform);
      return;
    }
    await send(from,
      `Reply *1* for new post, *2* to redo, *3* for AI image prompt\nOr just send a new idea! 💡`,
      platform
    );
    return;
  }

  /* GENERATING */
  if (s.step === "generating") {
    await send(from, `⏳ Still writing... a few more seconds!`, platform);
    return;
  }

  /* Fallback */
  s.step = "new";
  await handleMessage(from, "hi", platform);
}

/* GENERATE POST */
async function processIdea(from, rawText, platform) {
  const s = state[from];
  s.step = "generating";
  s.lastIdea = rawText;
  await send(from, `✍️ Writing your LinkedIn post...\n_~10 seconds_`, platform);

  const tone = s.tone || "story";
  const toneGuide = {
    story:   "Hook (bold claim, not a question) → blank line → 3-4 story lines (one idea per line) → blank line → 'Here's what I learned:' → 3 numbered lessons → blank line → CTA asking their story",
    insight: "Controversial opener ≤10 words → blank line → 'Here's what most miss:' → 3-4 argument lines → blank line → counter + rebuttal → blank line → polarizing yes/no question",
    list:    "'X things [audience] should do instead of [mistake]:' → blank line → 5-7 numbered insights (Bold: explanation) → blank line → 'Save this.'",
    mistake: "Mistake stated upfront → blank line → what happened 2-3 specific lines → blank line → 'The moment I realized:' → turning point → blank line → 3 things you'd do differently → 'Still figuring it out.'"
  };

  try {
    const [post, tags] = await Promise.all([
      ai(`Write a LinkedIn post about: "${rawText}"\nFormat: ${toneGuide[tone]}\nRules: 150-220 words, first person, conversational, no em-dashes, no "excited to share", blank lines between sections\nReturn ONLY the post text.`),
      ai(`Give 5 LinkedIn hashtags for: "${rawText.slice(0,80)}". Return ONLY hashtags separated by spaces.`)
    ]);

    s.lastPost = post;
    s.step = "done";

    await send(from,
      `✅ *Your LinkedIn Post:*\n\n━━━━━━━━━━━━━━━\n\n${post}\n\n━━━━━━━━━━━━━━━\n\n*Hashtags:* ${tags.trim()}`,
      platform
    );
    await new Promise(r => setTimeout(r, 1000));
    await send(from,
      `*What next?*\n\n1️⃣ New post\n2️⃣ Redo this post\n3️⃣ Get AI image prompt\n\nOr send a new idea directly! 💡`,
      platform
    );
  } catch(err) {
    console.error("Generation error:", err.message);
    s.step = "get_idea";
    await send(from, `❌ ${err.message}\n\nPlease try again!`, platform);
  }
}

/* ══════════════════════════════════════════
   META WEBHOOK
══════════════════════════════════════════ */
app.get("/webhook", (req, res) => {
  const mode  = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const chal  = req.query["hub.challenge"];
  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("Meta webhook verified!");
    return res.status(200).send(chal);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString());
    if (body.object !== "whatsapp_business_account") return;
    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;
    const msg = messages[0];
    const from = msg.from;
    let rawText = "";
    if (msg.type === "text") rawText = msg.text?.body || "";
    else if (msg.type === "interactive") rawText = msg.interactive?.button_reply?.title || "";
    else { await send(from, "Please send a text message 💬", "meta"); return; }
    if (!rawText.trim()) return;
    console.log(`Meta msg from ${from}: "${rawText.slice(0,60)}"`);
    await handleMessage(from, rawText.trim(), "meta");
  } catch(err) {
    console.error("Meta webhook error:", err.message);
  }
});

/* ══════════════════════════════════════════
   TWILIO WEBHOOK
   Setup in Twilio Console:
   Messaging → Sandbox → "When a message comes in"
   URL: https://YOUR-RAILWAY-URL.railway.app/twilio
   Method: HTTP POST
══════════════════════════════════════════ */
app.post("/twilio", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const from    = req.body.From || "";
    const rawText = req.body.Body || "";
    if (!from || !rawText.trim()) return;
    console.log(`Twilio msg from ${from}: "${rawText.slice(0,60)}"`);
    await handleMessage(from, rawText.trim(), "twilio");
  } catch(err) {
    console.error("Twilio webhook error:", err.message);
  }
});

/* ══════════════════════════════════════════
   AI PROXY
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
  const twilioNum = TWILIO_WHATSAPP_FROM?.replace("whatsapp:","") || "";
  const metaNum   = META_DISPLAY_NUMBER || "";
  res.json({
    success: true,
    twilio_number: twilioNum,
    meta_number:   metaNum,
    instruction:   `Hi ${name}! Open WhatsApp and send "hi" to ${twilioNum || metaNum}`
  });
});

/* ══════════════════════════════════════════
   HEALTH
══════════════════════════════════════════ */
app.get("/api/usage", (req, res) => {
  const keys = getKeys();
  res.json({
    status: "running",
    keys_loaded: keys.length,
    key_index: keyIdx % (keys.length||1),
    rate_limits: { per_hour: RL_H, per_day: RL_D },
    whatsapp_users: Object.keys(state).length,
    platforms: {
      meta:   META_ACCESS_TOKEN   ? "configured" : "not set",
      twilio: TWILIO_ACCOUNT_SID  ? "configured" : "not set"
    }
  });
});

app.get("/", (req, res) => res.json({
  status: "PostFlow AI running",
  model:  "gemini-2.5-flash",
  keys:   getKeys().length,
  users:  Object.keys(state).length,
  endpoints: ["/webhook", "/twilio", "/api/ai", "/register", "/api/usage"],
  time:   new Date().toISOString()
}));

app.listen(PORT, () => {
  const keys = getKeys();
  console.log(`PostFlow AI running on port ${PORT}`);
  console.log(`${keys.length} Gemini key(s) loaded`);
  if (!keys.length)        console.warn("No GEMINI_KEY set!");
  if (!META_ACCESS_TOKEN)  console.warn("META_ACCESS_TOKEN not set");
  if (!TWILIO_ACCOUNT_SID) console.warn("TWILIO credentials not set (Twilio disabled)");
});
