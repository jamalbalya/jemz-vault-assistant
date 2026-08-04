# Changelog

All notable changes to Jemz Vault Assistant are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-08-04

Addresses every warning and recommendation raised by the Obsidian community-plugin review.

### Changed

- **`minAppVersion` raised to 1.13.0.** Three of the review's findings — the declarative
  settings API, `setDestructive`, and the `display()` deprecation — can only be resolved with
  1.13 APIs. The plugin had no released users, so requiring the current Obsidian costs nothing
  and clears them properly rather than suppressing them.
- Deletion now goes through `FileManager.trashFile()` instead of `Vault.trash()`, so it
  honours the user's own "Deleted files" preference (system trash, vault trash, or permanent)
  rather than the plugin forcing one.
- Settings adopt the declarative `getSettingDefinitions()` API, so every setting is reachable
  from Obsidian's settings search.
- Informational logging dropped to debug level; the plugin no longer writes to the console
  during ordinary use.

### Removed

- The `execCommand` clipboard fallback. The async clipboard API is available everywhere the
  plugin now runs, so the deprecated path was dead code.

### Fixed

- A broken-link fix batch no longer lists files whose recorded offsets have gone stale. Such a
  file would have appeared in the preview as "will change" and then silently not changed;
  it is now dropped from the plan, and a batch with nothing left to do says so.

### Security

- Release artifacts are built in GitHub Actions and signed with build provenance. Verify with
  `gh attestation verify main.js --repo jamalbalya/jemz-vault-assistant`.

## [1.0.0] — 2026-08-04

First release.

### Capture and inbox triage

- Quick capture modal with title, body, tags, type, source and project fields, reachable from
  a command, the ribbon, a hotkey or the status bar.
- Auto-generated titles, filename sanitising, and a numeric suffix when a name is taken.
- Inbox list with type icons, dates, source domains, 100-character previews and pagination.
- Eight per-item actions: open, process, convert to task, move, add tag, link, archive, delete.
- Full-screen triage mode with keyboard shortcuts and an end-of-session summary.

### Vault health

- Eight detectors: broken links, orphan notes, empty notes, unused attachments, duplicate
  titles, tag inconsistencies, missing metadata and large files. Notes whose frontmatter fails
  to parse are reported as their own category.
- Configurable 0–100 health score with per-category weights and caps.
- Full, incremental and scheduled scans, chunked so the UI never blocks, with an optional
  off-thread pass for the similarity comparisons.
- Fix pipeline that always previews before writing: select, review the exact changes, confirm,
  apply with a progress bar, and read a result summary.
- Timestamped backups before every batch, the last ten retained, restorable through
  **Restore last fix backup**.
- Conflict detection: a file changed since the preview is skipped, never overwritten.
- Per-issue-type ignore lists that persist across scans.
- Rolling log of the last 100 actions, viewable in settings.

### Smart retrieval

- Fuzzy search with an edit-distance fallback, so `projct` still finds project notes.
- Eleven filter types combined with AND or OR.
- Six built-in saved views plus custom views that can be pinned and reordered.
- On this day, unlinked mentions with one-click conversion, stale notes, and locally computed
  similar notes.

### Platform

- Unified dashboard with three lazily-mounted tabs, a status bar item and ten commands.
- One-time welcome tour that offers — never assumes — to create the default folders.
- Opt-in analytics, off by default, anonymous and aggregate only.
- Optional, gracefully degrading detection of the sibling jemzsync plugin.
- Mobile compatible: no Node.js APIs, full-screen modals, 44 px touch targets.

### Notes on the specification

Three decisions deviate from the written specification, each because following it literally
would have produced a broken or misleading result. All three are covered by tests.

- **`minAppVersion` is 1.7.2, not 1.4.0.** The specification mandates
  `FileManager.processFrontMatter` for all frontmatter writes, which needs 1.4.4; the APIs
  actually used push the true minimum to 1.7.2. Declaring 1.4.0 would have crashed on older
  builds.
- **An explicit `status` beats folder location for inbox membership.** Read literally,
  "status `inbox` OR in the inbox folder" makes **Process** a no-op for every captured note,
  since captures live in the inbox folder — inbox zero would be unreachable.
- **Tag similarity requires a shared three-character prefix** as well as a small edit
  distance. Distance alone pairs `meeting` with `testing` and `finance` with `fitness`.

[1.0.0]: https://github.com/jamalbalya/jemz-vault-assistant/releases/tag/1.0.0
