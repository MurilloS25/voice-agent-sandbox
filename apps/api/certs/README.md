# Database CA certificate

`DB_SSLMODE=verify-full` makes the API verify the database server's certificate chain *and*
host name. It needs the certificate authority that signs Supabase's pooler certificate, as a
**public** PEM file at `apps/api/certs/supabase-ca.crt`, which the image copies to
`/app/certs/supabase-ca.crt` (`DB_SSLROOTCERT`). It is never downloaded at runtime.

This file is intentionally **not** in the repository yet. It is a public certificate (no secret),
and the owner adds it at gate G5. Supabase's documentation names the file `prod-ca-2021.crt`; in this repository it is stored as `supabase-ca.crt`:

1. In the Supabase dashboard open **Project Settings -> Database -> SSL Configuration** and use
   **Download certificate** (the official `prod-ca-2021.crt`; there is no direct download URL).
2. Save it as `apps/api/certs/supabase-ca.crt` (in the image: `/app/certs/supabase-ca.crt`). Only this public CA belongs here: never a private key, a client certificate or any secret.
3. Check it is a certificate and not something else:
   `openssl x509 -in apps/api/certs/supabase-ca.crt -noout -subject -issuer -dates -fingerprint -sha256`
4. Record the origin, the subject, the SHA-256 fingerprint and the expiry date in this file,
   and commit both.

Renewal: Supabase rotates its CA rarely and announces it. Put a calendar reminder 60 days before
the expiry above; to renew, repeat steps 1-4 (a bundle with the old and the new certificate keeps
connections working during the overlap) and redeploy. If the file is missing or does not match,
the API cannot connect and reports `storage_unavailable` / not ready; it never falls back to an
unverified connection.

| Field | Value |
| --- | --- |
| Origin | (fill in at G5) |
| Subject | (fill in at G5) |
| SHA-256 fingerprint | (fill in at G5) |
| Not after | (fill in at G5) |
