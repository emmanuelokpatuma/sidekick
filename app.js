/* Sidekick — interview copilot MVP.
 *
 * Two answer engines behind one interface:
 *   gemini  — real: mic -> PCM16 16k -> Gemini Live (WebSocket) -> streaming
 *             transcript -> question detection -> Gemini text call -> bullets.
 *   local   — offline fallback so the page is never dead without a key.
 *
 * Pipeline is the product. The only fake part left is that audio comes from your
 * mic instead of the interviewer's system audio, which is a desktop concern.
 */

const $ = (id) => document.getElementById(id);

const DEFAULT_ROLE = "Senior Backend Engineer — cloud platform team (fintech)";

const DEFAULT_STORIES = `Cut ingest p99 from 1.8s to 240ms | performance, scale, kafka, latency | Rewrote the Kafka consumer to commit in batches and added a shared cache for hot keys | p99 down 70%, 3x throughput on the same nodes
Migrated 40 services to Kubernetes with no downtime | devops, kubernetes, migration, reliability | Ran it as a parallel-run, one team at a time, with a rollback switch behind a flag | Zero customer-visible downtime across nine months
Ran a payment outage at 2am | incident, outage, on-call, pressure, debugging | Split the team into parallel hypotheses, killed the noisy deploy, rebuilt the dead-letter replay | Checkout back in 41 minutes, then the runbook that halved our MTTR
Pushed back on a staff engineer's rewrite | conflict, disagreement, stakeholder, influence, teamwork | Wrote a two-page options doc covering cost and risk, then proposed a staged slice we could both live with | Killed a 6-month rewrite, shipped the fix in 3 weeks
Shipped a feature nobody used | failure, mistake, learned, product | Ran 12 user interviews after launch and found the core workflow assumption was wrong | Killed it in 5 weeks; now every roadmap item starts with five user calls
Mentored two juniors to promotion | mentorship, leadership, growth, coaching | Ran weekly design reviews and handed each of them a service to own | Both promoted inside a year, one now runs the on-call rotation`;

const STOPWORDS = new Set(
  "a an and the to of for in on at is are was were be been being do does did done you your yours i my me we our us they them it this that these those what how why when where which who can could would should will shall may might must tell about give example describe some any please just really very so like have has had with as from by if but or not".split(" ")
);

const INTENT_TAGS = [
  { tags: ["failure", "mistake", "learned"], re: /\b(fail|failed|failure|mistake|wrong|regret|went badly|didn'?t go well|weakness)\b/i },
  { tags: ["conflict", "disagreement", "stakeholder"], re: /\b(conflict|disagree|disagreement|difficult (person|colleague|teammate|stakeholder|client)|push ?back|tension|influence)\b/i },
  { tags: ["incident", "outage"], re: /\b(outage|incident|on ?call|production (went )?down|pressure|emergency|broke)\b/i },
  { tags: ["performance", "scale", "latency"], re: /\b(scale|scalab|latency|performance|throughput|load|slow|fast|optimi[sz]e)\b/i },
  { tags: ["migration", "kubernetes", "devops"], re: /\b(migrat|kubernetes|k8s|cloud|infra|platform|devops|infrastructure|deploy)\b/i },
  { tags: ["mentorship", "leadership"], re: /\b(mentor|coach|junior|grow|lead|manage|team)\b/i },
];

/* ---------- state ---------- */

const state = {
  role: DEFAULT_ROLE,
  stories: [],
  mode: "idle", // idle | demo | mic | gemini
  running: false,
  cancelled: false,
  buffer: "",
  interim: "",
  silenceTimer: null,
  clockTimer: null,
  startedAt: 0,
  recognition: null,
  // gemini
  ws: null,
  audioCtx: null,
  mediaStream: null,
  processor: null,
  sourceNode: null,
  sinkNode: null,
  pendingAnswer: false,
  lastAnswerAt: 0,
};

let health = { configured: false, liveModel: "", textModel: "", warning: "" };

/* ---------- profile ---------- */

function parseStories(text) {
  return text
    .split("\n")
    .map((line) => line.split("|").map((p) => p.trim()))
    .filter((parts) => parts.length >= 3 && parts[0])
    .map((parts) => ({
      title: parts[0],
      tags: (parts[1] || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean),
      action: parts[2],
      result: parts[3] || "",
    }));
}

function loadProfile() {
  let role = DEFAULT_ROLE;
  let stories = DEFAULT_STORIES;
  try {
    const saved = JSON.parse(localStorage.getItem("sidekick.profile") || "null");
    if (saved && saved.role && saved.stories) {
      role = saved.role;
      stories = saved.stories;
    }
  } catch (e) { /* first run */ }
  $("role").value = role;
  $("stories").value = stories;
  applyProfile();
}

function applyProfile() {
  state.role = $("role").value.trim() || DEFAULT_ROLE;
  state.stories = parseStories($("stories").value);
}

/* ---------- local answer composer ----------
   The offline stand-in for the LLM. Same contract: question + context in, bullets out. */

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9.+#]+/g) || []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreStory(story, tokens) {
  const haystack = (story.title + " " + story.action + " " + story.result + " " + story.tags.join(" ")).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (story.tags.includes(t)) score += 4;
    else if (haystack.includes(t)) score += 2;
  }
  return score;
}

