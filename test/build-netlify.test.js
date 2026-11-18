const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("build removes cached Netlify config but rejects unexpected publish files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-build-test-"));
  try {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.copyFileSync(path.join(__dirname, "..", "scripts", "build-netlify.js"), path.join(root, "scripts", "build-netlify.js"));
    for (const file of ["index.html", "app.js", "styles.css"]) fs.writeFileSync(path.join(root, file), file);
    fs.writeFileSync(path.join(root, "dist", "netlify.toml"), "cached configuration");
    const build = () => spawnSync(process.execPath, [path.join(root, "scripts", "build-netlify.js")], { encoding: "utf8" });
    assert.equal(build().status, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, "dist")).sort(), ["app.js", "index.html", "styles.css"]);
    fs.writeFileSync(path.join(root, "dist", "unexpected.txt"), "not for publishing");
    const failed = build();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Unexpected file in Netlify publish directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
