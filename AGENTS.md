# Pharma project agent rules

This repository is a pharmacy-management system. Correct business behavior and data integrity take priority over cosmetic cleanup.

## Safety invariants

- Preserve accounting correctness, transaction boundaries, stock quantities, lot/expiry behavior, unit conversions, loyalty balances, patient balances, and payment/refund semantics.
- Preserve role permissions, owner/admin restrictions, audit behavior, pharmacy/tenant isolation, and cross-pharmacy data boundaries.
- Do not alter database schema, migrations, SQL semantics, action-layer authorization, Rust command behavior, or business calculations merely to simplify UI code.
- A UI or accessibility review is not evidence of a functional defect. Functional changes require an independently demonstrated defect plus focused regression coverage.
- Keep Arabic and English business labels semantically accurate. Do not replace domain terminology with generic marketing copy.
- Preserve the dirty-tree/release discipline used by this project: no reset/clean/stash/checkout or destructive database replacement unless explicitly requested.

<!-- antislop:start -->
## antislop

For Pharma UI review or UI implementation, use the globally installed Anti-Slop skills by name and load only the modules that apply:

- Core: `antislop`
- UI / visual: `antislop-ui`
- People / accessibility: `antislop-human`
- Mobile / responsive: `antislop-layoutmobile`

Resolve Anti-Slop's usage mode using the core skill exactly as written. For this existing application, prefer an explicit `AFTER` audit when the user asks for a review; for newly requested UI, `DURING` is appropriate only when the user explicitly selects it.

Anti-Slop is presentation-focused in this repository. Its findings may drive changes to layout, visual hierarchy, spacing, responsiveness, focus/keyboard behavior, accessible states, and user-facing wording. It must not by itself justify changes to database behavior, accounting, inventory, permissions, tenant isolation, or other business rules.

For existing Pharma screens, audit one coherent surface at a time and separate findings into `presentation-only` and `requires functional investigation`. In AFTER mode, do not edit until the user approves specific finding numbers. If a UI finding appears to require a change to SQL, schema, migrations, accounting, stock, lot/expiry handling, units, payment/refund behavior, authentication, permissions, audit logging, pharmacy scoping, Rust/Tauri commands, transaction boundaries, persistence, or synchronization, stop at the finding. Reproduce it as a separate functional defect, add focused regression coverage first, and only then consider the smallest safe fix.

Do not invent a new Pharma visual identity or `DESIGN.md`. Preserve the existing application patterns unless the user explicitly provides new design direction. `antislop-copywriting` and `antislop-code` are intentionally not installed; broad copy rewrites and comment/code cleanup remain separate tasks.
<!-- antislop:end -->
