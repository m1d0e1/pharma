# Original SQLx69 legacy epoch and opening-balance witness — review policy

**Status: technical policy and negative tests only; no authentic human approval
verified, no accepted opening balances, provisioned operator credentials,
payment certifications, installation, or native posting authorization.**

`scripts/qa_original_history_legacy_epoch_policy.py` defines a deterministic,
content-addressed proposal for carrying verified historical **source facts**
into a separately approved **opening balance**. It never edits the v29
archive, SQLx69 QA snapshot, historical rows, journals, original `NULL`
`shift_id`s, native receipts, current installation, or any QA app profile.

The operator-witnessed statement binds the independent original v29 SHA-256, actual
normalized SQLx69 SHA-256, `primary_pharmacy`, a hash of existing aggregate
financial / supplier / patient / tender / pre-shared-shift witnesses, the last
recorded source economic event, a cutover date with its explicit UTC offset
and named IANA timezone, twelve balanced opening-balance classes, independent
document digests, acknowledged unresolved exceptions, and the immutable
no-historical-reposting policy. Evidence references are opaque identifiers and
SHA-256 digests; source statements, patient names, records, invoice identities,
and other private details do not belong in the packet or source repository.

Each opening-balance class must be expressly entered, even when zero, and
matched with its category of independent proof: physical till count, bank
statement, customer receivables, stock count at cost, supplier statements,
wallet liability, credit memo schedule, dispute schedule, and equity
reconciliation. A separately committed cutover authorization is required.
Debits and credits must balance exactly in integer cents. A technically
balanced proposal is not independent evidence of cash, AR, AP or stock; the
reviewers must inspect the referenced documents themselves.

**The pharmacy owner and accountant are not required to own, generate, manage,
or sign with Ed25519 keys, and no customer-facing key ceremony is required.**
The owner must personally review the proposed cutover and financial evidence;
the independently responsible accountant must separately review and agree.
Authorized staff may record each person's approval through an established
independently authenticated business process (for example documented
identity-verified in-person assent or authenticated approval record). Each
record must identify the exact source-bound financial proposal by its
`review_subject_sha256`, as well as the consenting role, evidence reference,
authentication method, and time. Such records must reflect actual human
authorization, never a supposed approval asserted by an operator.

The critical historical classification stays explicit and immutable:

- Legacy sale `paid_amount=0` / `remaining_amount=0` headers are **not**
  evidence of paid invoices, and no script may infer individual payment status.
- Original supplier AP can reconcile internally without independently
  identifying external supplier receipts or allocation of every payment.
- Historic patient cash date/amount multisets are **not** signed payment
  receipts, wallet ownership authority or settled receivable proof.
- Original pre-shared-shift null shift IDs represent real historical chronology,
  with no fabricated cashier shift association.
- Original stock lot gaps, COGS, cash mismatches and disputes cannot be
  repaired by inventing historical provenance.
- The opening-balance journal remains a deferred, distinct reviewed native
  transaction. Post-cutover operations require new native posting receipts;
  original economic events cannot be replayed or double counted.

The packet digest uses domain-separated canonical JSON. Only **two distinct,
controlled operator-held signing credentials** sign witness declarations about
**prior, separately authenticated owner and accountant approval**. These are
operator witness signatures, not signatures or keys held by either customer.
The two records bind the same immutable financial statement and separate
authorization-evidence digests; neither witness may precede the human
authorization it references. The verifier rejects missing
or repeated categories, duplicate document commitments, wrong debit/credit
direction, imbalanced or floating-point amounts, inconsistent source timezone
offset, cutover before source activity, stale/early approvals, changed source
hash, changed balance, altered uncertainty policy, reused role identity, forged
signature, operator witness before reported human consent, mismatched consent
subject, missing owner/accountant documentation and unexpected statement fields.

**An operator signature is proof only of which controlled operator credential
signed the stated witness claim. It is never proof that the owner or accountant
was authenticated or actually consented.** Likewise, an evidence digest
commits to document bytes but does not establish who authored that document
or whether the content is true. Actual human approval must be independently
validated against original, retained consent evidence through a separately
trusted approval process. The diagnostic deliberately implements no such
human-authentication verification and always reports
`owner_and_accountant_human_authorization_independently_verified: false`
and `production_allowed: false`, **even for a cryptographically valid pair
of operator witness signatures**. An operator may not use their own assertion
as a silent substitute for owner or accountant review. Durable challenge
consumption/replay prevention and verified human authorization evidence would
be required in the future native workflow before any operational use.

**Independent controlled operator-witness trust anchors are deliberately
unprovisioned** in this diagnostic. Neither JSON, command-line arguments nor
environment values can supply a self-reported operator signing key. Running the
CLI currently fails closed before reading any source or review document:

```powershell
python -B -m scripts.qa_original_history_legacy_epoch_policy --packet <detached-review-packet.json> --expected-request-id <independently-issued-uuid-v4>
```

The private source should remain at the exact independently pinned disposable
SQLx69 location. The CLI has no `sign`, `post`, `migrate`, `install`, `approve`
or database-write command. The matching packet can only be constructed after
independent real owner and accountant approval, securely provisioned and
separately controlled **operator** witness credentials, externally validated
consent records/document digests, agreed opening amounts and explicit cutover
instant. Customers and accountants never need to interact with signing-key
implementation details. There is no legitimately verified human approval or
actual approved opening balance yet.

Synthetic-only regression coverage:

```powershell
python -B -m scripts.qa_original_history_legacy_epoch_policy_regression
```

Even a future technically valid two-operator packet returns
`production_allowed: false` and **cannot promote operator assertions to
human approvals**. Independent genuine owner authentication, actual accountant
acceptance with authenticated evidence, source-bound
native transaction/idempotency and anti-replay controls, licensed transactional
GUI validation, tested backup/recovery and separate installer release approval
are all outside this script and remain mandatory.
