# CSV-authoritative catalog metadata recovery

## Latest approved output — 7 September 2026

The user explicitly approved correcting inventory/POS selling prices as well as the catalog fields. Use `scratch/catalog-recovery-20260907/pharma_local.corrected-with-pos-prices.db` for that result, not the earlier catalog-only snapshots. Its adjacent `.db.report.json` lists changes by column and inventory lot.

| CSV column | Applied change |
| --- | --- |
| Trade Name | Match identity only; existing names and translations preserved |
| Price | `master_drugs.official_price` and, with explicit opt-in, `inventory.local_selling_price` |
| Active Ingredient | `master_drugs.active_ingredient` |
| Category | `master_drugs.category` |
| Manufacturer | `master_drugs.manufacturer` |

1,912 catalog records and 181 inventory-lot selling prices were corrected. All 24,886 uniquely matched catalog records and 2,008 matched inventory lots were checked against the CSV. 326 unidentified/ambiguous catalog records and the 262 lots linked to them retain their prior data. These counts include rows that already had the correct values.

The CSV and inventory selling price are per large unit/box; POS divides by the unchanged lot conversion factors for strips/tablets. Purchase costs, legacy `inventory.unit_price`, all past sales/purchase/return prices, and stock quantities are unchanged. `master_drugs.base_price` is not repurposed as a retail price. Custom `scientific_group` is also preserved as a distinct field rather than silently overwritten.

The original uploaded file hash is unchanged. Preservation fingerprints for 52 tables, SQLite integrity, and foreign-key checks passed. The extended recovery regression and all 22 targeted POS/purchase/catalog Jest tests passed; lint and diff checks passed. The POS barcode regression checks both default catalog-only behavior and explicitly opted-in lot price changes while retaining fractional quantities and unit factors. No installed-app UI test or release build was performed.

Explicitly opted-in recovery command:

```powershell
node scripts/repair-catalog-copy.js "path/to/complete-backup.db" "path/to/new-corrected.db" --inventory-prices
```

The subsequent user request authorizes including this correction in the next software update. On the first launch, startup now backs up the current local database and applies both CSV metadata and inventory selling-price correction locally, without upload or internet access. Separate metadata and price completion markers prevent repeat repair and allow upgrade from a previously metadata-only correction. Later manual price edits are preserved after completion. Settings shows the persisted result, skipped count, and pre-repair backup path; unsafe legacy-ID repairs still require their original-name backup and produce an explanation instead of guessed changes. The offline command remains explicitly opted-in via `--inventory-prices`.

Do not restore an older corrected snapshot over newer live transactions: the update repairs the database already on the user's computer instead. The earlier results and default offline behavior below remain documented for comparison. The update source has been changed and tested, but no release build or publication has been authorized or performed.

This supersedes the stable-ID repair described in DATABASE_RECOVERY_2026-09-06.md. A complete customer backup proved that reference IDs are not portable between installations. The user confirmed that existing drug names and barcodes identify the correct products.

## Repair rules

- Match `trade_name` against `egypt_drugs_drugeye.csv`, ignoring case and repeated ASCII whitespace only. Never match by numeric ID, ingredient, price, approximate spelling, or barcode guessing.
- Require one reference row per normalized name. Skip unmatched and ambiguous names.
- Update only `official_price`, `active_ingredient`, `category`, and `manufacturer`.
- Preserve names/translations, IDs, every barcode, custom fields, unit conversion factors, inventory quantities, lot costs/selling prices, and all historical transactions. No records are merged, added, or deleted from the catalog.
- Rebuild the derived search index using the existing FTS migration, which fixes legacy triggers missing the stock record's rowid.
- The release seed now includes a separate `catalog_csv_reference` table containing only the CSV's five authoritative columns. Legacy-only seed drugs are not used as recovery evidence.
- Desktop startup backs up before repair and applies the shared SQL once. It refuses a database already processed by the old ID-based repair unless the new name-based repair marker is present; such databases require original-name evidence from their pre-repair backup.
- After successful correction, set the new name-based repair marker and the legacy skip marker. The latter prevents older executables with the known v1 repair from relabeling stock again. This does not make every historical application/sync version safe.

## Uploaded snapshot result

Input: `pharma_local (2).db`, SHA-256 `5033074AAEFC14B6106BC9A3130C914827DCD790AE9E9DB72F6FCA4C90D4B15B` (original unchanged).

Corrected output: `scratch/catalog-recovery-20260906/pharma_local.ready.db`.
Detailed changes/unresolved records: the adjacent `.db.report.json` file. These private recovery artifacts are excluded from Git.

- 25,212 catalog records retained.
- 1,912 records corrected; 24,886 uniquely matched records verified against all four CSV metadata fields.
- 323 records without an exact normalized reference name and 3 with an ambiguous reference name were left unchanged.
- 2,270 inventory rows retained with identical quantities and other fields.
- Content fingerprints across 52 non-derived tables verified preservation, including every inventory row and receipt/purchase/return reference. For `master_drugs`, fingerprints exclude only the four explicitly corrected fields.
- SQLite integrity, foreign-key checks, and FTS index-versus-content integrity passed.
- Existing duplicate names and multi-ID barcode collisions are preserved, not resolved by merging. Catalog prices are corrected; intentionally separate lot selling prices and historical receipt prices are unchanged.

## Executable verification

```powershell
node --test scripts/catalog-repair.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml
npx jest --runInBand --runTestsByPath src/app/actions-client/__tests__/purchase-handover.regression.ts src/app/actions-client/__tests__/drug-catalog-sync.regression.ts --testMatch '**/*regression.ts'
```

The Node regression covers shifted IDs, duplicate local names, reference ambiguity, custom/unmatched drugs, strength differences, repeated whitespace, stock/history preservation, FTS refresh, repeat execution, overwrite refusal, invalid CSV prices, and legacy repair detection. The Rust regression exercises the production repair/backup path. POS action tests call the real barcode lookup against a SQLite fixture after applying the shared SQL.

The updated seed generator was executed into an isolated scratch directory; all 25,296 packaged reference rows matched the CSV. No application release or installer was built, installed, or published. Real installed-app UI and cross-architecture testing were not performed in this task.

## Applying safely

This output represents the uploaded snapshot, not subsequent pharmacy activity. **Do not replace a newer live database with it.** If sales, purchases, returns, or other edits occurred since that backup, make a fresh complete backup and repair that instead.

For authorized offline recovery, the repeatable tool always writes a new file:

```powershell
node scripts/repair-catalog-copy.js "path/to/complete-backup.db" "path/to/new-corrected.db"
```

Use an existing output directory and a new filename. Keep the original backup. Do not pair the corrected file with old WAL/SHM files. Deployment of the application-side safeguard still requires an explicitly approved future build/update. Resolving the remaining unidentified drugs or merging duplicate stock identities requires additional verified information and a separate reviewed operation.
