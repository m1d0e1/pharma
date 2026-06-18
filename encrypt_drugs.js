const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'com.pharma.system', 'pharma_local.db');
const db = new Database(dbPath, { readonly: true });

console.log('Extracting drugs...');
const masterDrugs = db.prepare('SELECT * FROM master_drugs').all();
console.log(`Found ${masterDrugs.length} drugs.`);

console.log('Extracting interactions...');
const interactions = db.prepare('SELECT * FROM drug_interactions').all();

const payload = JSON.stringify({
  master_drugs: masterDrugs,
  drug_interactions: interactions
});

// AES-256-GCM
const key = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);

const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
const tag = cipher.getAuthTag();

// The final binary format: [12 bytes IV] [encrypted data] [16 bytes AuthTag]
const finalPayload = Buffer.concat([iv, encrypted, tag]);

const outPath = path.join(__dirname, 'src-tauri', 'drugs_payload.enc');
fs.writeFileSync(outPath, finalPayload);

console.log(`Saved encrypted payload to ${outPath} (${(finalPayload.length / 1024 / 1024).toFixed(2)} MB)`);

const keyArrayStr = Array.from(key).join(', ');
console.log('\n--- RUST KEY ---');
console.log(`const ENCRYPTION_KEY: [u8; 32] = [${keyArrayStr}];`);
console.log('----------------\n');
