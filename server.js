/**
 * PostFlow AI — WhatsApp Bot Server
 * Meta Business API + Gemini AI + Railway deployment
 * 
 * Flow:
 *   User texts WhatsApp number
 *   → This server receives it via Meta webhook
 *   → Calls Gemini to generate LinkedIn post
 *   → Sends reply back via Meta API
 */

const express = require("express");
/* Using built-in fetch — Node 18+ has it natively, no package needed */
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ─── ENV VARIABLES (set in Railway dashboard) ─── */
const {
  META_VERIFY_TOKEN,   // any string you choose e.g. "postflow2024"
  META_ACCESS_TOKEN,   // from Meta App Dashboard → WhatsApp → API Setup
  META_PHONE_NUMBER_ID,// from Meta App Dashboard → WhatsApp → API Setup
  GEMINI_KEY,          // from aistudio.google.com/app/apikey
  PORT = 3000
} = process.env;

/* ─── In-memory user state (tracks conversation step) ─── */
/* For production, replace with a database like Supabase (free) */
const userState = {};
/* Structure: { "+91XXXXXXXXXX": { step: "idle|waiting_tone|waiting_idea", tone: "story", name: "" } } */

/* ─── GEMINI AI ─── */
async function callGemini(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.85, topP: 0.95 }
      })
    }
  );
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/* ─── META WHATSAPP SEND MESSAGE ─── */
async function sendWhatsApp(to, message) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: message }
      })
    }
  );
  const d = await res.json();
  if (d.error) console.error("WhatsApp send error:", d.error);
  return d;
}

/* Send interactive list/button message */
async function sendButtons(to, bodyText, buttons) {
  /* buttons = [{id:"btn_id", title:"Button Text"}] max 3 */
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${META_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map(b => ({
              type: "reply",
              reply: { id: b.id, title: b.title }
            }))
          }
        }
      })
    }
  );
  const d = await res.json();
  if (d.error) {
    /* Fallback to plain text if buttons fail */
    await sendWhatsApp(to, bodyText + "\n\nReply with: " + buttons.map(b => b.title).join(" | "));
  }
  return d;
}

/* ─── LINKEDIN POST GENERATOR ─── */
const TONE_PROMPTS = {
  story: `Write a LinkedIn post using storytelling format:
- Bold pattern-interrupt hook (NOT a question, max 12 words)
- blank line
- 3-4 lines personal story (one idea per line)
- blank line
- "Here's what I learned:"
- 3 numbered lessons (action verb, max 1.5 lines each)
- blank line
- CTA asking for their story

Rules: 150-220 words, first person, no "I'm excited to share", no em-dashes, conversational`,

  insight: `Write a LinkedIn post as a hot take / opinion:
- Controversial opening claim (max 10 words)
- blank line
- "Here's what most people miss:"
- 3-4 lines expanding argument
- blank line
- Counter-argument in 1 line, then rebuttal in 2 lines
- blank line
- Polarizing yes/no question at end

Rules: 150-220 words, no jargon, no em-dashes`,

  list: `Write a LinkedIn list post:
- Opening: "X things [audience] should do instead of [common mistake]:"
- blank line
- 5-7 numbered insights (Bold concept: explanation, max 1.5 lines each)
- blank line
- "Bonus:" one surprising insight
- blank line
- "Save this."

Rules: 150-220 words, punchy, actionable`,

  mistake: `Write a LinkedIn post about a failure/mistake:
- The mistake stated upfront, no buildup (max 12 words)
- blank line
- What happened (2-3 specific lines)
- blank line
- "The moment I realized:"
- Turning point (2 lines)
- blank line
- 3 things you'd do differently (numbered)
- blank line
- "Still figuring it out."

Rules: 150-220 words, vulnerable, specific`
};

async function generateLinkedInPost(idea, tone = "story") {
  const tonePrompt = TONE_PROMPTS[tone] || TONE_PROMPTS.story;
  
  const prompt = `You are a LinkedIn content expert who helps people share their authentic ideas.

User's rough idea: "${idea}"

${tonePrompt}

Important: Keep their authentic voice. Don't make it sound like an AI wrote it.
Return ONLY the post text, nothing else.`;

  return await callGemini(prompt);
}

async function generateHashtags(idea) {
  const h = await callGemini(
    `Give 5 LinkedIn hashtags for: "${idea}". Mix one popular (1M+), two mid (50-500k), two niche. Return ONLY hashtags separated by spaces.`
  );
  return h.trim();
}

