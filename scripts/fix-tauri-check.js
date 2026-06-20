const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      results.push(file);
    }
  });
  return results;
}

const files = walk('./src');
let changedCount = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  const original = content;

  // Replace exact matches
  content = content.replace(/typeof window !== 'undefined' && \(window as any\)\.__TAURI__ !== undefined/g, "typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined)");
  
  content = content.replace(/typeof window !== 'undefined' && \(window as any\)\.__TAURI__/g, "typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__)");

  if (content !== original) {
    fs.writeFileSync(file, content);
    console.log('Fixed:', file);
    changedCount++;
  }
}
console.log('Total fixed:', changedCount);
