const { copyFileSync, mkdirSync, readdirSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const destination = join(root, "dist");
mkdirSync(destination, { recursive: true });
const files = ["index.html", "app.js", "styles.css"];
for (const existing of readdirSync(destination)) {
  if (existing === "netlify.toml") {
    unlinkSync(join(destination, existing));
    continue;
  }
  if (!files.includes(existing)) {
    throw new Error(`Unexpected file in Netlify publish directory: ${existing}`);
  }
}
for (const file of files) {
  copyFileSync(join(root, file), join(destination, file));
}
