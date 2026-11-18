const test = require("node:test");
const assert = require("node:assert/strict");

test("Netlify endpoints preserve the API contract", async () => {
  const { default: health } = await import("../netlify/functions/health.mjs");
  const { default: token } = await import("../netlify/functions/token.mjs");
  const { default: answer } = await import("../netlify/functions/answer.mjs");
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const check = await health(new Request("https://example.com/api/health"));
    assert.equal(check.status, 200);
    assert.equal(check.headers.get("cache-control"), "no-store");
    assert.equal((await check.json()).configured, false);

    const head = await health(new Request("https://example.com/api/health", { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    for (const endpoint of [token, answer]) {
      const response = await endpoint(new Request("https://example.com/api/test", { method: "POST" }));
      assert.equal(response.status, 401);
    }

    const wrongMethod = await token(new Request("https://example.com/api/token"));
    assert.equal(wrongMethod.status, 405);

    const missingQuestion = await answer(new Request("https://example.com/api/answer", {
      method: "POST",
      headers: { "x-gemini-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ question: "" }),
    }));
    assert.equal(missingQuestion.status, 400);
    assert.equal((await missingQuestion.json()).error, "question is required");

    const invalidJson = await answer(new Request("https://example.com/api/answer", {
      method: "POST",
      headers: { "x-gemini-key": "test-key", "content-type": "application/json" },
      body: "{",
    }));
    assert.equal(invalidJson.status, 502);
    assert.equal((await invalidJson.json()).error, "invalid JSON body");
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Netlify forwards the key and request body through the answer endpoint", async () => {
  const { default: answer } = await import("../netlify/functions/answer.mjs");
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/models?pageSize=")) {
      return Response.json({
        models: [{ name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] }],
      });
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: "I would start by listening to the team.\n\nThen I would use that context to choose the next step." }] } }],
    });
  };
  try {
    const response = await answer(new Request("https://example.com/api/answer", {
      method: "POST",
      headers: { "x-gemini-key": "adapter-test-key", "content-type": "application/json" },
      body: JSON.stringify({ question: "Why this role?" }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer, "I would start by listening to the team.\n\nThen I would use that context to choose the next step.");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers["x-goog-api-key"], "adapter-test-key");
    assert.match(calls[1].options.body, /Why this role\?/);
    assert.match(calls[1].options.body, /one or two short paragraphs/i);
  } finally {
    global.fetch = originalFetch;
  }
});
