# Manual verification checklist

From addendum appendix A. Everything that can be automated already is — 723 automated tests
cover the logic, and the numbers below are asserted in
`tests/integration/health-scan.test.ts`. What remains here needs a running Obsidian: real
hotkeys, a real on-screen keyboard, real touch targets, and real memory behaviour over time.

**Setup:** build with `npm run build`, copy `main.js`, `manifest.json` and `styles.css` into
`test-vault/.obsidian/plugins/jemz-vault-assistant/`, open `test-vault/` in Obsidian, enable
the plugin.

Legend: ☐ not run · ✅ pass · ❌ fail (file a bug in `BUG_LOG.md`)

---

## First run

|     | Check                                                                              |
| --- | ---------------------------------------------------------------------------------- |
| ☐   | Welcome modal appears once on first activation                                     |
| ☐   | Its three steps read clearly and the docs link opens                               |
| ☐   | "Create folders" creates `00-Inbox` and `04-Archive`; "Not now" creates nothing    |
| ☐   | The modal does not reappear after a reload                                         |
| ☐   | On a second device with the same synced vault, it _does_ appear (per-device state) |

## Capture

|     | Check                                                                                       |
| --- | ------------------------------------------------------------------------------------------- |
| ☐   | Modal opens from the command palette                                                        |
| ☐   | Modal opens from the ribbon compass icon                                                    |
| ☐   | Modal opens from an assigned hotkey                                                         |
| ☐   | Modal opens by clicking the status bar item                                                 |
| ☐   | Title field is focused on open                                                              |
| ☐   | Note is created in `00-Inbox` with the `YYYY-MM-DD [type] - [title].md` name                |
| ☐   | Frontmatter contains `created`, `type`, `status: inbox`, `source`, `tags`                   |
| ☐   | "Captured to inbox" notice appears                                                          |
| ☐   | An empty title auto-generates `Untitled YYYY-MM-DD HH-mm`                                   |
| ☐   | Capturing the same title twice appends ` 2`                                                 |
| ☐   | An invalid URL in Source blocks submission and explains why                                 |
| ☐   | Tag autocomplete suggests tags already used in the vault                                    |
| ☐   | Project dropdown lists notes with `type: project`                                           |
| ☐   | On a read-only vault: an error notice appears, the modal stays open, typed content survives |

## Inbox

|     | Check                                                                         |
| --- | ----------------------------------------------------------------------------- |
| ☐   | All 10 fixture items are listed, newest first                                 |
| ☐   | Each row shows type icon, created date, source domain, ~100-character preview |
| ☐   | Sort toggle switches to oldest first and the choice survives a reload         |
| ☐   | **Open** opens the note                                                       |
| ☐   | **Process** removes the row and sets `status: processed`                      |
| ☐   | **Task** rewrites the title line as `- [ ] …` and sets `type: task`           |
| ☐   | **Move** opens a folder picker and moves the file                             |
| ☐   | **Tag** adds the tag to frontmatter                                           |
| ☐   | **Link** opens a note picker and appends a wikilink                           |
| ☐   | **Archive** moves the note to `04-Archive` and marks it archived              |
| ☐   | **Delete** asks first, and offers "Archive instead"                           |
| ☐   | Cancelling the delete confirmation changes nothing                            |
| ☐   | Status bar inbox count tracks the list                                        |
| ☐   | Empty state appears once everything is processed                              |
| ☐   | With more than 50 items, pagination appears and works                         |

## Triage

|     | Check                                                                   |
| --- | ----------------------------------------------------------------------- |
| ☐   | Opens showing "Item 1 of 10"                                            |
| ☐   | `P` and `Enter` process                                                 |
| ☐   | `T` converts to task                                                    |
| ☐   | `M` opens the folder picker                                             |
| ☐   | `G` opens the tag input                                                 |
| ☐   | `L` opens the note picker                                               |
| ☐   | `A` archives                                                            |
| ☐   | `D` asks before deleting                                                |
| ☐   | `S` and `→` skip                                                        |
| ☐   | `←` returns to the previous item                                        |
| ☐   | `Esc` exits                                                             |
| ☐   | Shortcuts do nothing while a picker is open or focus is in a text field |
| ☐   | Progress counter updates as you go                                      |
| ☐   | Session summary counts match what you actually did                      |
| ☐   | "Continue triaging" resumes; "Done" closes                              |
| ☐   | Starting triage on an empty inbox explains that there is nothing to do  |

## Health

Expected on the unmodified fixture vault — see `TEST_VAULT_GROUND_TRUTH.md` for why each
number is what it is.

