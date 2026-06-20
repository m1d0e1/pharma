const fs = require('fs');
const path = require('path');

function walk(dir) {
  fs.readdirSync(dir).forEach(file => {
    const p = path.join(dir, file);
    if (fs.statSync(p).isDirectory()) {
      walk(p);
    } else if (p.endsWith('.tsx') || p.endsWith('.ts')) {
      let content = fs.readFileSync(p, 'utf8');
      if (content.includes('res.error')) {
        fs.writeFileSync(p, content.replace(/res\.error/g, '(res as any).error'));
      }
    }
  });
}

walk(path.join(__dirname, '../src/app/(dashboard)'));
console.log('Fixed res.error usages');
