const { keyFor, resolveModels } = require("../lib/gemini");
const { json } = require("./_http");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { error: "method not allowed" });
  }

  const key = keyFor(req);
  if (!key) {
    return json(res, 200, {
      configured: false,
      liveModel: "",
      textModel: "",
      message: "No API key yet.",
    });
  }

  try {
    const models = await resolveModels(key);
    return json(res, 200, {
      configured: Boolean(models.textModel),
      liveModel: models.liveModel,
      textModel: models.textModel,
      warning: models.warning,
    });
  } catch (e) {
    return json(res, 502, { error: e.message || "health check failed" });
  }
};
