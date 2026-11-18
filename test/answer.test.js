const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPrompt, parseAnswer } = require("../lib/gemini");

test("asks for explanatory speech grounded in candidate evidence", () => {
  const prompt = buildPrompt({
    question: "Why this role?",
    role: "Engineer",
    stories: [{ title: "Project", tags: ["teamwork"], action: "I helped", result: "We shipped" }],
  });
  assert.match(prompt.system, /explanatory answer/i);
  assert.match(prompt.system, /without headings, bullets/i);
  assert.match(prompt.system, /never invent/i);
  assert.match(prompt.system, /technical or conceptual questions/i);
  assert.match(prompt.system, /do not force in a candidate story/i);
  assert.match(prompt.user, /Project/);
});

test("preserves complete multi-paragraph answers without truncation", () => {
  const text = "First paragraph. " + "A".repeat(300) + "\n\nSecond paragraph.";
  assert.deepEqual(parseAnswer(text), { answer: text });
  assert.throws(() => parseAnswer("  "), /empty response/);
});
