# Purchase Flow — Debugging Framework

## 1. Error Classification Matrix

| Layer | Error Type | Symptom | Root Cause Pattern | Detection |
|-------|-----------|---------|-------------------|-----------|
| **Rust compile** | `cargo check` fail | Build fails with `error[E0xxx]` | Mismatched crate versions, missing imports, trait bounds | `cargo check 2>&1` |
| **Rust compile** | `tauri-plugin-sql` version mismatch | `PluginRegistrationFailed` at runtime | JS SDK version ≠ Rust crate version | Check `Cargo.toml` vs `package.json` tauri versions |
| **Tauri IPC** | `Invoke` serialization error | Rust command returns `Err` or frontend receives `undefined` | `#[tauri::command]` param type ≠ frontend invoke type | `serde_json::from_value` mismatch |
| **Tauri IPC** | Async deadlock | UI freezes on invoke call | Invoking synchronous Rust from async JS without spawn | Use `tokio::spawn_blocking` for CPU-heavy work |
| **SQLite** | `SQLITE_BUSY` | `db is locked` in console | Concurrent writes without WAL or timeout | `PRAGMA busy_timeout = 5000` |
| **SQLite** | `SQLITE_CONSTRAINT` | FK violation, duplicate PK | Transaction mismatch, missing rollback handler | Wrapping `db.transaction(() => { ... })()` |
| **State** | Zustand hydration | Cart appears empty after page load | `persist` middleware stale from incomplete prior session | Clear localStorage key `'purchase-storage'` |
| **State** | Tauri mode session | `getClientSession()` returns null | `pharma_session_user` not in localStorage | Check `loginLocal()` was called |
| **State** | isTauri detection fail | Wrong DB abstraction chosen | `window.__TAURI_INTERNALS__` not set in Tauri 2.0 | `withGlobalTauri: true` in `tauri.conf.json` |
| **Build** | Static export missing page | 404 in Tauri webview | Route not included in Next.js `generateStaticParams` | Add route to `output: 'export'` configuration |

## 2. Debugging Flowchart

```
[Symptom observed]
       │
       ▼
[Is it a build error?] ──Yes──▶ [cargo check] → [npx tsc --noEmit] → [npm run build:tauri]
       │                                   
       No                                   
       │                                   
       ▼                                   
[Is it a runtime error?] ──Yes──▶ [Open Tauri DevTools: Ctrl+Shift+I]
       │                              │
       │                              ▼
       │                     [Check Console tab for JS errors]
       │                     [Check Network tab for IPC calls]
       │                              │
       │                              ▼
       │                     [IPC error?] ──Yes──▶ [Enable Rust logging: RUST_LOG=debug cargo run]
       │                              │
       │                              ▼
       │                     [Frontend error?] ──Yes──▶ [React DevTools → Component tree → State]
       │
       No
       │
       ▼
[Is it a data inconsistency?] ──Yes──▶ [Open DB file with DB Browser for SQLite]
                                          │
                                          ▼
                                    [Check purchase_invoices]
                                    [Check purchase_invoice_items]
                                    [Check inventory]
                                    [Check supplier_transactions]
                                          │
                                          ▼
                                    [Run integrity check: PRAGMA integrity_check;]
                                    [Run FK check: PRAGMA foreign_key_check;]
```

## 3. Tauri-Specific Debugging Commands

```powershell
# ── Environment diagnostics ──
# Verify Rust toolchain
rustup show
cargo --version

# Verify Tauri CLI
npx tauri --version
cargo tauri --version  # (cargo install tauri-cli)

# Check for version drift between Rust crate and JS package
node -e "
const pkg = require('./package.json');
console.log('JS @tauri-apps/api:', pkg.dependencies['@tauri-apps/api']);
console.log('JS @tauri-apps/plugin-sql:', pkg.dependencies['@tauri-apps/plugin-sql']);
"
# Then compare with:
Select-String -Path src-tauri\Cargo.toml -Pattern '^tauri' | Select-String -NotMatch 'tauri-build|tauri-utils'

# ── Build diagnostics ──
# Dry-run the full Tauri build
npx next build && npx tauri build 2>&1

# Check static export output
Get-ChildItem -Path out -Recurse -Filter "*.html" | Measure-Object

# ── Runtime diagnostics (Tauri webview) ──
# Enable debug mode
npx tauri dev

# In Tauri dev mode, right-click → Inspect Element opens DevTools
# Check these in Console:
#   1. window.__TAURI__  → should be truthy
#   2. window.__TAURI_INTERNALS__ → should be truthy
#   3. await import('@tauri-apps/plugin-sql').then(m => m.default.load('sqlite:pharma_local.db'))

# ── SQLite diagnostics ──
# Open the seeded database directly
sqlite3 src-tauri/pharma_local.db ".tables"
sqlite3 src-tauri/pharma_local.db ".schema purchase_invoices"
sqlite3 src-tauri/pharma_local.db "SELECT COUNT(*) FROM purchase_invoices"

# Run integrity check
sqlite3 src-tauri/pharma_local.db "PRAGMA integrity_check;"
sqlite3 src-tauri/pharma_local.db "PRAGMA foreign_key_check;"
```

