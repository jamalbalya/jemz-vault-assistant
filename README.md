# Jemz Vault Assistant

Capture, vault health, and smart retrieval in one unified dashboard for [Obsidian](https://obsidian.md).

Three problems every growing vault runs into, solved in one place:

- **Capture & inbox triage** — get a thought into the vault in seconds, then work the inbox down to zero with a keyboard-driven triage mode.
- **Vault health** — find broken links, orphan notes, empty notes, unused attachments, duplicate titles, misspelled tags and missing properties, then fix them safely.
- **Smart retrieval** — find notes without remembering where they are, using saved views and visual filters. No query language.

Everything runs locally. There are no network calls, and the optional analytics are off by default and never see your content.

---

## Install

### From Community Plugins

Settings → Community plugins → Browse → search for **Jemz Vault Assistant** → Install → Enable.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jamalbalya/jemz-vault-assistant/releases).
2. Copy them into `<your vault>/.obsidian/plugins/jemz-vault-assistant/`.
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

Requires Obsidian **1.7.2** or newer. Works on desktop and mobile.

---

## Getting started

On first run a short welcome tour offers to create the two folders the plugin uses —
`00-Inbox` for captures and `04-Archive` for archived notes. Nothing is created without your
say-so, and you can change both folders in settings.

Open the dashboard from the compass icon in the ribbon, or run **Jemz Vault Assistant: Open dashboard**.

---

## The three tabs

### Inbox

Lists everything waiting: notes with `status: inbox`, plus anything sitting in your inbox
folder that has not been given a status yet. Each item shows its type, creation date, source
domain and a short preview, with eight actions: open, process, convert to task, move, tag,
link, archive, delete.

**Triage mode** takes over the screen and walks you through one item at a time:

| Key           | Action              |
| ------------- | ------------------- |
| `P` / `Enter` | Process             |
| `T`           | Convert to task     |
| `M`           | Move to folder      |
| `G`           | Add tag             |
| `L`           | Link to note        |
| `A`           | Archive             |
| `D`           | Delete (asks first) |
| `S` / `→`     | Skip                |
| `←`           | Previous item       |
| `Esc`         | Exit                |

At the end you get a summary of what you did and how much is left.

### Health

A 0–100 score, a card per issue category, and the list of what was found. Eight checks:

| Check               | What it finds                                    |
| ------------------- | ------------------------------------------------ |
| Broken links        | Links pointing at notes that do not exist        |
| Orphan notes        | Notes with no links in and none out              |
| Empty notes         | Notes with little or no content                  |
| Unused attachments  | Files no note references                         |
| Duplicate titles    | Notes sharing a title                            |
| Tag inconsistencies | Tags that look like misspellings of each other   |
| Missing metadata    | Notes missing frontmatter properties you require |
| Large files         | Files above a size you set                       |

Notes with unparseable frontmatter are reported separately, because the fix is repairing the
YAML rather than adding properties.

**Nothing is ever changed without your review.** Every fix follows the same path: you select
issues, a preview modal lists the exact files and edits, a timestamped backup is written, and
only then are changes applied. If a file changed between the preview and the apply, it is
skipped rather than overwritten. Deletion moves files to the trash; permanent deletion needs a
second, separately worded confirmation. **Jemz Vault Assistant: Restore last fix backup**
undoes the most recent batch.

### Find

Saved views on the left, search and filters on the right.

Built in: Recent notes · Edited today · Inbox · Orphan notes · Notes without tags · Unlinked mentions.

Build your own from eleven filter types (keyword, tag, folder, property, created, modified,
status, type, has backlinks, has attachments, word count) combined with AND or OR, then pin
and reorder them. Search is fuzzy, so `projct` still finds your project notes.

Underneath the results sit four contextual panels: **On this day**, **Unlinked mentions**
(with one-click conversion to a real link), **Stale notes**, and **Similar notes** — the last
scored locally from shared tags, shared links and title likeness, with no AI and no network.

---

## Commands

All ten are available in the command palette and can be given hotkeys:

Open dashboard · Quick capture · Start triage · Run health scan · View inbox · View health ·
View find · Search notes · Toggle status bar · Restore last fix backup

---

## Settings

**General** — turn each of the three modules on or off, ribbon and status bar visibility, log level, page size.
**Capture & inbox** — inbox, archive and attachment-archive folders, default tags and type, folder auto-creation.
**Vault health** — scan frequency, exclusions by folder/tag/file type, required properties, size threshold, per-detector switches, score weights, ignore lists.
**Smart retrieval** — stale threshold, fuzzy sensitivity, results per page, archived-note visibility.
**Analytics** — off by default; see below.
**About** — version, links, and the action log of the last 100 things the plugin did.

---

## Privacy

- No network requests. Ever, for any core feature.
- Settings, saved views, ignore lists and the action log live in
  `.obsidian/plugins/jemz-vault-assistant/data.json`.
- Per-device UI state (such as having dismissed the welcome tour) uses local storage, so it
  never travels with a synced vault.
- Fix backups are written to `<config>/plugins/jemz-vault-assistant/backups/`, and the last
  ten are kept.
- **Analytics are opt-in and off by default.** If you turn them on, the plugin records
  anonymous counts only: which features were used, how long operations took, your platform,
  and a bucketed vault size. It never records note content, file names, folder names, tag
  names, links, or your vault path — and even then nothing is transmitted anywhere. Settings
  offers "view collected data" and "delete collected data".
- The plugin never downloads, updates or executes code outside a normal release.

---

## FAQ

**Will it change my notes without asking?**
No. Every write goes through a preview and an explicit confirmation, with a backup taken
first. Cancelling the preview leaves every file byte-identical.

**Why does the Health tab report so many orphan notes?**
An orphan is a note with no links in _and_ none out. Fresh vaults have lots of them; that is
normal, not an error. Unprocessed captures are excluded by default, and you can exclude
folders or ignore individual findings.

**Why is a note in my inbox folder still listed after I processed it?**
It should not be. Processing sets `status: processed`, which takes a note out of the inbox
regardless of where it lives. If it persists, the file may have unparseable frontmatter — the
Health tab will flag it.

**It suggested merging two tags that are not the same word.**
Tag matching needs both a small edit distance _and_ a shared three-character opening, which
keeps unrelated pairs like `meeting`/`testing` apart. If something still looks wrong, tune the
thresholds in settings or ignore that finding. Merging is never automatic.

**Does it work on mobile?**
Yes. There are no Node.js APIs anywhere in the bundle, modals go full-screen so the keyboard
cannot cover them, and touch targets meet the 44 px minimum. Obsidian does not render status
bar items on mobile, so that one item is desktop-only.

**Is it related to jemzsync?**
They are separate plugins in the same suite with no shared code or storage. If jemzsync is
installed, this plugin can show its status; if not, nothing changes.

---

## Development

```bash
npm install
npm run dev          # watch build
npm run build        # typecheck + production bundle
npm test             # 723 tests
npm run test:coverage
npm run test:perf    # benchmarks on 1k / 5k / 10k note vaults
npm run lint
npm run typecheck
```

Verified detector counts and the design decisions behind them are in
[TEST_VAULT_GROUND_TRUTH.md](TEST_VAULT_GROUND_TRUTH.md). Manual verification steps are in
[MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md), and the bug-fix history is in
[BUG_LOG.md](BUG_LOG.md).

`test-vault/` is the fixture the integration tests run against; open it in Obsidian to
reproduce the numbers by hand.

## Licence

MIT — see [LICENSE](LICENSE).
