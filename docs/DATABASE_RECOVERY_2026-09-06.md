# Database recovery findings — 6 September 2026

## Uploaded database: repair remains blocked

The original files in Downloads were not changed. Diagnostics used private local copies, excluded from Git.

| File | Size (bytes) | Modification time reported by filesystem |
| --- | ---: | --- |
| pharma_local.db | 55,771,136 | 2026-09-05 18:58:34 |
| pharma_local.db-wal | 2,076,512 | 2026-09-06 11:08:42 |
| pharma_local.db-shm | 32,768 | 2026-09-06 11:08:22 |

The earlier main database alone contained the seeded catalog but no inventory, barcodes, patients, sales, purchases, or shifts. With the subsequently supplied WAL, SQLite reports:

`SQLITE_CORRUPT: malformed database schema (Thiothixene) - orphan index`

The supplied base file has 13,616 pages; WAL commit headers advertise 14,646 pages. The raw page inspection also found pages required by that size absent from both files. These files do not provide a valid complete snapshot. This does not prove that the original installation's database is physically corrupt: mismatched or incomplete copies can cause this result.

Do not delete the WAL, substitute the installer seed, or infer inventory ownership from corrupted catalog names. The CSV has no barcode ownership or stock-quantity history and cannot reconstruct missing business records.

## Safe next step on the affected computer

1. Keep the existing files and any old backups unchanged.
2. Fully exit the pharmacy app, including other app windows/processes.
3. Open `%APPDATA%\com.pharma.system` on that computer, under the Windows account that uses the app. Confirm this is its actual active data directory, not the installer/resources directory.
4. Copy `pharma_local.db` and any `pharma_local.db-wal` / `pharma_local.db-shm` files still present together, without reopening the app during copying. Send that fresh set in one ZIP. Do not combine a previously copied main file with newer sidecars.
5. If the app cannot shut down cleanly, preserve the full set and seek assistance instead of removing files. If another app variant uses a different data directory, obtain its actual active path first.

The new Settings backup option creates a standalone snapshot, but it is source-only until a future approved release is installed; it is not yet available in the user's existing executable.

## Safeguards implemented

- The existing catalog fix restores reference metadata by original stable seed ID and does not move inventory, barcodes, or receipt references. Cloud catalog synchronization no longer overwrites existing metadata by incoming positional ID.
- Before the one-time catalog repair, SQLite creates a complete snapshot under the active database directory's `backups/<unique-id>/pharma_local.db`. Backup failure prevents the catalog repair. This backup is before catalog repair, not before earlier schema compatibility preparation.
- Settings now exposes a complete backup for active administrators/owners. Native code verifies the stored role, active status, and password; it does not trust a renderer-supplied user ID alone.
- Backup uses SQLite `VACUUM INTO`, not a live filesystem copy. Source and snapshot are integrity-checked. Failed output retains a `.partial` suffix; only validated, flushed output is renamed to `.db`. Previous snapshots are not overwritten.
- Backups contain sensitive pharmacy information. Share only through an appropriate private channel.

## Executed checks

- 34 Rust tests passed, including WAL-backed snapshots, fractional quantities, standalone snapshot reopening, repeated snapshots, invalid/missing sources, and administrator/password restrictions.
- The catalog regression also exercises the production backup gate: failure blocks repair; the snapshot retains pre-repair metadata/stock; successful repair preserves barcodes, stock and receipt references; the next run does not create another backup or overwrite a later price edit.
- Four frontend/catalog tests passed: Settings-to-Tauri request, snapshot failure feedback, changed-session rejection, and non-destructive catalog sync.
- TypeScript type checking, targeted ESLint checks, and `git diff --check` passed.

## Limitations

No corrected customer database could be produced from the incompatible uploaded set. Recovery for records previously moved to different IDs still requires trustworthy identity evidence or an earlier backup. Stable-ID metadata correction is not a universal recovery for unknown cross-ID remapping or all duplicate rows.

Native tests ran on the current development host. The Settings UI test mocks Tauri IPC; a real installed-app click-through and other Windows/architecture runs were not executed. No release build, publication, or push was performed.
