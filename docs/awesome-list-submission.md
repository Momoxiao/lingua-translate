# Awesome-list submission draft

This is a prepared, not yet submitted, pull request. Do not post it without an
explicit approval from the repository owner.

## Target

- Repository: `xyNNN/awesome-chrome`
- Default branch: `master`
- Section: **Language & Translation**
- Contributing rule: `[APPLICATION](LINK) - DESCRIPTION.`
- Evidence that the list is still maintained, verified 2026-10-08:
  not archived or disabled, 122 stars, and its most recent README.md commit and
  merged PRs both landed on 2026-08-02. It has been quiet since then, so this is
  a low-frequency list, not a dormant one.

  Re-check before submitting:

  ```bash
  gh api repos/xyNNN/awesome-chrome \
    --jq '{archived,disabled,pushed_at,stargazers_count}'
  gh api 'repos/xyNNN/awesome-chrome/commits?path=README.md&per_page=1' \
    --jq '.[0].commit.committer.date'
  ```

## Proposed line

```markdown
* [Lingua](https://github.com/Momoxiao/lingua-translate) - Bilingual YouTube subtitles and reversible whole-page translation using your own OpenAI-compatible, DeepL, Google, Azure, or custom API. No account, no project server, MIT.
```

## PR title

```text
Add Lingua to Language & Translation
```

## PR body

```markdown
Adds Lingua, an open-source Chrome/Edge Manifest V3 extension for bilingual
YouTube subtitles and reversible whole-page translation.

It works with the user's existing OpenAI-compatible, DeepL, Google, Azure, or
custom translation endpoint; there is no account and no server operated by the
project. MIT licensed.

Repository: https://github.com/Momoxiao/lingua-translate

The entry follows the format in CONTRIBUTING.md and matches the existing
Language & Translation section.
```

## Before submitting

- [ ] Request explicit approval from the repository owner.
- [ ] Confirm the target README still uses the same section and heading.
- [ ] Fork or create a branch from `master`.
- [ ] Make one commit containing only the single-line addition.
- [ ] Open the PR and answer any maintainer questions promptly.
