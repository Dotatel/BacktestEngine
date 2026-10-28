# Bundled report extensions

These data-only example manifests ship inside the desktop executable. The Extensions page installs one only after the user chooses **Install example**. Installation uses the same parser, integrity receipt and local registry as a folder import and leaves the extension disabled until the user explicitly enables its reviewed manifest.

- `report-tools`: original JSON, trade-ledger CSV and HTML report exports.
- `trade-ledger-export`: trade-ledger CSV export.
- `html-reports`: HTML report export.

Only the app's existing trusted export handlers run. The manifests contain no scripts, entry points, arbitrary file access or network permissions. Exports still require a selected saved report and an explicit native save dialog. An installed identity is never overwritten by installing an example again.
