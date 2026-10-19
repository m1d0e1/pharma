# Original-history financial consent: private ingestion and independent-verifier preflight

**Current result: BLOCKED.** The owner/developer reports having reviewed the
historical financial cutover with an accountant. The reviewed proposal and
independently authenticated, signed **machine-readable** consent records have
not yet been verified. The existing unsigned historical owner and native SQLx69
data remain quarantined. This diagnostic cannot itself authorize a production
upgrade or issue any financial receipt.

The private preflight is `scripts/qa_original_history_legacy_epoch_consent_preflight.py`.
It checks the immutable original source commitments and actual, detached document
bytes. The owner and accountant are **never required to handle cryptographic
keys**. For each of those humans, a separately controlled consent-verification
authority must document how it authenticated the person and their approval of
the **exact** opening balances, source, cutover time, unresolved exceptions and
supporting evidence. That verifier signs its receipt using credentials held by
the verification service, after the human's authorization. Distinct operator
credentials may then sign *witness claims* of that already recorded review. An
operator cannot issue their own independent-verifier proof or substitute an
assertion for the person's actual assent.

The immutable `cutover-packet.json` schema comes from the original epoch policy
v2. The private evidence set is **exactly** the referenced individual documents,
including the original financial statements and separate owner/accountant
authorization documents. Each document has an opaque ID, a unique flat basename,
and a SHA-256 that must match its byte contents. The code reads the documents
privately, checks every original byte commitment, and does not emit their contents.

Store the following *outside the repository and installed application profile*,
in the manually provisioned protected folder
`%LOCALAPPDATA%\pharma-disposable-data-copies\pharma-original-financial-consent-private\`:

- `cutover-packet.json` — reviewed cutover proposal plus two controlled
  operator-witness signatures; owner and accountant consent-evidence references
  bind the independent review-subject SHA-256
- `document-manifest.json` — `{ "format": "pharma-private-legacy-epoch-consent-evidence-manifest-v1", "documents": [ { "evidence_id": "opaque_id", "filename": "opaque_id.pdf" } ] }`, with one entry for **every** packet evidence record
- `consent-receipts.json` — `{ "format": "pharma-independent-human-financial-consent-receipt-v1", "receipts": { "owner": { "assertion": { ... }, "signature_b64": "..." }, "accountant": { "assertion": { ... }, "signature_b64": "..." } } }` (shape illustrated only; this is no approval)
- Each sealed supporting document as a unique nonempty `.pdf`, `.png`, `.jpg`,
  `.jpeg`, `.txt`, `.json`, or `.bin` file, up to 32 MiB per file, with a total
  evidence budget of 256 MiB

An independent verifier receipt has the following exactly specified fields:
`format`, `consenting_role`, `issuer_id`, `receipt_id`, `tenant`,
`native_sqlx69_sha256`, `request_id`, `review_subject_sha256`,
`human_consent_evidence_sha256`, `human_consent_evidence_id`,
`consenting_subject_reference_sha256`, `authentication_method`,
`authenticated_at_utc`, `issued_at_utc`, `affirmation`. `affirmation` must equal
`identity_verified_and_human_approved_exact_financial_review`; the role and
all linked fields must agree with the epoch packet. The opaque subject
reference commits to an independent identity check by the verifier; its hash
alone cannot prove who consented. The receipt is signed over the domain
`PHARMA:INDEPENDENT:HUMAN-FINANCIAL-CONSENT:V1` plus the role and canonical JSON
claim, using two separately pinned consent-verifier public credentials that
must be different from one another and both operator-witness credentials.

Private documents must provide **real, externally verifiable consent**. A
scan of a signature or a typed assertion is *not automatically authenticated*.
The independent consent verifier must have a defensible and auditable process
to establish the real person's identity, expose the exact proposal and source
documents for review, record genuine assent, and retain the original proof. The
code verifies only that the trusted verifier signed its claims, that the
claimed identity references differ, that the claimed times are consistent,
and that the specific retained documents match the digests. A corrupt or
untruthful independent verifier cannot be detected solely by cryptography;
issuer authorization, revocation and review procedures require external
governance. **A signed witness from the developer/operator is insufficient.**

The protected verifier and operator trust anchors are intentionally **not
provisioned in this QA script**. No input file, local environment variable,
test signer or CLI option may install public trust roots. Until a trusted
operational consent-verification service has independently supplied the real
receipts and its protected public trust configuration, running

```powershell
python -B -m scripts.qa_original_history_legacy_epoch_consent_preflight --expected-request-id <independent-uuid-v4-challenge>
```

must return code `3` with `BLOCKED_UNVERIFIED_EXTERNAL_FINANCIAL_CONSENT`.
This refusal occurs **before any source or private document is read** when
trust anchors are unavailable. No private DB write, legacy row repair,
native receipt backfill, sale payment inference, shared shift replacement or
historical cash posting is performed. In particular, zero legacy
`paid_amount`/`remaining_amount` headers must not be interpreted as settlement.

With both independently controlled and correctly provisioned trust domains,
the diagnostic can cryptographically validate all private document byte
digests, both separately authenticated independent consent-verifier receipts,
and both subsequent operator witness signatures. Its successful technical
preflight status remains
`VERIFIED_EXTERNAL_CONSENT_DOCUMENTS_AND_INDEPENDENT_ISSUER_WITNESSES_NO_PRODUCTION_GRANT`,
with `production_allowed: false`. Actual human consent is supported only to
the extent that those externally governed verifier credentials, identity
checks and retained approval documents are authentic. The program never
claims to have personally witnessed a human's review.

There is **no** document uploader, key enrollment, local consent creation,
financial posting, approval-grant issuance or installer promotion command.
Durable challenge/replay consumption, independent verification of underlying
source documents, licensed GUI acceptance, installer rollback, native
cutover idempotency and a production authorization process remain separate
release gates.

Focused synthetic-only tests:

```powershell
python -B -m scripts.qa_original_history_legacy_epoch_policy_regression
python -B -m scripts.qa_original_history_legacy_epoch_consent_preflight_regression
```

Tests use ephemeral in-memory keys and synthetic files only. No real patient,
pharmacy owner, accountant, financial statement, consent or commercial
certificate is invented or installed.
