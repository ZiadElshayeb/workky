/**
 * Secret-leak check — scans dist/ for any secret patterns.
 * Run after `npm run build`:
 *   node scripts/check-leaks.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist");

// Patterns that should NEVER appear in the frontend bundle
const PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI keys
  /gsk_[A-Za-z0-9_-]{20,}/g, // Groq keys
  /OPENAI/gi,
  /VITE_LLM_API_KEY/g,
  /VITE_TTS_API_KEY/g,
  /VITE_STT_API_KEY/g,
  /VITE_AGORA_CUSTOMER_SECRET/g,
  /VITE_AGORA_CUSTOMER_ID/g,
  /api_key/gi, // generic check for embedded key fields
];

function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

if (!fs.existsSync(DIST)) {
  console.error("❌  dist/ folder not found. Run `npm run build` first.");
  process.exit(1);
}

let leaked = false;
const files = walk(DIST).filter((f) => /\.(js|html|css|json|map)$/.test(f));

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0; // reset regex state
    const matches = content.match(pattern);
    if (matches) {
      const rel = path.relative(DIST, file);
      console.error(`🚨  LEAK in ${rel}: matched ${pattern} → ${matches.join(", ")}`);
      leaked = true;
    }
  }
}

if (leaked) {
  console.error("\n❌  Secret leak detected in dist/ — DO NOT DEPLOY.");
  process.exit(1);
} else {
  console.log("✅  No secrets found in dist/ — safe to deploy.");
}
