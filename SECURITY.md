# Security Policy

## Supported versions

Security fixes are made against the latest released version and the default
branch. Upgrade to the newest release before reporting a problem that may
already be fixed.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

GitHub private vulnerability reporting is not currently enabled for this
repository. Email the maintainer at
[calvinnwq@gmail.com](mailto:calvinnwq@gmail.com) with a subject that begins
`[skill-suitcase security]`. If private vulnerability reporting is enabled
later, prefer the repository's **Security** tab.

Include, when possible:

- the affected version or commit
- the operating system and Node.js version
- the security impact and affected trust boundary
- minimal reproduction steps or a proof of concept
- any known mitigations

Remove credentials, tokens, private prompts, personal data, and unrelated local
paths from the report. Please allow time for the report to be investigated and
coordinated before public disclosure. The maintainer will acknowledge reports
on a best-effort basis and will communicate remediation and disclosure timing
through the private report.

## Scope notes

Reports are especially useful when they involve unsafe target writes, path
escape, receipt or approval bypass, archive extraction, source-policy bypass,
or accidental disclosure through CLI output. Vulnerabilities in third-party
agent runtimes or upstream skill providers should also be reported to the
affected upstream project.
