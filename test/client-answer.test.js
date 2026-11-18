const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function client(fetch) {
  const elements = new Map();
  function element() {
    return {
      textContent: "", style: {}, children: [],
      set innerHTML(value) { this.children = []; this.html = value; },
      get innerHTML() { return this.html || ""; },
      classList: { toggle() {}, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); },
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element,
    createTextNode: (text) => ({ textContent: text }),
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8")
    .split("/* ---------- wiring ---------- */")[0];
  const context = vm.createContext({ document, fetch, localStorage: { getItem: () => null }, setInterval, clearInterval, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { context, elements };
}

test("unconnected typed questions show connection guidance, not a sample story", async () => {
  const { context, elements } = client(() => { throw new Error("unexpected request"); });
  vm.runInContext('state.stories = parseStories(DEFAULT_STORIES); state.mode = "typed"; state.running = true;', context);
  await vm.runInContext('finalizeQuestion("What is infrastructure as code?", Date.now())', context);
  assert.match(elements.get("answer").children[0].textContent, /Gemini not connected/);
  assert.doesNotMatch(elements.get("answer").children[0].textContent, /Kafka/i);
});

test("Gemini errors are shown without falling back to a sample story", async () => {
  const { context, elements } = client(async () => ({
    ok: false,
    status: 502,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ error: "quota exceeded" }),
  }));
  vm.runInContext('state.stories = parseStories(DEFAULT_STORIES); state.mode = "typed"; state.running = true; health.configured = true;', context);
  await vm.runInContext('finalizeQuestion("What is infrastructure as code?", Date.now())', context);
  assert.match(elements.get("answer").children[0].textContent, /quota exceeded/);
  assert.match(elements.get("ovFoot").textContent, /quota exceeded/);
});

test("demo story selection does not default to the first unrelated story", () => {
  const { context } = client(() => {});
  const story = vm.runInContext('state.stories = parseStories(DEFAULT_STORIES); bestStory(tokenize("What is a database?"), "What is a database?")', context);
  assert.equal(story, null);
});

test("Gemini answer is rendered as explanatory text", async () => {
  const { context, elements } = client(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ answer: "Infrastructure as code manages infrastructure using definitions in files.", model: "test-model" }),
  }));
  vm.runInContext('state.mode = "typed"; state.running = true; health.configured = true;', context);
  await vm.runInContext('finalizeQuestion("What is infrastructure as code?", Date.now())', context);
  assert.match(elements.get("answer").children[0].textContent, /manages infrastructure/);
  assert.equal(elements.get("latency").textContent.startsWith("test-model"), true);
});

test("HTML error responses show HTTP status instead of a JSON parser error", async () => {
  const { context, elements } = client(async () => ({
    ok: false,
    status: 504,
    redirected: false,
    headers: new Headers({ "content-type": "text/html" }),
  }));
  vm.runInContext('state.mode = "typed"; state.running = true; health.configured = true;', context);
  await vm.runInContext('finalizeQuestion("What is infrastructure as code?", Date.now())', context);
  assert.match(elements.get("answer").children[0].textContent, /server timed out \(HTTP 504\)/);
});

test("HTML sign-in responses provide access guidance", async () => {
  const { context, elements } = client(async () => ({
    ok: true,
    status: 200,
    redirected: true,
    headers: new Headers({ "content-type": "text/html" }),
  }));
  vm.runInContext('state.mode = "typed"; state.running = true; health.configured = true;', context);
  await vm.runInContext('finalizeQuestion("Hello?", Date.now())', context);
  assert.match(elements.get("answer").children[0].textContent, /Sign in to Netlify/);
});
