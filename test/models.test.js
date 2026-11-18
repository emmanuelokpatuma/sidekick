const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveModels, generateAnswer } = require("../lib/gemini");

const modelList = [
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.8-flash-image",
];
const modelResponse = () => Response.json({
  models: modelList.map((name) => ({ name: `models/${name}`, supportedGenerationMethods: ["generateContent"] })),
});
const answerResponse = () => Response.json({
  candidates: [{ content: { parts: [{ text: "An explanatory answer." }] } }],
});

test("prefers current text models instead of API listing order", async () => {
  const originalFetch = global.fetch;
  const previous = process.env.GEMINI_TEXT_MODEL;
  delete process.env.GEMINI_TEXT_MODEL;
  global.fetch = async () => modelResponse();
  try {
    const models = await resolveModels("ranking-test", true);
    assert.deepEqual(models.textModels, ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]);
    assert.equal(models.textModel, "gemini-3.8-flash");
  } finally {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.GEMINI_TEXT_MODEL;
    else process.env.GEMINI_TEXT_MODEL = previous;
  }
});

test("retries unavailable model and reports the model that succeeded", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return Response.json({ error: { message: "models/gemini-2.5-flash is no longer available to new users" } }, { status: 400 });
    return answerResponse();
  };
  try {
    const models = { textModel: "gemini-2.5-flash", textModels: ["gemini-2.5-flash", "gemini-3.5-flash-lite"] };
    const answer = await generateAnswer("test", models, { question: "What is IaC?" });
    assert.equal(answer.answer, "An explanatory answer.");
    assert.equal(models.textModel, "gemini-3.5-flash-lite");
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("does not retry unrelated errors or override a specified model", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "Quota exceeded" } }, { status: 429 });
  };
  try {
    await assert.rejects(generateAnswer("test", { textModel: "first", textModels: ["first", "second"] }, { question: "Hello" }), /Quota exceeded/);
    assert.equal(calls, 1);
    global.fetch = async () => {
      calls++;
      return Response.json({ error: { message: "Model no longer available" } }, { status: 404 });
    };
    await assert.rejects(generateAnswer("test", { textModel: "override", textModels: ["override"] }, { question: "Hello" }), /no longer available/);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("tries a different model when Gemini reports high demand", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) return Response.json({ error: { message: "The model is overloaded. Please try again later." } }, { status: 503 });
    return answerResponse();
  };
  try {
    const models = { textModel: "first", textModels: ["first", "second"] };
    assert.equal((await generateAnswer("test", models, { question: "What is IaC?" })).answer, "An explanatory answer.");
    assert.equal(models.textModel, "second");
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reports the final overload without endlessly retrying", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "High demand" } }, { status: 503 });
  };
  try {
    await assert.rejects(
      generateAnswer("test", { textModel: "first", textModels: ["first", "second"] }, { question: "What is IaC?" }),
      /second: High demand.*try again shortly/
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
