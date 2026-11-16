# Material Finder · 资料快搜

[![Check source](https://github.com/RicardoMinglu/material-finder/actions/workflows/check.yml/badge.svg)](https://github.com/RicardoMinglu/material-finder/actions/workflows/check.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Search Chinese PDFs, scans, images and Word documents offline, then jump to the original passage.

[中文](README.md) · [Quick start](docs/quickstart.en.md) · [Architecture](docs/architecture.md) · [Verification](docs/VERIFICATION.md)

![Search and original-page preview](docs/images/search.png)

Material Finder is a desktop application for finding text in documents already on your computer. It includes Chinese/English OCR, incremental indexing, page highlights, resumable processing and copying an excerpt with its source location. No account or model API is required. The UI is currently Chinese.

## Current release

**1.1.0-rc.1 is a release candidate**, targeting Windows 10/11 x64 and Apple Silicon macOS. Installers are unsigned and the Mac build is not notarized. Check the SHA-256 file and platform-specific verification status before installing. Cross-building Windows artifacts is not Windows runtime validation.


| Download | Platform | Validation status |
|---|---|---|
| [Mac installer (177 MiB)](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/MaterialFinder-1.1.0-rc.1-mac-arm64.dmg) | Apple Silicon | Packaged runtime, OCR and network-blocked tests passed locally |
| [Windows candidate (154 MiB)](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/MaterialFinder-1.1.0-rc.1-win-x64.exe) | Windows 10/11 x64 | Same-source packaged app passed CI runtime tests; manual installation, upgrade, offline and high-DPI acceptance pending |

[Release notes and checksums](https://github.com/RicardoMinglu/material-finder/releases/tag/v1.1.0-rc.1) · [29-second demo](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/material-finder-demo.mp4) · [Original demo documents](https://github.com/RicardoMinglu/material-finder/releases/download/v1.1.0-rc.1/material-finder-demo-fixtures.zip) · [Installation FAQ](docs/faq.md)

End users only need an installer; Node.js and the source checkout are for development. See the [roadmap and pilot feedback](docs/ROADMAP.md).

Select one root folder, type a phrase or space-separated keywords, and click a result to inspect its source. All keywords must match. Subfolders are included. Switching roots replaces the index after confirmation and never deletes original documents. Completed pages are searchable while OCR continues.

Supported formats: PDF, PNG, JPEG, WebP, BMP, TIFF, DOC, DOCX and RTF. Word is located by paragraph or embedded image, not original page layout. Images in legacy DOC files are not OCRed. Unlock encrypted files first. Handwriting, equations, stretched images and poor scans are not guaranteed to be recognized.

## Develop

Use Node.js **24.11.1** and npm:

```sh
git clone https://github.com/RicardoMinglu/material-finder.git
cd material-finder
npm ci
npm run assets
npm run typecheck
npm test
npm run dev
```

Development dependency installation needs a network connection. Installed applications include their OCR models and work offline. Test fixtures use the bundled OFL-licensed Noto font and original synthetic content, never personal documents.

```sh
npm run build
npm run smoke
npm run fixtures:quality
npm run validate:quality
npm run fixtures:scale
npm run validate:scale
npm run benchmark:ui
npm run pack:mac
# Prepare Windows native modules before a Windows build:
node scripts/prepare-win-runtime.mjs
npm run pack:win
npm run checksums
```

Checks and manual installer builds are separate GitHub workflows; neither publishes releases. Store packaging is optional and needs your own public Partner Center identity and a stable version number.

## Privacy and storage

There is no telemetry, cloud OCR, login, or automatic update service. Copying a citation writes to your system clipboard; opening an original invokes your system's associated app. The database and immutable document snapshots remain under the application's local data directory. Unreferenced caches are collected while indexing is idle. The existing 1.0.1 database schema is preserved.

## Contribute and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Useful contributions include public minimal reproduction documents, parsing fixes, benchmarks and documentation. Do not attach personal files or full indexes to issues.

MIT. Third-party component and font licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
