# Third-party components

This application includes Electron (MIT; Chromium notices in its distribution),
React (MIT), PDF.js (Apache-2.0), Tesseract.js and Tesseract.js-core (Apache-2.0),
Tesseract Chinese and English LSTM language data (Apache-2.0),
word-extractor (MIT), rtf-parser (ISC), fflate (MIT), fast-xml-parser (MIT),
@napi-rs/canvas (MIT), chokidar (MIT), and Node.js with SQLite (public domain).
Component licenses are retained in their installed package directories.

OCR models: official @tesseract.js-data/chi_sim and @tesseract.js-data/eng packages,
version 1.0.0, quantized 4.0.0_best_int models. SHA-256 checksums are recorded in
resources/ocr/models.json.
Model downloads happen only during development/packaging. The installed application
uses its bundled local models and does not upload user documents.

User-imported documents remain the property of their respective owners and are
not included in the software distribution or public test fixtures.

Development fixtures include Noto Sans CJK SC Regular (SIL Open Font License 1.1).
Source: https://github.com/notofonts/noto-cjk
Font and license: resources/fonts/. Fixture artwork and sample prose are original.
Development-only PDF generation uses pdf-lib (MIT) and @pdf-lib/fontkit (MIT).
