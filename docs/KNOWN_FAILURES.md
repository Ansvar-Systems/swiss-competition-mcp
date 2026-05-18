# Known Failures

## NEEDS_REVIEW — 2026-05-18

Flagged by `scripts/apply-mcp-standard.py`. Treatment was skipped pending resolution.

**Reason:** `wal_mode_db: data/database.db is in WAL journal mode (byte 18 = 0x02). @ansvar/mcp-sqlite (WASM) cannot read WAL-mode DBs. Rebuild via `npm run build:db` — most build scripts already flip to DELETE before close, so a fresh rebuild fixes this. Reference: feedback_wasm_sqlite_wal_mode_blocker.md.`

**Gate state at pre-flight:**
- PASS: (none)
- N/A:  (none)
- FAIL: pre-content

**Profile detected:** `node-native-curated`

**Next steps:** the reason string above maps to a known pattern in
`docs/handover/2026-04-26-golden-standard-next-batch-handover.md` §4. Resolve
on a separate fix branch, then re-run the sweep on a fresh `audit/` branch
once `main` is green.