|     | Check                                                                  |
| --- | ---------------------------------------------------------------------- |
| ☐   | Not-scanned-yet state offers to run a scan                             |
| ☐   | Progress is shown during the scan                                      |
| ☐   | **8** broken links                                                     |
| ☐   | **25** orphan notes (the 5 in `Orphan Notes/` plus 20 incidental)      |
| ☐   | **3** empty notes                                                      |
| ☐   | **6** unused attachments                                               |
| ☐   | **2** duplicate title pairs                                            |
| ☐   | **3** tag inconsistency groups                                         |
| ☐   | **1** missing metadata                                                 |
| ☐   | **1** corrupted frontmatter, reported separately                       |
| ☐   | Health score reads **87**                                              |
| ☐   | `special chars - @#$%.md` handled without error                        |
| ☐   | `unicode-note-日本語.md` handled without error                         |
| ☐   | `corrupted-frontmatter.md` handled gracefully, not as missing metadata |
| ☐   | Excluding a folder in settings removes its findings on the next scan   |
| ☐   | Editing a note triggers an incremental rescan within ~2 s              |

## Health fixes

|     | Check                                                                                    |
| --- | ---------------------------------------------------------------------------------------- |
| ☐   | Preview modal lists the exact files and edits                                            |
| ☐   | Backup location is shown                                                                 |
| ☐   | **Cancelling leaves every file byte-identical**                                          |
| ☐   | Confirming applies the changes with a progress bar                                       |
| ☐   | Result summary reports applied / skipped / failed                                        |
| ☐   | The fixed issues are gone from the next scan                                             |
| ☐   | An action log entry is written                                                           |
| ☐   | Editing a file while the preview is open causes that file to be skipped, not overwritten |
| ☐   | Ignoring an issue removes it from future scans and it is listed in settings              |
| ☐   | Permanent deletion requires a second, differently worded confirmation                    |
| ☐   | **Restore last fix backup** puts the files back                                          |

## Find

|     | Check                                                                                 |
| --- | ------------------------------------------------------------------------------------- |
| ☐   | All six built-in views return sensible sets                                           |
| ☐   | Search returns results as you type, without lag                                       |
| ☐   | `projct` still finds the project notes                                                |
| ☐   | Filter by tag, by type and by date each narrow correctly                              |
| ☐   | AND vs OR changes the result set as expected                                          |
| ☐   | A custom view can be created, named, given an emoji, saved, pinned and reordered      |
| ☐   | It survives a reload                                                                  |
| ☐   | Deleting a custom view asks first                                                     |
| ☐   | Open, Open in new pane, Copy link and Pin all work                                    |
| ☐   | Matched text is highlighted in the snippet                                            |
| ☐   | **On this day** shows the 2023, 2024 and 2025 notes _when the system date is 15 June_ |
| ☐   | **Unlinked mentions** finds 2 targets in `note-with-unlinked-mentions.md`             |
| ☐   | "Convert to link" rewrites the note correctly                                         |
| ☐   | **Stale notes** shows 3, oldest first                                                 |
| ☐   | **Similar notes** shows a score and a "Link them" action                              |

> On this day and stale notes depend on today's date. The automated suite pins "now" to
> 2026-06-15; to reproduce those numbers by hand, set the system date to 15 June 2026.

## Dashboard, settings, status bar

|     | Check                                                                          |
| --- | ------------------------------------------------------------------------------ |
| ☐   | Tabs lazy-load — opening the dashboard does not trigger a scan                 |
| ☐   | Header stats update live                                                       |
| ☐   | All ten commands are present in the palette, including Restore last fix backup |
| ☐   | Every setting persists across a reload                                         |
| ☐   | Turning a module off cleanly disables its tab and explains how to re-enable it |
| ☐   | Status bar shows `📥 n                                                         | 🏥 n` and opens the dashboard when clicked |
| ☐   | Toggle status bar command hides and shows it                                   |
| ☐   | Analytics toggle is **off** on a fresh install                                 |
| ☐   | "View collected data" shows nothing while analytics are off                    |
| ☐   | Action log lists recent actions; Clear empties it                              |
| ☐   | Reset all settings asks first, then restores defaults                          |

## Performance

Measured automatically at these sizes (`npm run test:perf`, in-memory vault):
index build 54 ms · full scan 116 ms · incremental 37 ms · search 46 ms · capture 1 ms ·
cached body text 10 MB, all at 10 000 notes. Re-confirm in the real app, where disk I/O adds
on top:

|     | Check                            | Target                    |
| --- | -------------------------------- | ------------------------- |
| ☐   | Plugin load                      | < 500 ms                  |
| ☐   | Quick capture opens              | < 200 ms                  |
| ☐   | Full scan of a 10 000-note vault | < 30 s                    |
| ☐   | Search returns                   | < 500 ms                  |
| ☐   | Dashboard renders                | < 300 ms                  |
| ☐   | Memory after 10 minutes of use   | < 100 MB, no upward drift |

## Mobile

|     | Check                                                                       |
| --- | --------------------------------------------------------------------------- |
| ☐   | Plugin loads with no Node.js errors in the console                          |
| ☐   | Quick capture is full-screen and stays visible above the on-screen keyboard |
| ☐   | Every button is comfortably tappable (44 × 44 px minimum)                   |
| ☐   | Inbox rows stack and their actions remain reachable                         |
| ☐   | Triage overlay is usable one-handed                                         |
| ☐   | Find sidebar collapses to a horizontal strip                                |
| ☐   | Health fixes complete without freezing the UI                               |
| ☐   | The status bar item is absent (Obsidian does not render one on mobile)      |
