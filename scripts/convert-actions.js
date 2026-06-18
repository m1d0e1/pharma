const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '../src/app/actions');
const targetDir = path.join(__dirname, '../src/app/actions-client');

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.ts'));

console.log(`Found ${files.length} action files to convert.`);

files.forEach(file => {
  const srcPath = path.join(sourceDir, file);
  const destPath = path.join(targetDir, file);
  let content = fs.readFileSync(srcPath, 'utf8');

  // 1. Remove 'use server'
  content = content.replace(/'use server';?/g, '');
  content = content.replace(/"use server";?/g, '');

  // 2. Mock next/cache revalidatePath and unstable_cache
  content = content.replace(
    /import\s+{[^}]+}\s+from\s+'next\/cache';?/g,
    'const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;'
  );
  content = content.replace(
    /import\s+{[^}]+}\s+from\s+"next\/cache";?/g,
    'const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;'
  );

  // 3. Remove any db/local imports
  content = content.replace(/import\s+[^\n]*?\s+from\s+['"][^\n]*?db\/local['"];?/g, '');

  // 4. Define db proxy wrapper, dbSelect/dbGet/dbExecute/dbTransaction imports, and local mocks
  const dbProxy = `
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
  }
};

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};
`;

  // Prepend to content
  content = dbProxy + '\n' + content;

  // 5. Prepend await to db operations
  content = content.replace(
    /const\s+returnsWithItems\s*=\s*returns\.map\(\s*ret\s*=>\s*{([\s\S]*?)}\);/g,
    'const returnsWithItems = await Promise.all(returns.map(async ret => {$1}));'
  );
  content = content.replace(/(?<!await\s+)db\.prepare\(((?:(?!db\.prepare)[\s\S])*?)\)\s*\.\s*(run|get|all)\s*\(/g, 'await db.prepare($1).$2(');
  content = content.replace(/(?<!await\s+)db\.exec\(/g, 'await db.exec(');
  
  // Wrap chained property access on run/get/all in parentheses with await (e.g. (await accStmt.run()).lastInsertRowid)
  content = content.replace(/([a-zA-Z0-9_]+)\s*\.\s*(run|get|all)\s*\(([^;{}]*?)\)\s*\.\s*(lastInsertRowid|changes)/g, '(await $1.$2($3)).$4');

  // Prepend await to any statement execution run/all/get calls (e.g. await stmt.run())
  content = content.replace(/(?<!await\s+)(?<!db\.)\b([a-zA-Z0-9_]+)\s*\.\s*(run|all|get)\s*\(/g, 'await $1.$2(');

  // Convert transaction callbacks to async
  content = content.replace(/db\.transaction\(\s*\(/g, 'db.transaction(async (');

  // Convert local helper functions to async and await their calls
  content = content.replace(/(const|let)\s+(getAccount(?:Id)?)\s*=\s*\(/g, '$1 $2 = async (');
  content = content.replace(/(?<!await\s+)\b(getAccount(?:Id)?)\s*\(/g, 'await $1(');
  content = content.replace(/function\s+getDbIngredients\s*\(/g, 'async function getDbIngredients(');
  content = content.replace(/(?<!await\s+|function\s+)\bgetDbIngredients\s*\(/g, 'await getDbIngredients(');

  // Prepend await to transaction executions (excluding db.transaction)
  content = content.replace(/(?<!await\s+|db\.)([a-zA-Z0-9_]*transaction)\s*\(/g, 'await $1(');

  // Fix potential double awaits e.g. await await
  content = content.replace(/await\s+await/g, 'await');

  // 6. Handle bcryptjs dynamic imports on client
  content = content.replace(
    /const\s+bcrypt\s*=\s*await\s+import\(['"]bcryptjs['"]\);?/g,
    `const bcrypt = {
      hash: async (pw: any, ...args: any[]) => {
        const { hashPassword } = require('@/lib/auth/local');
        return await hashPassword(pw);
      },
      compare: async (pw, hash) => {
        const { verifyPassword } = require('@/lib/auth/local');
        return await verifyPassword(pw, hash);
      }
    };`
  );

  // 7. Fix next/navigation imports (e.g. redirect) if they run client-side
  content = content.replace(
    /import\s+{[^}]+}\s+from\s+['"]next\/navigation['"];?/g,
    `import { useRouter } from 'next/navigation';
const redirect = (path) => {
  if (typeof window !== 'undefined') {
    window.location.href = path;
  }
};`
  );

  // 8. Fix crypto.randomUUID
  content = content.replace(/crypto\.randomUUID\(\)/g, "require('uuid').v4()");
  content = content.replace(/randomUUID\(\)/g, "require('uuid').v4()");

  fs.writeFileSync(destPath, content, 'utf8');
  console.log(`Converted: ${file}`);
});

console.log('Conversion complete!');
