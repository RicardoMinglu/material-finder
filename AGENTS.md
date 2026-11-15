# Material Finder contributor workflow

Use Node.js 24.11.1. Keep the single-folder, offline desktop scope and the existing database schema unless the user requests a migration. The renderer only accesses validated preload IPC; SQL belongs in utility processes.

Use original generated fixtures and isolated application profiles for tests. Never read a contributor's personal library by default. Build artifacts, caches, recordings and benchmark databases remain in ignored directories. Do not publish artifacts or modify external websites as part of ordinary builds.

Run `npm run typecheck`, `npm test`, and `npm run build` after code changes. Run `npm run smoke` for desktop changes. Search changes require the differential ranking tests and the 10,000-page benchmark. Record Windows-native validation separately from cross-built binaries.

Do not run Mac and Windows packaging concurrently: both use `dist/` and `release/`. Mac packaging reuses the installed ARM64 Electron runtime after verifying architecture/version. Store packaging requires a separate public identity and a stable version number.
