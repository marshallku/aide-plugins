# AIDE plugins

The community index of [AIDE](https://github.com/marshallku) device plugins: small JS packages
the AIDE app runs in a sandbox, with only the capabilities you approve on each device.

- Index: <https://marshallku.github.io/aide-plugins/plugins.json>. In server mode the AIDE server
  mirrors it (Settings → `plugins.indexURL`); in local mode the app reads it directly.
- Every version is reviewed. The index lists the exact bytes that were reviewed (a hash per file
  and per package), and published versions never change, even if the author's release does.

## Submitting a plugin (or a new version)

1. Release your package on GitHub. The release assets are the package files:
   `manifest.json`, `main.js`, and optionally `index.html` and `styles.css`.
2. Get the bundle hash:
   ```sh
   cd tools/check && go build -o aide-plugin-check . && ./aide-plugin-check --publish <folder with the assets>
   ```
   Versions must look like `1.2.3` or `1.2.3-beta.1`.
3. Open a pull request adding `submissions/<id>/<version>.json`:
   ```json
   {"repo": "you/your-plugin", "tag": "v1.2.3", "hash": "<hash from step 2>"}
   ```
   One id belongs to the repo that first published it. Old submissions stay; add a new file per version.
4. CI downloads the release, checks it with the same rules as the app, and writes a report with
   the files as published and the capability changes since your last version. A maintainer
   reviews that report. After merge the files are copied here and the index updates.

See [CONTRIBUTING.md](CONTRIBUTING.md) for what review looks for.

## Reporting a plugin

Open an issue with the "Report a plugin" template. A plugin found to be harmful is added to
`revoked.json` (one version by hash, or every version), and apps turn it off when they next read
the index.

## Layout

| Path | What |
| --- | --- |
| `submissions/<id>/<version>.json` | What was approved: repo, tag, bundle hash |
| `packages/<id>/<version>/` | The published files (written by CI only) |
| `revoked.json` | `[{"id", "hash"?, "reason"}]` |
| `tools/check/` | `aide-plugin-check`, vendored from the AIDE app repo (don't edit here) |
| `scripts/index.py` | check / publish / site build |
