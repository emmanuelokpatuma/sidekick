const { copyFileSync, mkdirSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const destination = join(root, "dist");
mkdirSync(destination, { recursive: true });
const files = ["index.html", "app.js", "styles.css"];
for (const existing of readdirSync(destination)) {
  if (!files.includes(existing)) {
    throw new Error(`Unexpected file in Netlify publish directory: ${existing}`);
  }
}
for (const file of files) {
  copyFileSync(join(root, file), join(destination, file));
}
