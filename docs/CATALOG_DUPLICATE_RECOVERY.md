# Offline catalog duplicate recovery

This is an explicit, offline data-recovery operation, **not** an automatic startup merge.
Use a current complete SQLite backup, not a loose DB copied while WAL writes are active.
Never replace an installation with a snapshot older than its latest transactions.

```powershell
node scripts/merge-catalog-copy.js 'path/to/backup.db' 'path/to/NEW-repaired.db'
```

The output parent directory must exist. The utility never overwrites the input or an
existing output. It keeps `NEW-repaired.db.recovery/original.db` and produces an adjacent
JSON report containing the ID mapping, original catalog records and skipped groups.
Recovery artifacts contain customer data: keep them private and out of source control.

The reference is `egypt_drugs_drugeye.csv`. Exact, whitespace-normalized names must map
to one reference row. Strength, form, punctuation and pack size are not discarded.
Catalog metadata and current inventory selling prices are corrected first, following
the approved price-repair policy. Costs and historical prices are not repriced.

Consolidation prefers an already-correct catalog row. It moves drug references and
preserves the original inventory rows rather than summing/recreating lots. Blank
canonical barcode/custom fields inherit a unique source value. Incompatible conversion
settings on used records, conflicting custom fields, multiple master barcodes,
cross-name barcode collisions, ambiguous references and clinical associations are
reported for review. Unknown reference columns, pending-work tables, referential errors
and constraint failures stop recovery. No `DELETE OR IGNORE` or fuzzy matching is used.

Verification compares all business rows against their expected ID-remapped values,
checks foreign keys including implicit references, validates SQLite/FTS integrity and
publishes the complete output exclusively. A failure leaves the input untouched.

Close the app and finish/discard suspended carts before replacing its data file. Preserve
the old DB and any WAL/SHM files together; never pair old sidecars with the repaired DB.
Restart to reload the catalog cache. Do not reimport an inventory workbook with old IDs.

## Tests (no release build)

```powershell
node --test scripts/catalog-merge.test.cjs scripts/catalog-repair.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml
```

The optional `catalog-merge-artifact.regression.ts` integration suite accepts a private
repaired database via `PHARMA_RECOVERY_TEST_DB` and its adjacent JSON report. Its
ANDODERMA assertion targets the September 2026 recovery sample; it is not a generic
acceptance check for every customer. The SQLite bridge is adapted for testing, but
purchase-search, cache and POS barcode action logic are real. It performs no DB writes.
