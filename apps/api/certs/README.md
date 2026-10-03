# Database CA certificate

`DB_SSLMODE=verify-full` makes the API verify the database server's certificate chain *and*
host name. It needs the certificate authority that signs Supabase's pooler certificate, as a
**public** PEM file at `apps/api/certs/supabase-ca.crt`, which the image copies to
`/app/certs/supabase-ca.crt` (`DB_SSLROOTCERT`). It is never downloaded at runtime.

The file is in the repository (added at gate G5). It is a public certificate, not a secret. Supabase's documentation names the file `prod-ca-2021.crt`; in this repository it is stored as `supabase-ca.crt`:

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
| Origin | Supabase dashboard, Database Settings -> SSL Configuration, file `prod-ca-2021.crt` |
| Subject = issuer | `C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA` (self-signed root, `CA:TRUE`) |
| SHA-256 fingerprint | `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA` |
| Valid | 2021-04-28 to **2031-04-26** (renew well before; reminder in the operations notes) |
| Checked | One PEM certificate, no private key; the pooler's chain (leaf `*.pooler.supabase.com`, intermediate, this root) verifies with OpenSSL, host name included. Python's own `ssl` module rejects this root only under its strict X.509 mode (the CA has no key-usage extension); libpq, which the API uses, does not apply that mode. |