async function generateImagePrompt(idea, tone) {
  const styles = {
    story: "cinematic, warm golden hour, film grain, shallow depth of field",
    insight: "abstract editorial, dramatic lighting, bold contrast",
    list: "clean minimal flat lay, soft light",
    mistake: "moody cinematic, lone silhouette, turning point"
  };
  return `${idea}: ${styles[tone] || styles.story}, no text, no watermark, ultra HD 4K, 16:9 professional LinkedIn cover`;
}

/* ─── MESSAGE HANDLER ─── */
async function handleMessage(from, messageBody, buttonId) {
  const text = (messageBody || "").trim().toLowerCase();
  const state = userState[from] || { step: "new" };
  userState[from] = state;

  console.log(`[MSG] From: ${from} | Step: ${state.step} | Text: ${text.slice(0, 50)}`);

  /* ── NEW USER ── */
  if (state.step === "new" || text === "hi" || text === "hello" || text === "start") {
    state.step = "waiting_tone";
    await sendWhatsApp(from,
      `⚡ *Welcome to PostFlow AI!*\n\nI turn your rough ideas into polished LinkedIn posts.\n\n*How it works:*\n1️⃣ Pick a post format\n2️⃣ Share your rough idea\n3️⃣ Get your polished post + hashtags\n\nLet's start! What format do you want?`
    );
    await sendButtons(from, "Choose your post format:", [
      { id: "tone_story",   title: "📖 Story" },
      { id: "tone_insight", title: "💡 Hot Take" },
      { id: "tone_list",   title: "📋 List Post" }
    ]);
    return;
  }

  /* ── TONE SELECTION ── */
  if (state.step === "waiting_tone" || buttonId?.startsWith("tone_")) {
    const toneMap = {
      tone_story:   "story",
      tone_insight: "insight",
      tone_list:    "list",
      tone_mistake: "mistake"
    };

    /* Check button reply */
    let selectedTone = buttonId ? toneMap[buttonId] : null;

    /* Check text reply */
    if (!selectedTone) {
      if (text.includes("story"))   selectedTone = "story";
      if (text.includes("hot") || text.includes("take") || text.includes("insight")) selectedTone = "insight";
      if (text.includes("list"))    selectedTone = "list";
      if (text.includes("mistake") || text.includes("fail")) selectedTone = "mistake";
    }

    if (selectedTone) {
      state.tone = selectedTone;
      state.step = "waiting_idea";
      const toneNames = { story: "📖 Story", insight: "💡 Hot Take", list: "📋 List Post", mistake: "❌ Mistake" };
      await sendWhatsApp(from,
        `Got it! *${toneNames[selectedTone]}* format selected ✅\n\nNow send me your rough idea.\nCan be:\n• A few bullet points\n• A half-written thought\n• Just one sentence\n\n_Example: "I spent 2 years building a product nobody wanted. Here's what I learned"_`
      );
    } else {
      await sendButtons(from, "Please pick one of these formats:", [
        { id: "tone_story",   title: "📖 Story" },
        { id: "tone_insight", title: "💡 Hot Take" },
        { id: "tone_list",   title: "📋 List Post" }
      ]);
    }
    return;
  }

  /* ── IDEA RECEIVED — GENERATE POST ── */
  if (state.step === "waiting_idea") {
    /* Short message probably means they're confused */
    if (text.length < 15) {
      await sendWhatsApp(from, `Send me your idea! Minimum a sentence or two about what you want to post about. 💡`);
      return;
    }

    state.step = "generating";
    await sendWhatsApp(from, `🤖 Got it! Writing your LinkedIn post...\n_This takes ~10 seconds_`);

    try {
      const tone = state.tone || "story";
      const idea = messageBody.trim();

      /* Generate post and hashtags in parallel */
      const [post, hashtags] = await Promise.all([
        generateLinkedInPost(idea, tone),
        generateHashtags(idea)
      ]);

      /* Send the post */
      await sendWhatsApp(from,
        `✅ *Your LinkedIn Post is Ready!*\n\n━━━━━━━━━━━━━━━\n\n${post}\n\n━━━━━━━━━━━━━━━\n\n*Hashtags:*\n${hashtags}`
      );

      /* Send follow-up options */
      await new Promise(r => setTimeout(r, 1500)); /* small delay */
      await sendButtons(from,
        `What would you like to do?`,
        [
          { id: "action_new",    title: "✍️ New Post" },
          { id: "action_change", title: "🔄 Change Format" },
          { id: "action_image",  title: "🎨 Image Prompt" }
        ]
      );

      state.lastIdea = idea;
      state.lastPost = post;
      state.step = "post_done";

    } catch (err) {
      console.error("Generation error:", err);
      await sendWhatsApp(from, `❌ Something went wrong: ${err.message}\n\nPlease try again or visit postflowai.com`);
      state.step = "waiting_idea";
    }
    return;
  }

  /* ── POST DONE — HANDLE NEXT ACTION ── */
  if (state.step === "post_done" || buttonId?.startsWith("action_")) {
    if (buttonId === "action_new" || text === "new" || text.includes("new post")) {
      state.step = "waiting_tone";
      state.tone = null;
      await sendButtons(from, "Great! Pick a format for your next post:", [
        { id: "tone_story",   title: "📖 Story" },
        { id: "tone_insight", title: "💡 Hot Take" },
        { id: "tone_list",   title: "📋 List Post" }
      ]);
      return;
    }

    if (buttonId === "action_change" || text.includes("change") || text.includes("different")) {
      state.step = "waiting_idea";
      await sendWhatsApp(from, `Send me your idea again and I'll rewrite it with a different angle 🔄`);
      return;
    }

    if (buttonId === "action_image" || text.includes("image") || text.includes("cover")) {
      const imgPrompt = await generateImagePrompt(state.lastIdea || "professional content", state.tone || "story");
      await sendWhatsApp(from,
        `🎨 *AI Image Prompt for your cover:*\n\n_"${imgPrompt}"_\n\nPaste this at:\n🌸 *https://image.pollinations.ai*\n🤖 Or use Gemini/Midjourney\n\n_This generates a free AI image matching your post_`
      );
      return;
    }

    /* If they just sent text after post is done — treat as new idea */
    if (text.length > 20) {
      state.step = "waiting_idea";
      await handleMessage(from, messageBody, null);
    }
    return;
  }

  /* ── GENERATING STATE (prevent double trigger) ── */
  if (state.step === "generating") {
    await sendWhatsApp(from, `⏳ Still generating your post... please wait a moment!`);
    return;
  }

  /* ── FALLBACK ── */
  state.step = "new";
  await sendWhatsApp(from, `Send *hi* to start creating LinkedIn posts! ⚡`);
}

