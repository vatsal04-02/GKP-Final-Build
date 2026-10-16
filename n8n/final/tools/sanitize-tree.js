#!/usr/bin/env node
// Replaces private values in every text file under a directory, using a private map file that is NEVER committed.
//   node n8n/final/tools/sanitize-tree.js <dir> --map <file>
//   map file, one rule per line:   private value=>replacement       (blank lines and # comments are ignored)
// Prints how many files / replacements per rule (never the private value). Binary files are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--map');
const mapFile = args[args.indexOf('--map') + 1];
if (!dir || !mapFile) { console.error('usage: node sanitize-tree.js <dir> --map <file>'); process.exit(2); }
const rules = fs.readFileSync(mapFile, 'utf8').replace(/\r/g, '').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const i = l.indexOf('=>'); return [l.slice(0, i), l.slice(i + 2)]; });
const stats = rules.map(() => ({ files: 0, hits: 0 }));
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (/\.(png|jpe?g|webp|mp4|woff2?|ico|gif|pdf|zip)$/i.test(e.name)) continue;
    let t; try { t = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let out = t;
    rules.forEach(([from, to], i) => { const n = out.split(from).length - 1; if (n) { out = out.split(from).join(to); stats[i].files++; stats[i].hits += n; } });
    if (out !== t) fs.writeFileSync(p, out);
  }
};
walk(dir);
rules.forEach((r, i) => console.log(`rule ${i + 1}: ${stats[i].hits} replacement(s) in ${stats[i].files} file(s)`));