## 4. Common Tauri Build Failures

| Error | Cause | Fix |
|-------|-------|-----|
| `error: could not find native static library \`sqlite3\`` | Missing SQLite dev libs | Install `libsqlite3-dev` (Linux) or ensure MSVC build tools (Windows) |
| `error[E0432]: unresolved import \`tauri_plugin_sql\`` | Missing plugin in `Cargo.toml` features | Add `tauri-plugin-sql = { version = "2", features = ["sqlite"] }` |
| `Error: The prebuilt binary could not be downloaded` | Tauri updater pubkey missing | Generate: `npx tauri signer generate -w ~/.tauri/pharma.key` |
| `error Command failed with exit code 1.` | `beforeBuildCommand` failed | Run `npm run seed:db && npm run build:tauri` manually first |
| `Error: FrontendDist is not a valid directory: out` | Static export didn't produce `out/` | Check `next.config.js` has `output: 'export'` |

## 5. Purchase Flow-Specific Debugging

```powershell
# ── Verify purchase schema matches between Rust migration and TS DDL ──
diff (Get-Content src-tauri\migrations\001_initial.sql) (Select-String -Path src\lib\db\local.ts -Pattern 'CREATE TABLE.*purchase')

# ── Check for missing columns ──
node -e "
const fs = require('fs');
const rust = fs.readFileSync('src-tauri/migrations/001_initial.sql', 'utf8');
const ts = fs.readFileSync('src/lib/db/local.ts', 'utf8');
['purchase_invoices','purchase_invoice_items','purchase_orders','purchase_order_items',
 'purchase_returns','purchase_return_items','suppliers','supplier_transactions'].forEach(t => {
  const inRust = rust.includes(\`CREATE TABLE \${t}\`);
  const inTS = ts.includes(\`CREATE TABLE \${t}\`);
  if (inRust !== inTS) console.log(\`MISMATCH: \${t} in_rust=\${inRust} in_ts=\${inTS}\`);
});
`

# ── Simulate a full purchase in isolation ──
npx jest src/tests/purchase-flow-e2e.test.ts --verbose

# ── If tests fail, check the exact SQL query ──
# Enable SQLite query logging in tests:
node -e "
const db = require('better-sqlite3')(':memory:');
db.on('trace', (sql) => console.log('SQL:', sql));
"
```

## 6. Session & Auth Debugging for Purchase Flow

```
[Symptom: "غير مصرح" error when creating purchase]
       │
       ▼
[Check getClientSession() return value]
       │
       ├── Returns null → User not logged in
       │     └── Check localStorage.pharma_session_user
       │
       ├── Returns user but no role → permissions broken
       │     └── Check JSON.parse on stored permissions
       │
       └── Returns user with role
             └── Check: role in ['owner','admin'] ?
                   ├── Yes → permission mismatch (check action-level check)
                   └── No → correct rejection
```

## 7. Integration Test Verification Matrix

| Scenario | Test File | Expected | Debug If Fails |
|----------|-----------|----------|----------------|
| Happy path cash purchase | `purchase-flow-e2e.test.ts` | Inventory +107, journals created, no balance change | Check `INSERT INTO inventory` in tx |
| FK violation rollback | `purchase-flow-e2e.test.ts` 2.1 | No partial invoice items | Enable `PRAGMA foreign_keys = ON` before test |
| Supplier balance tracking | `purchase-flow-e2e.test.ts` 4.1 | Balance = previous + total | Check `UPDATE suppliers SET balance` in credit path |
| Discount calculation | `purchase-flow-e2e.test.ts` 5.2 | Invoice total = 310 | Verify `discount_value` handling in SQL |
| Zero total with large discount | `purchase-flow-e2e.test.ts` 6.2 | Invoice total = 0 | Check `Math.max(0, ...)` clamp |
| Accounting entries created | `purchase-flow-e2e.test.ts` 7.1 | ≥1 journal entry | Check `INTO daily_journals` in tx |
