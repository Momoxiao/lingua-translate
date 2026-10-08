# Security policy

Lingua handles translation-provider credentials and page text, so security and
privacy reports are taken seriously.

## Reporting a vulnerability

Do not open a public issue with exploit details. Use GitHub's private
[security advisory](https://github.com/Momoxiao/lingua-translate/security/advisories/new)
form and include:

- a minimal reproduction;
- the affected version and browser;
- the impact you believe is possible; and
- any suggested mitigation.

If the private form is unavailable, contact the repository owner through their
GitHub profile and ask for a private reporting channel without posting the
details publicly.

## Scope

Useful reports include credential exposure, unintended network transmission,
remote code execution, permission bypass, injection into an untrusted page, or
diagnostics accidentally including secrets or page text.

The following are still important, but are tracked as regular bugs unless they
also create a security consequence: a broken YouTube caption path, provider
API changes, translation quality, and visual layout defects.

## What to expect

The project is maintained by one person. Reports will be acknowledged as soon
as practical. A fix and disclosure timeline depends on severity and on whether
an upstream browser or translation provider is involved. Please allow time for
a fix before publishing details.

## Privacy reminder

Before sharing logs, diagnostics, screenshots, or a test page, remove API keys,
private page text, account identifiers, and any URL you do not want public.
