# Owner-only staff access review

## Applied

- Staff management, permission changes, staff performance, and job/salary definitions require the actual `owner` role. Admin, manager, pharmacist, and cashier grants cannot override this rule, including old JSON/array permission formats.
- Staff routes, sidebar/menu visibility, and the settings staff panel follow the same rule. Owner-only permission controls are labelled non-delegable.
- Staff creation/editing/deactivation, password resets, permission updates, management data, jobs, and performance actions check the current session before querying or modifying data.
- Removed the separate Tauri staff-page SQL paths; desktop and web pages now call the same checked actions. Managed-user handover closure also requires the owner; ordinary handover permissions are unchanged.
- Basic active-staff selection remains available for shared-shift workflows, without password hashes or permission records. Staff management no longer selects password hashes and excludes deactivated accounts.
- The only active owner cannot be demoted. Staff deactivation preserves transaction attribution and moves the shared shift's administrative ownership marker.

## Executed verification

- Broad Jest run: 112 suites passed; 949 tests passed, 2 skipped. The artifact-dependent catalogue test suite remains skipped without its external fixture.
- Final focused run: 6 suites / 34 tests passed, including 19 new owner-only action/UI regressions.
- Tests exercise real staff actions against isolated in-memory SQLite: owner writes/readbacks, performance totals, rejected non-owner calls before SQL, role changes, deactivation and preserved receipt attribution.
- React tests execute all three staff pages, owner/non-owner navigation, and the settings staff panel. Non-owner saved grants do not load protected data.
- TypeScript no-emit check passed. No production build, installer, push, or production database modification was performed.

## Remaining security boundary

This enforces the normal application UI/action workflow; it is **not a complete native authorization boundary**. `src-tauri/src/commands/critical.rs::db_execute_guarded` accepts renderer SQL without an authenticated native session, and the SQL plugin exposes database reads. A deliberately modified renderer/direct native invocation can bypass client-side action checks. Web middleware role cookies likewise must not be treated as authoritative credentials.

Recommended separate hardening: establish a backend-authenticated session, move privileged staff reads/writes into narrowly scoped commands with owner checks, and remove generic renderer access to protected tables. Adding only a renderer-supplied user ID would not solve this. This review did not execute hostile-native-call tests, installer/OS tests, or a packaged-app UI session.

Ponytail guided reuse of shared checked actions and removal of duplicated desktop logic without adding dependencies.
