const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../src/app/actions-client');
const dest = path.join(__dirname, '../src/app/actions');

if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

fs.readdirSync(src).forEach(file => {
  if (file.endsWith('.ts')) {
    let content = fs.readFileSync(path.join(src, file), 'utf8');
    if (!content.includes("'use server';") && !content.includes('"use server";')) {
      content = "'use server';\n\n" + content;
    }
    fs.writeFileSync(path.join(dest, file), content);
  }
});
console.log('Synced actions-client to actions with use server');
