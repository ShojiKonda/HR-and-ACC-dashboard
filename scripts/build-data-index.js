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
      if (!entry.name.startsWith(".")) {
        files.push(...walk(fullPath));
      }
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith("_merged.csv")
    ) {
      const relative = path.relative(root, fullPath).replace(/\\/g, "/");
      files.push(relative);
    }
  }

  return files;
}

if (!fs.existsSync(dataDir)) {
  console.error(`Data directory not found: ${dataDir}`);
  process.exit(1);
}

const files = walk(dataDir).sort();

const index = {
  generatedAt: new Date().toISOString(),
  format: "merged_1s",
  description: "Date, Timestamp, SensorID, HeartRate, AccNorm",
  includePattern: "*_merged.csv",
  files
};

fs.writeFileSync(outPath, JSON.stringify(index, null, 2), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`${files.length} merged CSV files indexed.`);
