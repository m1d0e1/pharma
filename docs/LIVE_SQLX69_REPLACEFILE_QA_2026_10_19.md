# Current-live-aligned Windows SQLx69 recovery verification (2026-10-19)

This is technical recovery evidence, **not** owner approval, financial acceptance,
an installed update, or physical power-loss durability certification.

## Inputs independently rechecked

- Installed v29 SQLite SHA-256: da2f3bdf31bbd206e4d2081d726394c66093d8e21454124c665a95829c96b706
- Detached Rust-native SQLx69 SHA-256 (account-sequence aligned):
  ba929fc92b49e890c50ef2489b76c5bf49d0c5510b41848f265bc336792efc79
- Current accounts AUTOINCREMENT cursor: **4843** in both v29 source and v69 QA output.
- Exact typed non-sequence historical rows equal protected original archive: **289,753**.
- One immutable original normalization audit batch remains; zero genuine
  historical owner attestations. Do not delete or automatically accept the audit.

## Actual Win32 QA performed

Run from the Windows workspace:

    python -B -m scripts.qa_original_history_live_replacefile_recovery

The script first re-derives the detached SQLx69 stage from the current installed
v29 OS bytes and protected archive (no disk-backed SQLite connection to the
installed file), verifies live file stability, then writes exact v29/v69 copies
into a new owner/SYSTEM-only disposable directory.

An independent child verifies the strict folder, QA metadata and both SQLx
chains (29/69); calls Win32 ReplaceFileW with a rollback file; then exits with
process status **74** without a normal application cleanup. The parent checks
both reopened files, their exact SHA, sequence and SQLx history; rolls back
atomically and re-promotes atomically. The original v29 rollback remains.
There is no fallback copy/delete or code path to the installed DB.

Observed result: **PASS_LIVE_ALIGNED_SQLX69_WIN32_CRASH_ROLLBACK_QA_UNACCEPTED**.

The five refusal tests in scripts.qa_original_history_live_replacefile_regression
passed, checking invalid path tokens, out-of-root destinations, incoming/backup
aliasing, and manifests with forged or unexpected approval fields.

## Unfulfilled production requirements

1. Independently authenticated historical owner and approved **source-bound
   import authorization**, separate from offline device licensing and QA metadata.
2. Owner/accountant-approved financial opening balances and discrepancy review;
   preserve old transactions and legitimate pre-shift NULL shift IDs.
3. Approved commercial license verification identity, signed offline license,
   code-signed Windows 0.2.110 installer and isolated real-history GUI testing.
4. Verified app shutdown and fresh WAL-consistent backup, native restart/posting,
   tested installer rollback, and actual physical power-loss/recovery acceptance.

Never directly install either unaccepted QA file. Windows identifies the
currently installed executable as **0.2.109**; workspace manifests say **0.2.110**.

## Current-v29 cold rollback held separately

While no PHARMA process was running and no installed SQLite WAL/SHM/journal
sidecars existed, ran:

    python -B -m scripts.qa_original_history_cold_rollback_backup

A newly created owner/SYSTEM-only private recovery folder retained the complete
OS-byte v29 snapshot (SHA da2f3bdf31bbd206e4d2081d726394c66093d8e21454124c665a95829c96b706).
The script independently compared all 289,753 typed original non-sequence
rows against the protected archive, preserved account cursor 4843, re-read
the live database and refused to claim approval. It never opened the installed
database using SQLite. An independent verify-token call rechecked the copy.

The five cold-backup negative tests passed, including refusal during a
PHARMA process, unavailable process inventory, malformed custody token and
forged production/import assertions. This is **not** a full WAL-aware live
backup for an active database, and does not permit installation.

## Independent implementation checks

- Combined historical Python regressions: **56 passed before 3 additional
  cutover-consent negative tests** (including cold
  rollback, Win32 QA recovery, original source readiness, financial witnesses).
- Existing manual-offline commercial-license Python tests: **57 passed**.
- Pharmacy-wide shared-drawer/auth frontend Jest: **38 passed**.
- Manual-offline license / first-owner frontend Jest: **7 passed**.
- TypeScript check: passed.
- New SQLx69 legacy epoch acceptance policy: **15 tests passed**; operational
  owner/accountant approvals and operator witness roots remain unprovisioned.
- New native historical owner/source-bound import authorization: **3 focused
  Rust tests passed**; no startup/IPC importer or historic owner authentication
  has been claimed.
- Final original-history preinstall diagnostic: **blocked (exit code 3)**,
  not a source-integrity refusal; installation remains unauthorized.
