const { keyFor, resolveModels, mintToken } = require("../lib/gemini");
const { json } = require("./_http");

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  try {
    const key = keyFor(req);
    if (!key) return json(res, 401, { error: "No Gemini API key set." });

    const models = await resolveModels(key);
    if (!models.liveModel) {
      return json(res, 502, { error: models.warning || "This key has no streaming audio model." });
    }

    return json(res, 200, await mintToken(key, models.liveModel));
  } catch (e) {
    return json(res, 502, { error: e.message || "token request failed" });
  }
};
