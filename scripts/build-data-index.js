const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const outputPath = path.join(dataDir, 'index.json');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (/\.csv$/i.test(entry.name)) {
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      files.push(relativePath);
    }
  }
  return files;
}

const files = walk(dataDir).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' }));
const json = JSON.stringify({ files }, null, 2) + '\n';
fs.writeFileSync(outputPath, json, 'utf8');
console.log(`Wrote ${outputPath} with ${files.length} CSV file(s).`);
