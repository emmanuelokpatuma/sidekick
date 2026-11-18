/* Shared Gemini core.
 *
 * One copy of the logic, used by both entry points:
 *   - server.js          local run (node server.js)
 *   - api/*.js           serverless functions on Vercel
 *
 * Nothing here serves files or owns a socket, so it is safe to require from a
 * serverless runtime.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";
const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

/* Environment lookups that also work where `process` does not exist (a Worker). */
function envVar(name) {
  try {
    if (typeof process === "undefined" || !process.env) return "";
    return process.env[name] || "";
  } catch (e) {
    return "";
  }
}

/* ---------- key ----------
   Environment first; the page's "Connect" box can also send a key per request
   as `x-gemini-key`. That header path is a convenience — anything public should
   rely on the environment variable only. */

function keyFor(req) {
  const header = req.headers["x-gemini-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return String(envVar("GEMINI_API_KEY")).trim();
}

/* ---------- model discovery ----------
   Model ids move. Instead of hardcoding one and breaking later, ask the API what
   this key can actually use and pick sensible defaults. */

const modelCache = new Map(); // key -> { at, liveModel, textModel, warning }

const LIVE_PREFERENCE = [/transcribe-live/i, /^gemini-[\d.]+-live$/i, /flash-live/i, /live/i];
const TEXT_PREFERENCE = [
  /^gemini-3\.8-flash$/i,
  /^gemini-3\.5-flash-lite$/i,
  /^gemini-[\d.]+-flash$/i,
  /^gemini-[\d.]+-flash-lite$/i,
  /flash/i,
  /^gemini-[\d.]+-pro$/i,
  /pro/i,
];

const cleanName = (n) => String(n || "").replace(/^models\//, "");

function pick(candidates, preference) {
  for (const re of preference) {
    const hit = candidates.find((m) => re.test(m));
    if (hit) return hit;
  }
  return candidates[0] || "";
}

function rankTextModels(candidates) {
  return [...candidates].sort((a, b) => {
    const rank = (name) => {
      const index = TEXT_PREFERENCE.findIndex((re) => re.test(name));
      return index < 0 ? TEXT_PREFERENCE.length : index;
    };
    return rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true });
  });
}

async function resolveModels(key, force) {
  const cached = modelCache.get(key);
  if (cached && !force && Date.now() - cached.at < 10 * 60 * 1000) return cached;

  const result = { at: Date.now(), liveModel: "", textModel: "", warning: "" };
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      result.warning = body?.error?.message || `model lookup failed (${res.status})`;
      modelCache.set(key, result);
      return result;
    }
    const models = Array.isArray(body.models) ? body.models : [];
    const methods = (m) => (m.supportedGenerationMethods || []).map((x) => String(x).toLowerCase());
    const usable = models
      .filter((m) => !/embedding|aqa|imagen|veo|tts|audio-dialog/i.test(cleanName(m.name)))
      .map((m) => ({ name: cleanName(m.name), methods: methods(m) }));

    const live = usable.filter((m) => m.methods.includes("bidigeneratecontent")).map((m) => m.name);
    const text = usable
      .filter((m) => m.methods.includes("generatecontent"))
      .map((m) => m.name)
      .filter((n) => !/live|transcribe|audio|image|robotics|computer-use|embedding/i.test(n));

    result.liveModel = envVar("GEMINI_LIVE_MODEL") || pick(live, LIVE_PREFERENCE);
    result.textModels = envVar("GEMINI_TEXT_MODEL")
      ? [envVar("GEMINI_TEXT_MODEL")]
      : rankTextModels(text);
    result.textModel = result.textModels[0] || "";
    if (!result.liveModel) result.warning = "no streaming model available on this key";
    if (!result.textModel) result.warning = result.warning || "no text model available on this key";
  } catch (e) {
    result.warning = "could not reach the Gemini API: " + e.message;
  }
  modelCache.set(key, result);
  return result;
}

/* ---------- Gemini calls ---------- */

async function mintToken(key, liveModel) {
  const now = Date.now();
  const res = await fetch(`${API}/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `token request failed (${res.status})`);
  const name = body.name;
  if (!name) throw new Error("token response had no name");
  return { token: name, wsUrl: `${WS_BASE}?access_token=${name}`, model: liveModel };
}

function buildPrompt({ question, role, stories, recent }) {
  const evidence = (stories || [])
    .map((s) => `- ${s.title} | tags: ${(s.tags || []).join(", ")} | did: ${s.action} | result: ${s.result}`)
    .join("\n");

  const system = [
    "You are a live interview copilot whispering answers to a candidate who is speaking out loud right now.",
    "Write a concise, explanatory answer in natural first-person speech, suitable for saying aloud.",
    "Use one or two short paragraphs with complete sentences, explaining the reasoning and any relevant example.",
    "Return only the answer, without headings, bullets, numbered lists, or markdown.",
    "For technical or conceptual questions, answer and explain the actual question directly; do not force in a candidate story.",
    "For questions about experience, use candidate evidence only when relevant. Never invent employers, numbers or achievements that are not in the evidence.",
    "If the question is conversational (intro, why this role, weakness, salary, your questions for us), answer directly instead of reaching for a story.",
    "No preamble or commentary about the question.",
  ].join(" ");

  const parts = [
    `Role being interviewed for: ${role || "unknown"}`,
    `Candidate evidence:\n${evidence || "(none provided - give a generic but usable structure)"}`,
    recent ? `What was just said, for context:\n${recent.slice(-1200)}` : "",
    `Interviewer just asked: ${question}`,
  ].filter(Boolean);

  return { system, user: parts.join("\n\n") };
}

function parseAnswer(text) {
  const answer = String(text || "").trim();
  if (!answer) throw new Error("empty response from the model");
  return { answer };
}

async function generateAnswer(key, models, payload) {
  const { system, user } = buildPrompt(payload);
  const candidates = [...new Set([models.textModel, ...(models.textModels || [])].filter(Boolean))].slice(0, 3);
  if (!candidates.length) throw new Error("no text model available on this key");
  let body;
  for (const [index, model] of candidates.entries()) {
    const res = await fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 600 },
      }),
    });
    body = await res.json().catch(() => ({}));
    if (res.ok) {
      models.textModel = model;
      break;
    }
    const message = body?.error?.message || `answer request failed (${res.status})`;
    const unavailable = res.status === 404 || /(?:model.*(?:no longer available|not available|not supported)|(?:no longer available|not available|not supported).*model)/i.test(message);
    const overloaded = res.status === 503;
    if ((!unavailable && !overloaded) || index === candidates.length - 1) {
      const guidance = overloaded ? " Gemini is temporarily overloaded; please try again shortly." : "";
      throw new Error(`${model}: ${message}${guidance}`);
    }
  }

  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) {
    const blocked = body?.promptFeedback?.blockReason;
    throw new Error(blocked ? `blocked: ${blocked}` : "empty response from the model");
  }
  return parseAnswer(text);
}

module.exports = {
  API,
  WS_BASE,
  keyFor,
  cleanName,
  pick,
  resolveModels,
  mintToken,
  buildPrompt,
  parseAnswer,
  generateAnswer,
};
