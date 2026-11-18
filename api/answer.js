const { keyFor, resolveModels, generateAnswer } = require("../lib/gemini");
const { json, readJson } = require("./_http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  try {
    const key = keyFor(req);
    if (!key) return json(res, 401, { error: "No Gemini API key set." });

    const body = await readJson(req);
    if (!body.question || !String(body.question).trim()) {
      return json(res, 400, { error: "question is required" });
    }

    const models = await resolveModels(key);
    if (!models.textModel) {
      return json(res, 502, { error: models.warning || "This key has no text model." });
    }

    const started = Date.now();
    const answer = await generateAnswer(key, models, body);
    return json(res, 200, { ...answer, model: models.textModel, ms: Date.now() - started });
  } catch (e) {
    return json(res, 502, { error: e.message || "answer request failed" });
  }
};