/* ─── META WEBHOOK VERIFICATION ─── */
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

/* ─── META WEBHOOK MESSAGE RECEIVER ─── */
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    /* Verify it's a WhatsApp message */
    if (body.object !== "whatsapp_business_account") {
      return res.sendStatus(404);
    }

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const messages = value?.messages;

    if (!messages?.length) {
      return res.sendStatus(200); /* No messages, just status update */
    }

    const msg  = messages[0];
    const from = msg.from; /* Phone number with country code e.g. "919876543210" */

    let messageBody = "";
    let buttonId    = null;

    if (msg.type === "text") {
      messageBody = msg.text?.body || "";
    } else if (msg.type === "interactive") {
      /* Button reply */
      buttonId    = msg.interactive?.button_reply?.id || "";
      messageBody = msg.interactive?.button_reply?.title || "";
    } else {
      /* Unsupported message type */
      await sendWhatsApp(from, "Please send a text message with your idea! 💬");
      return res.sendStatus(200);
    }

    /* Respond to Meta immediately (required within 5s) */
    res.sendStatus(200);

    /* Process asynchronously */
    await handleMessage(from, messageBody, buttonId);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* ─── REGISTRATION ENDPOINT ─── */
/* Called when user submits the registration form on your website */
app.post("/register", async (req, res) => {
  const { name, phone } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: "Name and phone required" });
  }

  /* Normalize phone: remove spaces, dashes, add country code if missing */
  let cleanPhone = phone.replace(/[\s\-\(\)]/g, "");
  if (!cleanPhone.startsWith("+") && !cleanPhone.startsWith("91")) {
    cleanPhone = "91" + cleanPhone; /* Default India */
  }
  cleanPhone = cleanPhone.replace("+", "");

  try {
    /* Initialize user state */
    userState[cleanPhone] = { step: "new", name: name };

    /* Send welcome WhatsApp */
    await sendWhatsApp(cleanPhone,
      `👋 Hi ${name}! Welcome to *PostFlow AI*!\n\nYou're all set. I'll help you turn rough ideas into polished LinkedIn posts.\n\nSend me *hi* anytime to start! ⚡\n\n_Or just text your idea directly_`
    );

    res.json({ success: true, message: "Welcome message sent!" });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════
   FREE TIER AI PROXY
   Hides your Gemini key from the frontend.
   Users don't need their own key — yours is used,
   but rate-limited so no one can drain it.
═══════════════════════════════════════════════════ */

/* Rate limiter — tracks requests per IP */
const rateLimiter = {};
const RATE_LIMIT   = parseInt(process.env.RATE_LIMIT_PER_HOUR  || "20");  /* requests per IP per hour */
const DAILY_LIMIT  = parseInt(process.env.RATE_LIMIT_PER_DAY   || "50");  /* requests per IP per day */

function checkRateLimit(ip) {
  const now   = Date.now();
  const hour  = 60 * 60 * 1000;
  const day   = 24 * hour;

  if (!rateLimiter[ip]) {
    rateLimiter[ip] = { hourRequests: [], dayRequests: [] };
  }

  const r = rateLimiter[ip];

  /* Clean up old entries */
  r.hourRequests = r.hourRequests.filter(t => now - t < hour);
  r.dayRequests  = r.dayRequests.filter(t => now - t < day);

  if (r.hourRequests.length >= RATE_LIMIT) {
    const resetIn = Math.ceil((r.hourRequests[0] + hour - now) / 60000);
    return { allowed: false, reason: `Hourly limit reached (${RATE_LIMIT}/hour). Resets in ${resetIn} min.` };
  }
  if (r.dayRequests.length >= DAILY_LIMIT) {
    const resetIn = Math.ceil((r.dayRequests[0] + day - now) / 3600000);
    return { allowed: false, reason: `Daily limit reached (${DAILY_LIMIT}/day). Resets in ${resetIn} hrs.` };
  }

  r.hourRequests.push(now);
  r.dayRequests.push(now);
  return { allowed: true };
}

/* Clean rate limiter memory every hour */
setInterval(() => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  for (const ip of Object.keys(rateLimiter)) {
    rateLimiter[ip].dayRequests = rateLimiter[ip].dayRequests.filter(t => now - t < day);
    if (rateLimiter[ip].dayRequests.length === 0) delete rateLimiter[ip];
  }
}, 60 * 60 * 1000);

