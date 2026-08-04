# Test vault ground truth

Verified counts for the on-disk `test-vault/`, produced by the real detectors through the
real `ScanEngine` and asserted in `tests/integration/health-scan.test.ts`.

Three numbers differ from the original `TESTING_GUIDE.md` draft. Each difference is explained
below — in every case the guide's number was a good-faith estimate and the fixture actually
contains something else.

---

## 1. Verified counts

Default settings, which exclude the inbox from health scans.

| Issue                       | Count | Score impact                   |
| --------------------------- | ----- | ------------------------------ |
| Broken links                | 8     | −4.0                           |
| Orphan notes                | 25    | −5.0                           |
| Empty notes                 | 3     | −0.9                           |
| Unused attachments          | 6     | −0.6                           |
| Duplicate title pairs       | 2     | −1.0                           |
| Tag inconsistency groups    | 3     | −0.9                           |
| Missing metadata            | 1     | −0.3                           |
| Corrupted frontmatter       | 1     | −0.0 (informational, weight 0) |
| Large files (10 MB default) | 0     | −0.0                           |
| **Total penalty**           |       | **−12.7**                      |
| **Health score**            |       | **87**                         |

Contextual features, with "today" pinned to **2026-06-15** (the date the fixture is written
around):

| Feature                                               | Result                                       |
| ----------------------------------------------------- | -------------------------------------------- |
| On This Day                                           | 3 notes (2023-06-15, 2024-06-15, 2025-06-15) |
| Unlinked mentions in `note-with-unlinked-mentions.md` | 2 targets (Project Alpha, Atomic Habits)     |
| Stale notes (>180 days, archived excluded)            | 3                                            |
| Inbox items                                           | 10                                           |

---

## 2. Where the numbers come from

**Broken links = 8.** Three in `broken-link-note.md`, five in `multiple-broken-links.md`.
A ninth unresolved wikilink exists — `[[Product Design Principles]]` in
`00-Inbox/2026-06-14 reference - onboarding article.md` — but the inbox is excluded from
health scans by default, so it is not reported. Turning `health.excludeInbox` off yields 9,
which `health-scan.test.ts` also asserts.

**Orphan notes = 25, not 5.** The guide counted the five notes in `Orphan Notes/`. Those five
are intentional, but twenty further notes genuinely have no links in and none out: every note
in `Problem Notes/` except the two with broken links, both `Unlinked Mentions/` notes that are
not `Project Alpha`, `Article - PKM Best Practices.md`, `Meeting Note Template.md`,
`Completed Goals 2025.md`, `Daily Notes/2023-06-15.md`, and `Daily Notes/2026-06-13.md`. The
detector is right; the fixture simply has more orphans than the guide assumed. The test
asserts both the total and that all five intentional orphans are among them.

**Duplicate pairs = 2, not 1.** Besides the intended
`duplicate - Project Ideas` / `duplicate - Project Ideas 2` pair, the fixture contains
`Project Alpha.md` twice — once in `01-Projects/Project Alpha/` and once in
`Unlinked Mentions/`. That is an exact title collision and is correctly reported.

**Missing metadata = 1.** `missing metadata note.md` has no frontmatter at all.
`corrupted-frontmatter.md` opens with a `---` fence whose YAML does not parse; it is reported
separately as `corrupted-frontmatter` rather than as missing properties, because the fix is
repairing the YAML, not appending keys underneath a broken fence.

**Tag inconsistencies = 3.** `projek`→`project`, `developement`→`development`,
`testting`→`testing`.

---

## 3. Changes made to the fixture

Three additive changes; nothing existing was removed or rewritten.

1. **`99-Attachments/images/used-image-2.jpg` added.** `Meal Planning.md` embeds it, but the
   file was missing — which produced a spurious broken link and left used attachments at 2
   instead of the documented 3.
2. **`99-Attachments/images/unused-image-2.jpg` added.** Brings the folder to the 9
   attachments / 6 unused that both `TESTING_GUIDE.md` and addendum §12.5 describe.
