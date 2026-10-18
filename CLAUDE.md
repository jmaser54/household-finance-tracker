# Instructions for AI assistants

1. Read `PROJECT_PRINCIPLES.md` before any change touching privacy, storage, security, imports, backups or financial calculations. It is the canonical source of truth; keep it updated (with a change-log entry) when requirements or architecture change. `docs/reference/` is historical only.
2. Never request, read, upload or process the household's real statements, transactions, backups or account details. Use synthetic fixtures only (`tests/fixtures/synthetic/`).
3. Never add network calls, remote scripts/fonts, analytics, telemetry, error reporting, AI APIs, OCR services, a backend or sync. Do not loosen the CSP in `index.html`.
4. No `console.*` in app code; no financial data in URLs, errors or logs. Money is integer cents.
5. Before committing run `npm run verify` and review the diff for sensitive data. Do not describe work as complete or secure if any check fails or a privacy requirement is unverified.
