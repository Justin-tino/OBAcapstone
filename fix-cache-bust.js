/**
 * fix-cache-bust.js — Bump the /js/app.js script URL across all views.
 * Adds ?v=N so browsers drop any stale cached copy of the shared script
 * (old copies were cached without no-cache headers).
 * Usage: node fix-cache-bust.js  [version]
 */
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || '2';
const viewsDir = path.join(__dirname, 'views');

function walkDir(dir) {
  fs.readdirSync(dir).forEach((name) => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return walkDir(filePath);
    if (!filePath.endsWith('.html')) return;

    let content = fs.readFileSync(filePath, 'utf8');
    // Replace plain /js/app.js (with or without an existing ?v=) with the new version
    const updated = content.replace(
      /(<script\s+src="\/js\/app\.js)(\?v=\d+)?(">)/g,
      `$1?v=${version}$3`
    );
    if (updated !== content) {
      fs.writeFileSync(filePath, updated, 'utf8');
      console.log('Updated:', path.relative(__dirname, filePath));
    }
  });
}

walkDir(viewsDir);
console.log(`Done — app.js script tags now point to /js/app.js?v=${version}`);