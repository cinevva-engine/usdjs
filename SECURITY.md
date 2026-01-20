## Security policy

### Reporting a vulnerability

Please **do not** open a public issue for security reports.

- Email: `security@cinevva.com` (preferred)
- If unavailable, open a GitHub issue with minimal details and request a private channel.

### Scope

This project parses complex, attacker-controlled inputs (USD text and binary formats). It has **not** been security-audited.

If you use it on untrusted content, you should:

- run parsing in a sandbox (worker / isolated process)
- enforce size and recursion limits at the application level
- avoid exposing filesystem/network access to resolvers without explicit policy

