# Changelog

All notable changes to Jemz Vault Assistant are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-08-29

A bug-fix release from a full audit of the plugin. Nothing here is a new feature; several of
the fixes change what the plugin does, which is why this is a minor rather than a patch
release. Every fix ships with a test that fails without it.

### Fixed

- **A health scan no longer freezes Obsidian on a vault whose notes have descriptive names.**
  The duplicate-title pass compared every title with every other one and computed each edit
  distance in full: 80 seconds of frozen UI on 5,000 such notes, and close to five minutes on
  10,000. A vault whose notes are called `note-1`, `note-2` never reached the pass at all,
  which is why no benchmark had caught it. Same duplicates reported, 2.8 seconds.
- **The Unlinked mentions view no longer searches the whole vault for every note.** It scanned
  each note's body once per note title in the vault, and rebuilt the search order every time:
  3.4 seconds on 2,000 notes, well over a minute on 10,000. Now 0.25 seconds, reporting
  exactly the same mentions.
- **"Create note" on a broken link now creates the note where the link points.**
  `[[Projects/Roadmap]]` addresses a path, and the note was created in the inbox folder
  instead — so the fix reported success and left the link exactly as broken as it was.
- **A capture no longer writes frontmatter Obsidian cannot read.** A source typed as
  `[1] Deep Work` broke the whole properties block; one typed as `#Roadmap` was read as a
  comment and silently became empty. Values are now quoted whenever YAML would misread them.
- **Archiving two same-named files from different folders keeps both.** They were planned into
  one destination, and the second move failed against a preview that promised it would work.
- **The Find tab's Orphans list and the Health tab's orphan count agree again.** A note whose
  only link points at itself was an orphan in one tab and not in the other.
- **Capture and triage are counted again when analytics are switched on.** Both call sites
  named event ids that were not on the allow-list, so those counters stayed at zero and every
  capture logged a warning to the console.
- **The tag prompt inside triage offers the vault's tags**, most used first. It had no
  autocomplete at all, while the identical prompt in the inbox list did.
- Disabling the plugin or quitting Obsidian with triage open no longer leaves a session
  summary behind, offering to start a session against services that are shutting down.
- The Find tab, the filter rows and the health dashboard no longer accumulate event listeners
  as they redraw. Besides the leak, a control that had been rendered away could still act:
  a stale saved-view button still toggled its view, and a stale filter row still edited the
  filter list.
- A note that links to itself is no longer recorded as its own backlink after it is edited,
  which had made the `has backlinks` search filter disagree with itself.

### Security

- A backup folder recorded in `data.json` can no longer escape the backup folder with a `..`
  segment. The path is confined by a prefix test, and `..` survived it while resolving
  somewhere else entirely — turning routine housekeeping into a recursive delete outside the
  folder the check exists to confine it to. The same guard now covers restoring a backup, and
  the note a broken-link fix creates.

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