function bestStory(tokens, question) {
  if (!state.stories.length) return null;
  const boosted = state.stories.map((story) => {
    let score = scoreStory(story, tokens);
    for (const intent of INTENT_TAGS) {
      if (intent.re.test(question) && story.tags.some((t) => intent.tags.includes(t))) score += 7;
    }
    return { story, score };
  });
  boosted.sort((a, b) => b.score - a.score);
  return boosted[0].score > 0 ? boosted[0].story : state.stories[0];
}

function matchedTags(story, tokens) {
  if (!story) return [];
  return tokens.filter((t) => story.tags.includes(t)).slice(0, 3);
}

function composeAnswer(question) {
  const tokens = tokenize(question);
  const story = bestStory(tokens, question);
  const role = state.role;

  if (/\b(tell me about yourself|introduce yourself|walk me through your (background|cv|resume)|who are you)\b/i.test(question)) {
    const picks = state.stories.slice(0, 2).map((s) => s.title.toLowerCase());
    return {
      headline: "30-second intro",
      bullets: [
        `Interviewing for: ${role}.`,
        picks.length ? `Proof points: ${picks.join("; ")}.` : "Lead with the last two years of shipped work.",
        "Close on why this role: the scope is a step up, the domain is the one I've been building in.",
      ],
    };
  }

  if (/\bwhy (do you want|this (role|company|job)|are you (interested|leaving)|us)\b/i.test(question)) {
    return {
      headline: "Why this role",
      bullets: [
        `The role: ${role} — that's the exact work I've been doing and want more of.`,
        "The scope: ownership of the platform, not just tickets inside it.",
        "The honest bridge: what I want next is the thing this team is already doing.",
        "Ask them back: what does success look like at six months?",
      ],
    };
  }

  if (/\b(weakness|what are you (bad at|working on)|improve about yourself)\b/i.test(question)) {
    return {
      headline: "Weakness — real, plus the fix",
      bullets: [
        "I over-invest in the first design and under-invest in deleting scope.",
        "Evidence: the feature I shipped that nobody used — I built to my own assumption.",
        "What changed: five user calls before any roadmap item is written.",
        "Keep it to one weakness and land on the mechanism, not the apology.",
      ],
    };
  }

  if (/\b(salary|compensation|expectations|how much|package|pay)\b/i.test(question)) {
    return {
      headline: "Comp — bridge, don't anchor first",
      bullets: [
        "Glad to talk about it — what range is budgeted for this level?",
        "If pushed: give a band, based on market data for the level, not my current base.",
        "Trade the number for scope: level, ownership, review cycle.",
      ],
    };
  }

  if (/\b(any questions for (us|me)|questions for us|anything you('d| would) like to ask)\b/i.test(question)) {
    return {
      headline: "Your three questions",
      bullets: [
        "What does the first 90 days look like, and what would make you say it went well?",
        "Where does this team's pager fire most often right now?",
        "What's the thing you'd want changed about how the team works today?",
      ],
    };
  }

  if (!story) {
    return {
      headline: "Answer skeleton",
      bullets: [
        "Situation: one line of context, no history lesson.",
        "Action: what *you* did, first person, one or two moves.",
        "Result: a number if you have one, a change in behaviour if you don't.",
        "Add evidence in the context panel and this fills in properly.",
      ],
    };
  }

  const tags = matchedTags(story, tokens);
  const relevance = tags.length ? `Directly relevant: ${tags.join(", ")}.` : `Maps to ${role}.`;

  return {
    headline: story.title,
    bullets: [
      `Situation: ${story.title}.`,
      `What I did: ${story.action}.`,
      `Result: ${story.result || "shipped, measured, and it stuck"}.`,
      relevance,
    ],
  };
}

/* ---------- rendering ---------- */

function renderTranscript(finalText, interimText) {
  const el = $("transcript");
  el.innerHTML = "";
  if (!finalText && !interimText) {
    el.innerHTML = '<span class="placeholder">Press <em>Run demo</em> or <em>Use my mic</em>.</span>';
    return;
  }
  if (finalText) el.appendChild(document.createTextNode(finalText));
  if (interimText) {
    const span = document.createElement("span");
    span.className = "interim";
    span.textContent = (finalText ? " " : "") + interimText;
    el.appendChild(span);
  }
}

function renderThinking(label) {
  const el = $("answer");
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ans-head pending";
  head.textContent = label || "thinking…";
  el.appendChild(head);
}

function renderAnswer(answer) {
  const el = $("answer");
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "ans-head";
  head.textContent = answer.headline || "Answer";
  el.appendChild(head);

  const list = document.createElement("ul");
  list.className = "ans-list";
  (answer.bullets || []).forEach((text, i) => {
    const li = document.createElement("li");
    li.textContent = text;
    li.style.animationDelay = i * 70 + "ms";
    list.appendChild(li);
  });
  el.appendChild(list);
}

function clearAnswer() {
  $("answer").innerHTML = '<div class="placeholder">Bullets appear here.</div>';
  $("latency").textContent = "";
}

function setState(label, on) {
  $("ovState").textContent = label;
  $("liveBadge").classList.toggle("on", !!on);
  $("modePill").textContent = state.mode === "idle" ? "idle" : state.mode;
}

function setLevel(v) {
  const el = $("level");
  if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, v * 3.2))})`;
}

/* ---------- engine status ---------- */

function renderEngine() {
  const el = $("engine");
  if (!el) return;
  if (!health.configured) {
    el.innerHTML = health.warning
      ? `<span class="warn">Gemini not connected — ${escapeHtml(health.warning)}</span>`
      : '<span class="warn">Local composer — paste a Gemini key to switch the real thing on.</span>';
    $("micHint").textContent = "Without a key, Use my mic falls back to the browser's own speech recognition. Demo needs nothing.";
    return;
  }
  el.innerHTML = `Engine: <b>Gemini</b> · speech <span class="mono">${escapeHtml(health.liveModel)}</span> · answers <span class="mono">${escapeHtml(health.textModel)}</span>`;
  $("micHint").textContent = "Mic goes straight to Gemini Live. Speak, or type a question. Space = answer now.";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function apiKey() {
  try {
    return (localStorage.getItem("sidekick.key") || "").trim();
  } catch (e) {
    return "";
  }
}

function keyHeaders() {
  const key = apiKey();
  return key ? { "x-gemini-key": key } : {};
}

async function checkHealth() {
  try {
    const res = await fetch("api/health", { headers: keyHeaders(), cache: "no-store" });
    const body = await res.json();
    health = {
      configured: Boolean(body.configured),
      liveModel: body.liveModel || "",
      textModel: body.textModel || "",
      warning: body.warning || (body.configured ? "" : ""),
    };
  } catch (e) {
    health = { configured: false, liveModel: "", textModel: "", warning: "server not running" };
  }
  renderEngine();
}

/* ---------- the pipeline ---------- */

function startClock() {
  state.startedAt = Date.now();
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    $("ovClock").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 500);
}

function stopClock() {
  clearInterval(state.clockTimer);
  state.clockTimer = null;
}

/* Called the moment a question is judged finished. Asks whichever engine is live,
   then paints and times it. */
async function finalizeQuestion(text, detectedAt) {
  const question = String(text || "").trim();
  if (!question) return;
  renderTranscript(question, "");
  state.pendingAnswer = true;
  state.lastAnswerAt = Date.now();
  setState("thinking", true);

  const started = Date.now();
  let answer = null;
  let engineName = "local";

  if (health.configured && apiKeyWanted()) {
    renderThinking("Gemini is writing…");
    try {
      const res = await fetch("api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...keyHeaders() },
        body: JSON.stringify({ question, role: state.role, stories: state.stories }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "answer failed");
      answer = { headline: body.headline, bullets: body.bullets };
      engineName = body.model || "gemini";
    } catch (e) {
      $("ovFoot").textContent = "Gemini error: " + e.message + " — showed a local answer instead";
      answer = composeAnswer(question);
    }
  } else {
    answer = composeAnswer(question);
  }

  if (state.cancelled && state.mode === "idle") return;

  renderAnswer(answer);
  const ms = Date.now() - started;
  $("latency").textContent = `${engineName === "local" ? "local" : engineName} · ${ms} ms`;
  if (detectedAt) $("ovFoot").textContent = `detected → bullets in ${Date.now() - detectedAt} ms`;
  state.buffer = "";
  state.interim = "";
  state.pendingAnswer = false;

  if (state.running) setState(state.mode === "gemini" ? "listening" : "listening", true);
}

// Use Gemini whenever it is configured; the local composer is only the fallback.
function apiKeyWanted() {
  return health.configured;
}

function askImmediately(text) {
  if (!String(text || "").trim()) return;
  clearTimeout(state.silenceTimer);
  finalizeQuestion(text, Date.now());
}

/* ---------- demo mode ---------- */

const DEMO_SCRIPT = [
  "So, maybe start by telling me a bit about yourself and what you're doing right now.",
  "Tell me about a time you had to handle a production issue under real pressure.",
  "What's a piece of work you're not proud of? Something that didn't land.",
  "Have you ever had a strong disagreement with another engineer about technical direction?",
  "Why do you want this role, out of everything you could be doing?",
  "Alright, I think that's enough from me — any questions for us?",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function typeQuestion(text) {
  const el = $("transcript");
  el.innerHTML = "";
  let shown = "";
  for (const char of text) {
    if (state.cancelled) return;
    shown += char;
    el.textContent = shown;
    await sleep(/[,.?]/.test(char) ? 95 : 20);
  }
}

async function runDemo() {
  applyProfile();
  stopAll(true);
  state.mode = "demo";
  state.running = true;
  state.cancelled = false;
  $("demo").disabled = true;
  $("mic").disabled = true;
  $("stop").disabled = false;
  setState("listening", true);
  startClock();

  for (const question of DEMO_SCRIPT) {
    if (state.cancelled) break;
    clearAnswer();
    await typeQuestion(question);
    if (state.cancelled) break;
    const detectedAt = Date.now();
    await finalizeQuestion(question, detectedAt);
    if (state.cancelled) break;
    await sleep(2800);
  }

  stopAll(false);
}

/* ---------- mic: real Gemini Live path ---------- */

function floatToBase64Pcm16(input, inRate) {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const outLength = ratio > 1 ? Math.floor(input.length / ratio) : input.length;
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sample;
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      sample = sum / Math.max(1, end - start);
    } else {
      sample = input[i];
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  let binary = "";
  const bytes = new Uint8Array(out.buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function startGeminiMic() {
  stopAll(true);
  applyProfile();

  state.mode = "gemini";
  state.running = true;
  state.cancelled = false;
  state.buffer = "";
  $("demo").disabled = true;
  $("mic").disabled = true;
  $("stop").disabled = false;
  clearAnswer();
  startClock();
  setState("connecting", true);
  $("ovFoot").textContent = "requesting a short-lived token…";

  let minted;
  try {
    const res = await fetch("api/token", { method: "POST", headers: keyHeaders() });
    minted = await res.json();
    if (!res.ok) throw new Error(minted.error || "token request failed");
  } catch (e) {
    $("micHint").textContent = "Couldn't start Gemini: " + e.message;
    $("micHint").classList.add("good");
    stopAll(false);
    return;
  }
  if (state.cancelled) return;

  $("ovFoot").textContent = "opening the audio stream…";
  const isTranscriber = /transcribe/i.test(minted.model || "");
  const setup = {
    setup: {
      model: "models/" + minted.model,
      inputAudioTranscription: {},
    },
  };
  if (!isTranscriber) {
    // A general live model will try to answer out loud; make it a silent transcriber.
    setup.setup.generationConfig = { responseModalities: ["TEXT"], temperature: 0 };
    setup.setup.systemInstruction = {
      parts: [{ text: "You are a silent transcription engine. Never respond, never answer questions, only transcribe the speech you hear." }],
    };
  }

  // Token must go in unencoded: the "auth_tokens/..." slash has to survive.
  const ws = new WebSocket(minted.wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify(setup));
    $("ovFoot").textContent = "connecting the microphone…";
  };

  ws.onmessage = async (event) => {
    let text = event.data;
    if (typeof text !== "string") {
      try {
        text = await (event.data instanceof Blob ? event.data.text() : new Response(event.data).text());
      } catch (e) {
        return;
      }
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return;
    }
    handleLiveMessage(msg);
  };

  ws.onerror = () => {
    $("ovFoot").textContent = "stream error — check the key and that this model serves live audio";
  };

  ws.onclose = (event) => {
    if (state.cancelled) return;
    const reasons = {
      1000: "stream closed",
      1007: "the API rejected the audio format",
      1008: "the token expired or was already used",
      1011: "the model closed the stream",
    };
    $("micHint").textContent = `Gemini stream ended (${event.code} ${reasons[event.code] || ""}). Press Use my mic again.`;
    stopAll(false);
  };
}

function handleLiveMessage(msg) {
  if (msg.setupComplete) {
    setState("listening", true);
    $("ovFoot").textContent = "listening — Gemini is transcribing as you speak";
    startMicCapture().catch((e) => {
      $("micHint").textContent = "Mic failed: " + e.message;
      stopAll(false);
    });
    return;
  }

  if (msg.goAway) {
    $("ovFoot").textContent = "session time limit reached — press Use my mic to start a fresh stream";
    return;
  }

  const content = msg.serverContent;
  if (!content) return;

  if (content.inputTranscription && content.inputTranscription.text) {
    const piece = content.inputTranscription.text;
    state.buffer = (state.buffer + " " + piece).replace(/\s+/g, " ").trim();
    renderTranscript(state.buffer, "");
    resetSilenceTimer();
  }

  if (content.turnComplete) {
    if (state.buffer.trim() && !state.pendingAnswer) {
      clearTimeout(state.silenceTimer);
      finalizeQuestion(state.buffer, Date.now());
    }
  }
}

function resetSilenceTimer() {
  clearTimeout(state.silenceTimer);
  if (!state.buffer.trim() || state.pendingAnswer) return;
  state.silenceTimer = setTimeout(() => {
    if (!state.buffer.trim() || state.pendingAnswer) return;
    finalizeQuestion(state.buffer, Date.now());
  }, 1100);
}

async function startMicCapture() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  state.mediaStream = stream;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  state.audioCtx = ctx;
  if (ctx.state === "suspended") await ctx.resume();

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph running without playing the mic back

  state.sourceNode = source;
  state.processor = processor;
  state.sinkNode = sink;

  let lastSend = 0;
  processor.onaudioprocess = (event) => {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const data = event.inputBuffer.getChannelData(0);

    let sum = 0;
    for (let i = 0; i < data.length; i += 16) sum += data[i] * data[i];
    setLevel(Math.sqrt(sum / (data.length / 16)));

    const now = performance.now();
    if (now - lastSend < 80) return;
    lastSend = now;

    const payload = floatToBase64Pcm16(data, ctx.sampleRate);
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: payload, mimeType: "audio/pcm;rate=16000" } } }));
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  $("ovFoot").textContent = "listening — speak, or press space to answer now";
}

/* ---------- mic: browser speech fallback (no key) ---------- */

function startBrowserMic() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("micHint").textContent = "This browser has no speech recognition — use Chrome, or run the demo.";
    $("micHint").classList.add("good");
    return;
  }

  stopAll(true);
  applyProfile();
  state.mode = "mic";
  state.running = true;
  state.cancelled = false;
  state.buffer = "";
  $("demo").disabled = true;
  $("mic").disabled = true;
  $("stop").disabled = false;
  clearAnswer();
  startClock();

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  state.recognition = rec;

  rec.onstart = () => setState("listening", true);

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) state.buffer += " " + res[0].transcript.trim();
      else interim += res[0].transcript;
    }
    state.interim = interim;
    renderTranscript(state.buffer.trim(), interim);
    resetSilenceTimer();
  };

  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      $("micHint").textContent = "Mic permission was blocked. Allow it in the address bar, or use the demo.";
      $("micHint").classList.add("good");
      stopAll(true);
    }
  };

  rec.onend = () => {
    if (state.running && !state.cancelled) {
      try { rec.start(); } catch (e) { /* already restarted */ }
    }
  };

  try {
    rec.start();
  } catch (e) {
    $("micHint").textContent = "Couldn't start the mic: " + e.message;
  }
}

function startMic() {
  $("micHint").classList.remove("good");
  if (health.configured) startGeminiMic();
  else startBrowserMic();
}

/* ---------- lifecycle ---------- */

function stopAll(silent) {
  state.cancelled = true;
  state.running = false;
  state.pendingAnswer = false;
  clearTimeout(state.silenceTimer);

  if (state.recognition) {
    try { state.recognition.onend = null; state.recognition.stop(); } catch (e) { /* ignore */ }
    state.recognition = null;
  }
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch (e) { /* ignore */ }
    state.ws = null;
  }
  if (state.processor) {
    try { state.processor.disconnect(); state.processor.onaudioprocess = null; } catch (e) { /* ignore */ }
    state.processor = null;
  }
  if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch (e) { /* ignore */ } state.sourceNode = null; }
  if (state.sinkNode) { try { state.sinkNode.disconnect(); } catch (e) { /* ignore */ } state.sinkNode = null; }
  if (state.audioCtx) { try { state.audioCtx.close(); } catch (e) { /* ignore */ } state.audioCtx = null; }
  if (state.mediaStream) {
    try { state.mediaStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    state.mediaStream = null;
  }

  $("demo").disabled = false;
  $("mic").disabled = false;
  $("stop").disabled = true;
  state.buffer = "";
  state.interim = "";
  setLevel(0);

  if (!silent) {
    stopClock();
    state.mode = "idle";
    setState("standby", false);
    $("ovFoot").textContent = "detection: 1.1s silence  ·  space = answer now";
  } else {
    state.mode = "idle";
  }
}

/* ---------- wiring ---------- */

loadProfile();
renderTranscript("", "");
clearAnswer();
setState("standby", false);

(async () => {
  const saved = apiKey();
  if (saved) $("key").value = saved;
  await checkHealth();
})();

$("save").addEventListener("click", async () => {
  applyProfile();
  try {
    localStorage.setItem("sidekick.profile", JSON.stringify({ role: $("role").value, stories: $("stories").value }));
    $("saveHint").textContent = "Saved. " + state.stories.length + " evidence lines loaded.";
    $("saveHint").classList.add("good");
  } catch (e) {
    $("saveHint").textContent = "Couldn't save locally, but the context is loaded for this session.";
  }
});

$("reset").addEventListener("click", () => {
  $("role").value = DEFAULT_ROLE;
  $("stories").value = DEFAULT_STORIES;
  applyProfile();
  $("saveHint").textContent = "Example context restored.";
});

async function connectKey(value, fromClipboard) {
  value = (value || "").trim();
  try {
    if (value) localStorage.setItem("sidekick.key", value);
    else localStorage.removeItem("sidekick.key");
  } catch (e) { /* ignore */ }
  $("key").value = value;
  $("keyHint").classList.remove("good");
  if (!value) {
    $("keyHint").textContent = "Key cleared. The server's own GEMINI_API_KEY is used, if it has one.";
    await checkHealth();
    return;
  }
  $("keyHint").textContent = "Checking the key…";
  await checkHealth();
  if (health.configured) {
    $("keyHint").textContent = `Connected. Speech: ${health.liveModel} · Answers: ${health.textModel}`;
    $("keyHint").classList.add("good");
    return;
  }
  $("keyHint").textContent =
    (fromClipboard ? "Pasted, but that key didn't work: " : "That key didn't work: ") +
    (health.warning || "no models returned");
}

$("keySave").addEventListener("click", () => connectKey($("key").value));

$("key").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    connectKey($("key").value);
  }
});

$("keyPaste").addEventListener("click", async () => {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    $("keyHint").textContent = "This browser blocked clipboard access — click the field and press Ctrl+V (⌘V on Mac), then Connect.";
    $("key").focus();
    return;
  }
  text = (text || "").replace(/\s+/g, "");
  if (!text) {
    $("keyHint").textContent = "Nothing on the clipboard yet — copy the key in Google AI Studio first.";
    return;
  }
  await connectKey(text, true);
});

$("demo").addEventListener("click", runDemo);
$("mic").addEventListener("click", startMic);
$("stop").addEventListener("click", () => stopAll(false));

$("askForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("ask").value;
  if (!value.trim()) return;
  $("ask").value = "";
  applyProfile();
  if (!state.running) {
    startClock();
    state.running = true;
    setState("typed", true);
    $("modePill").textContent = "typed";
  }
  clearTimeout(state.silenceTimer);
  finalizeQuestion(value, Date.now());
});

// Space = "answer now", the fallback every product in this category needs.
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (!state.running) return;
  e.preventDefault();
  const text = state.buffer || state.interim;
  if (text.trim() && !state.pendingAnswer) askImmediately(text);
});

window.addEventListener("beforeunload", () => stopAll(true));
