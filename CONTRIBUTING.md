# Contributing to Lingua

Thanks for helping. Lingua is deliberately small: a Manifest V3 extension with
no build step and no runtime or development dependencies. Please keep changes
within that design unless the change itself is the proposal.

## Before opening an issue

- For caption failures, run **Diagnostics -> Copy report** and include the
  report. It distinguishes "no caption track was found" from "a track was found
  but its data could not be fetched"; those failures have different causes.
- Include the browser and extension version, the page or video URL if it is
  safe to share, and the provider/model you configured.
- Remove API keys, private page text, and anything else you do not want public
  before posting. The diagnostics report does not contain those fields.

## Development

No install step is required.

```bash
npm test            # core logic, no browser needed
npm run check       # all four offline suites plus the documentation drift guard
npm run test:e2e    # real Chrome, unpacked extension, local HTTP fixture
npm run preview     # render every UI surface to PNG
npm run demo:gif    # rebuild the README demo from real overlay frames
```

`npm run check` is the required offline gate for a pull request. `test:e2e`
should also pass when a change touches extension loading, content scripts, or
the page-translation pipeline.

## Pull requests

- Keep the change focused. Explain the user-visible problem and the mechanism
  of the fix, not only the files changed.
- Add or update a test when behavior changes. A screenshot alone is not a
  behavioral test.
- Keep the extension dependency-free. Do not add a package, CDN script,
  remote code, analytics SDK, or a generated bundle.
- Keep English and Chinese UI strings in sync. UI text lives in
  `src/shared/messages.js`; do not hard-code a second copy in a page.
- Do not overwrite the original page text. Page translation must remain
  reversible, and translated links must remain the original DOM elements.
- Run `npm run check` before opening the PR and include the result in the
  description. If a check cannot run locally, say which one and why.
- Do not update a number in the README by hand. Change the code or test, then
  let `npm run check:docs` report the mismatch before updating the claim.

## Security and privacy

- Never commit API keys, tokens, browser profiles, or captured page content.
- Do not add telemetry, a project-operated backend, or a request that sends
  user data anywhere except the translation provider the user configured.
- If you find a security issue, do not open a public issue with exploit
  details. Contact the repository owner through GitHub and include a minimal
  reproduction.

## License

By contributing, you agree that your contribution is licensed under the
repository's [MIT License](LICENSE).
