const fs = require("fs");
const path = require("path");

const root = process.cwd();
const dataDir = path.join(root, "data");
const outPath = path.join(dataDir, "index.json");

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
      files.push(path.relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

const files = walk(dataDir).sort();
const index = {
  generatedAt: new Date().toISOString(),
  files
};
fs.writeFileSync(outPath, JSON.stringify(index, null, 2), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`${files.length} CSV files indexed.`);