/* ─── /api/ai  — Text generation proxy ─── */
app.post("/api/ai", async (req, res) => {
  /* CORS — allow your Vercel site only */
  const origin = req.headers.origin || "";
  const allowed = [
    process.env.FRONTEND_URL || "https://postflow-ai-iota.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
  ];

  /* Allow all origins in dev, restrict in prod */
  const isAllowed = process.env.NODE_ENV !== "production" || allowed.some(a => origin.startsWith(a));
  if (!isAllowed) return res.status(403).json({ error: "Origin not allowed" });

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  /* Rate limit by IP */
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "unknown";
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return res.status(429).json({
      error: limit.reason,
      upgrade: "Get your free Gemini key at aistudio.google.com/app/apikey for unlimited use"
    });
  }

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== "string" || prompt.length > 8000) {
    return res.status(400).json({ error: "Invalid prompt" });
  }

  try {
    const text = await callGemini(prompt);
    res.json({ text });
  } catch (err) {
    console.error("AI proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── CORS preflight for /api/ai ─── */
app.options("/api/ai", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(200);
});

/* ─── /api/usage — Show current usage stats (optional debug) ─── */
app.get("/api/usage", (req, res) => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const day  = 24 * hour;
  const stats = {
    total_ips_tracked: Object.keys(rateLimiter).length,
    limits: { per_hour: RATE_LIMIT, per_day: DAILY_LIMIT },
    active_users_last_hour: Object.values(rateLimiter)
      .filter(r => r.hourRequests.some(t => now - t < hour)).length
  };
  res.json(stats);
});

/* ─── HEALTH CHECK ─── */
app.get("/", (req, res) => {
  res.json({
    status: "✅ PostFlow AI Bot running",
    timestamp: new Date().toISOString(),
    whatsapp_users: Object.keys(userState).length,
    proxy: `AI proxy active — ${RATE_LIMIT} req/hour, ${DAILY_LIMIT} req/day per user`
  });
});

/* ─── START ─── */
app.listen(PORT, () => {
  console.log(`⚡ PostFlow AI Bot running on port ${PORT}`);
  console.log(`📱 Webhook URL: https://YOUR-RAILWAY-URL.railway.app/webhook`);
});
