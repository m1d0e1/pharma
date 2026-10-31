# PHARMA legacy release lockdown — source-only stage

**Status: NO-GO for commercial publication.** This small, dependency-complete
change deliberately disables the historical `v*` release workflow on remote
`main` (`v0.2.109` source). It does **not** claim to deploy the modern owner-only
commercial release workflow or make native `v0.2.110` build-ready.

The existing historical release workflow did not require the full reviewed
business, Windows code-signing, independent updater signature, protected
tag and owner-approval evidence. The exact legacy `publish-tauri` job now has
`if: ${{ false }}`: **no repository variable, reviewer approval, workflow
dispatch or new `v*` tag can run this publishing job** while the literal false
guard remains in the checked-out workflow. Its declared environment is
`pharma-production-release` as a secondary control if its conditions are
reworked in a later approved source revision.

The existing pull-request test workflow runs the dependency-free
`python3 -B -m unittest -q scripts.release_lockdown_regression` safeguard. It
asserts the parent is unconditionally disabled and the existing x86 publisher
still depends on that parent. Future source-complete release enablement will
require an intentional, reviewed replacement of this regression contract.

The owner-only release workflow drafted locally **must not be copied in
isolation** into this historical repository. Its Python, PowerShell and JS
dependencies are missing from remote Git history. Even copying the four direct
helpers is insufficient for a verified native build: the owner workstation
contains newer Rust, Tauri, enrollment, migration and database seed changes
which have not been closed and validated as a single clean-checkout source set.
No real signer, independent license custodian, application TPM2 attestation,
off-host recovery, witnessed physical 80 mm receipt, exact commercial financial
acceptance or actual same-run GitHub approvals have been proved.

The follow-up native release workflow is a separate, reviewable source-only
change requiring a complete reproducible x64 and x86 Windows build and
regressions, authenticated GitHub rule and owner-approval readback, CA-trusted
timestamped Authenticode, separately controlled Tauri updater signing and
signed release-asset verification. Only after **all** the applicable controls
pass may the hardcoded lockdown be replaced and an authorized owner consider
setting `PHARMA_SECURITY_RELEASE_APPROVED=true`.

This lockdown does not touch issuer/customer SQLite, WAL, SHM, licenses,
signing keys, backups, installed Windows applications, release tags or assets.
