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
const TEXT_PREFERENCE = [/^gemini-[\d.]+-flash$/i, /flash/i, /^gemini-[\d.]+-pro$/i, /pro/i];

const cleanName = (n) => String(n || "").replace(/^models\//, "");

function pick(candidates, preference) {
  for (const re of preference) {
    const hit = candidates.find((m) => re.test(m));
    if (hit) return hit;
  }
  return candidates[0] || "";
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
      .filter((n) => !/live|transcribe|native-audio/i.test(n));

    result.liveModel = envVar("GEMINI_LIVE_MODEL") || pick(live, LIVE_PREFERENCE);
    result.textModel = envVar("GEMINI_TEXT_MODEL") || pick(text, TEXT_PREFERENCE);
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
    "Return ONLY lines in this exact shape:",
    "HEADLINE: <3-6 words>",
    "- <bullet>",
    "- <bullet>",
    "3 to 5 bullets. Each bullet is at most 18 words, first person, speakable in one breath, no markdown.",
    "Use the candidate's evidence generously. Never invent employers, numbers or achievements that are not in the evidence.",
    "If the question is conversational (intro, why this role, weakness, salary, your questions for us), answer directly instead of reaching for a story.",
    "No preamble, no headings, no commentary about the question.",
  ].join(" ");

  const parts = [
    `Role being interviewed for: ${role || "unknown"}`,
    `Candidate evidence:\n${evidence || "(none provided - give a generic but usable structure)"}`,
    recent ? `What was just said, for context:\n${recent.slice(-1200)}` : "",
    `Interviewer just asked: ${question}`,
  ].filter(Boolean);

  return { system, user: parts.join("\n\n") };
}

const ANSWER_SCHEMA_HINT = /^headline:/i;

const MARKER = /^(?:[-*•\u2022]|\d+[.)])\s*/;

function parseAnswer(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let headline = "";
  const marked = [];
  const unmarked = [];

  for (const line of lines) {
    if (!headline && ANSWER_SCHEMA_HINT.test(line)) {
      headline = line.replace(ANSWER_SCHEMA_HINT, "").trim();
      continue;
    }
    const bullet = line.replace(/^[-*•\u2022\s]+/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (!bullet || bullet === headline) continue;
    (MARKER.test(line) ? marked : unmarked).push(bullet);
  }

  // Prefer explicit bullets; only fall back to bare lines if the model used no markers at all,
  // so stray commentary is not promoted into something you would read aloud.
  const bullets = marked.length ? marked : unmarked;

  return {
    headline: (headline || "Answer").slice(0, 80),
    bullets: bullets.slice(0, 5).map((b) => (b.length > 220 ? b.slice(0, 217) + "…" : b)),
  };
}

async function generateAnswer(key, models, payload) {
  const { system, user } = buildPrompt(payload);
  const res = await fetch(`${API}/models/${models.textModel}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 600, topP: 0.9 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `answer request failed (${res.status})`);

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
