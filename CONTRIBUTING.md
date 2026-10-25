# Review guidelines

A submission is reviewed from the CI report (the release's actual files), not the source repo.

- **Readable code.** No minified or obfuscated `main.js`; bundlers are fine if the output stays
  readable. Reviewers must be able to see what runs.
- **Least capabilities.** Each capability should be needed by a visible feature. Note scopes
  (`notes:read:<folder>`) beat `*`. Every `net:<host>` needs a reason in the PR description.
- **No surprises.** The plugin does what its description says, sends nothing elsewhere, and
  doesn't try to reach anything outside the `aide.*` API.
- **Suitable for everyone.** AIDE is rated 4+ on the App Store, so the index lists nothing meant for an
  older audience: no mature, violent or sexual content, gambling or the like, in the plugin or what it
  shows. Plugins that would need an age gate aren't listed.
- **One id per repo.** Ids are first come, first served, and can't move to another repo.
- **Versions are immutable.** Fix a bad release with a new version.

Pull requests that change anything outside `submissions/` (scripts, workflows, `revoked.json`)
are reviewed as code by a maintainer.
