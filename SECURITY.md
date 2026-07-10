# Security Policy

## Supported Versions

Security fixes are made on the default branch and released in the newest
published version. Older releases are not maintained as separate security
branches. Confirm a report against the latest release or the default branch
when practical.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability.

Use this repository's GitHub private vulnerability reporting form. If that form
is unavailable, use the private contact method listed on the repository owner's
GitHub profile and include `Skill Suitcase security report` in the subject.

Include enough information to reproduce and assess the problem:

- affected version or commit
- operating system and Node.js version
- commands or inputs that trigger the issue
- expected and observed impact
- a minimal reproduction or proof of concept, when safe
- any suggested mitigation

Remove credentials, private prompts, personal paths, catalog contents, and agent
state that are not required for the report. Never send a live token or secret;
use an obviously fake placeholder.

Maintainers will confirm receipt, assess scope and severity, and coordinate a
fix and disclosure when the report is valid. Please allow time for a release
before publishing details that would put users at risk.

## Security-Relevant Scope

Reports are especially useful when they involve unintended writes outside an
approved catalog or target, path traversal, symlink or rollback safety,
credential exposure, unsafe archive handling, source-policy bypasses, or output
that leaks private data. General questions and non-security defects belong in
the normal issue chooser described in [`SUPPORT.md`](SUPPORT.md).