3. **`Alpha - Timeline.md` gained the tags `development` and `testing`.**
   `tag inconsistency note.md` states its own intent — "developement should be development,
   testting should be testing" — but neither correct spelling existed anywhere in the vault,
   so only one of the three intended groups could ever be detected.

---

## 4. Design decisions the numbers depend on

| #   | Decision                                                                                     | Why                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Health scans skip the inbox (`health.excludeInbox`, default on)                              | Unprocessed captures are not vault decay. Without this, every fresh capture is instantly an orphan with a broken link.                                                                                                                  |
| D2  | Broken links cover wikilinks _and_ embeds                                                    | A missing image is a broken link.                                                                                                                                                                                                       |
| D3  | "Empty" measures the body with frontmatter stripped                                          | Measuring the raw file finds nothing, since frontmatter alone exceeds 20 characters.                                                                                                                                                    |
| D4  | Duplicate titles: exact match after normalisation, plus fuzzy only for titles ≥ 20 chars     | A bare ">90 % similar" rule flags `orphan-idea-1`/`-2`, `stale-note-2023`/`2024` and `empty-note-1`/`2`. Normalisation strips a trailing copy counter (` 2`) but never a year.                                                          |
| D5  | Tag variants need a shared 3-character prefix as well as a small edit distance               | Distance alone pairs `meeting` with `testing` and `finance` with `fitness` — both two edits apart and unrelated. The cost is that a typo in the first character (`broject`) is missed, which is far rarer than the false pairs removed. |
| D6  | Staleness prefers frontmatter `modified`, falls back to file mtime, and skips archived notes | A synced or restored vault has file timestamps that say nothing about when the user last thought about a note. Archived notes have already been dealt with.                                                                             |
| D7  | Every date-dependent service takes an injectable "now"                                       | Determinism under test.                                                                                                                                                                                                                 |
| D8  | Link resolution: exact path → same folder → fewest segments → alphabetical                   | Mirrors Obsidian, and matters because `Project Alpha.md` exists twice.                                                                                                                                                                  |
| D9  | Corrupt frontmatter is its own issue type, never "missing metadata"                          | Different fix, and appending keys under a broken fence would corrupt the file further.                                                                                                                                                  |
| D10 | An explicit `status` beats folder location for inbox membership                              | "status inbox OR in the inbox folder", read literally, makes **Process** a no-op for every captured note, since they all live in the inbox folder.                                                                                      |

---

## 5. The built fixture vs this vault

Addendum §12.5 asks for a separate, purpose-built fixture with exact counts. It lives in
`tests/fixtures/known-answer-vault.ts` and is asserted by
`tests/integration/known-answer.test.ts`.

The essential difference: in the built fixture **every note is connected to the graph except
the five designated orphans**, which is what makes "orphans = 5" and therefore the documented
"score ≈ 92" reproducible. The on-disk vault leaves twenty more notes incidentally unlinked,
so it scores 87. Both are correct; they are different vaults.

| Issue               | Built fixture | On-disk vault |
| ------------------- | ------------- | ------------- |
| Broken links        | 8             | 8             |
| Orphans             | 5             | 25            |
| Empty notes         | 3             | 3             |
| Unused attachments  | 6             | 6             |
| Duplicate pairs     | 1             | 2             |
| Tag inconsistencies | 3             | 3             |
| Missing metadata    | 1             | 1             |
| Unlinked mentions   | 2             | 2             |
| Stale notes         | ≥ 3           | 3             |
| **Health score**    | **92**        | **87**        |

### One contradiction inside §12.5

The addendum asks for `missing metadata = 1` "when required fields are configured as created,
type, status, tags", and simultaneously for five orphans of which "one is also missing tags".
Those cannot both hold: a note with no tags necessarily fails a required `tags`. The built
fixture therefore uses `created, type, status` as the required list, which gives exactly 1.
A dedicated test adds `tags` back, asserts the count becomes 2, and names both notes — so the
interaction is covered rather than papered over.
