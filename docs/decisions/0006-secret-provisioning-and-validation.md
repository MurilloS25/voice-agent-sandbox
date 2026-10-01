# Secrets are generated locally, set with psql, and validated at startup

- Status: accepted
- Date: 2026-09-30

## Context

The backend needs two secrets: a database password for its least-privilege role and a key that signs proposal tokens. Neither may appear in chat, a command argument, shell history, a migration, documentation, a log, a commit or the Supabase SQL Editor (whose history retention is undocumented, so it is treated as persistent). PostgreSQL's documentation warns that a cleartext `ALTER ROLE … PASSWORD` is sent to the server in cleartext and may be logged in client history or the server log, and recommends psql's `\password`.

## Decision

- Secrets are drawn from the operating system's secure random source by `python -m voice_agent_api.devtools.secrets generate`, which creates the git-ignored `apps/api/.env` exclusively (it refuses to overwrite; `--rotate` replaces only the two secret values) and prints variable names, never values. `check [--connect]` reports pass or fail per variable name and never shows a value, a length or a connection error's detail.
- The role is created `NOLOGIN` with no password. The password is set once with `psql` `\password voice_agent_api` (the value is pasted at a hidden prompt and psql sends a hash, not the cleartext), then `alter role voice_agent_api login;` is run. A `LOGIN` role with no password cannot authenticate by password.
- **`psql --version` is a hard prerequisite gate.** If psql is unavailable the work stops and the user installs an official PostgreSQL client or approves another documented method. There is no automatic fallback, and no tooling is built to hash passwords or write `ALTER ROLE … PASSWORD` statements. A SCRAM verifier is treated like a password.
- The database is configured with discrete `DB_*` variables, not a URL, so the password never sits in a DSN string that could be logged or need percent-encoding.
- Settings use `pydantic-settings`; secrets are `SecretStr` and never appear in `repr`. In postgres mode startup fails closed with the fixed message "Server configuration is invalid." when `PROPOSAL_SIGNING_KEY` is missing, empty, not base64url, under 32 bytes, made of repeated bytes, or a `CHANGE_ME` placeholder, or when `DB_PASSWORD`, `DB_HOST`, `DB_USER` or the CA certificate path are missing or placeholders. Only the setting's name is logged, and the pydantic validation error is never chained because it carries the input value. In memory mode an unfilled placeholder key is treated as unset (an ephemeral key is generated); a real but weak key is still rejected.
- `.env.example` holds placeholders only. A test asserts that, and that the validator rejects them for postgres mode.
- Rotation: `generate --rotate`, then `\password` again, then restart the API. The old password stops working immediately.

## Consequences

- The plaintext password exists only in `.env` and, briefly, the clipboard. It is pasted from the file at the `\password` prompt, so the clipboard should be cleared afterward.
- The signing key and database password are independent: rotating one does not affect the other.
- Setup depends on a local `psql`. On a machine without one, provisioning pauses until a documented method is chosen.

## Alternatives considered

- **Cleartext `ALTER ROLE` in the SQL Editor:** stored in editor history and possibly server logs.
- **Applying a locally computed SCRAM verifier:** PostgreSQL stores a pre-hashed password as-is, but this adds password-hashing tooling and still leaves a sensitive value in a file or command. Not adopted unless the user approves it explicitly.
- **A single `DATABASE_URL`:** simpler, but embeds the password in a string that is easy to log.
