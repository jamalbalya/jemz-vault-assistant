# Bug fix and iteration log

Produced by the bug-fix loop in main spec section 13, using the templates from addendum
appendix D. Every bug below was found by an automated check or an adversarial review pass,
fixed, and pinned with a regression test.

---

## Iteration log

| #             | Scope                                                  | Tests run | Passed  | Failed | Bugs found | Bugs fixed |
| ------------- | ------------------------------------------------------ | --------- | ------- | ------ | ---------- | ---------- |
| 1             | Obsidian mock gate                                     | 19        | 19      | 0      | 0          | 0          |
| 2             | Services + detectors (7 units, adversarially reviewed) | 584       | 584     | 0      | 21         | 21         |
| 3             | Ground-truth reconciliation after review               | 244       | 242     | 2      | 1          | 1          |
| 4             | View layer integration                                 | 665       | 663     | 2      | 2          | 2          |
| 5             | Known-answer fixture suite                             | 19        | 16      | 3      | 3          | 3          |
| 6             | Fix pipeline / safety suite                            | 19        | 11      | 8      | 2          | 2          |
| 7             | Lint and type cleanup                                  | 711       | 700     | 11     | 3          | 3          |
| 8             | View smoke suite                                       | 723       | 722     | 1      | 1          | 1          |
| **9 (final)** | **Everything**                                         | **723**   | **723** | **0**  | **0**      | **0**      |

Final state: 723 tests passing, 0 TypeScript errors, 0 lint errors, production build succeeds,
all performance targets met.

---

## Bug reports

Only bugs that reached a committed file are listed. Issues caught and fixed inside a single
authoring pass are not.

### BUG-001 — Corrupted frontmatter reported as missing metadata

- **Severity:** Critical · **Module:** health / scan-engine
- **Steps:** Scan a vault containing a note whose `---` block is not valid YAML.
- **Expected:** One `corrupted-frontmatter` issue.
- **Actual:** One `missing-metadata` issue; `corrupted-frontmatter` was never emitted through
  the real engine, though the detector produced it correctly in isolation.
- **Root cause:** `ScanEngine` snapshotted the scope _before_ `ContentIndex.ensureLoaded()`.
  Reading a file is what reveals a `---` fence whose YAML failed, and `VaultIndex` replaces
  records rather than mutating them, so the captured array kept `hasFrontmatterBlock: false`.
- **Fix:** Rebuild the scope after the content pass.
- **Regression test:** `health-scan.test.ts` → "separates a note with no frontmatter from one
  with broken frontmatter".

### BUG-002 — A detector's secondary category could not be enabled

- **Severity:** High · **Module:** health / scan-engine
- **Steps:** Disable `missing-metadata`, enable `corrupted-frontmatter`, scan.
- **Expected:** Corrupted-frontmatter issues still reported.
- **Actual:** Nothing reported.
- **Root cause:** The engine filtered detectors on `detector.type` alone, and the frontmatter
  detector's type is `missing-metadata`, so the whole detector was skipped.
- **Fix:** Added `Detector.emits`; a detector runs when any category it emits is enabled and
  checks each flag itself.
- **Regression test:** `health-scan.test.ts` → "runs a detector when only its secondary
  category is enabled".

### BUG-003 — Unrelated tags offered as a merge

- **Severity:** High · **Module:** services / tag-service
- **Steps:** Scan a vault using both `#meeting` and `#testing`.
- **Expected:** Two unrelated tags, left alone.
- **Actual:** One group, with `meeting` nominated as canonical because it was used more —
  meaning "merge tags" would have rewritten every `#testing` note to `#meeting`.
- **Root cause:** Two edits apart at length 7 satisfied the distance bound. `finance`/`fitness`
  collided the same way.
- **Fix:** Variants must also share a three-character opening
  (`health.tagMinSharedPrefix`, default 3). Documented tradeoff: a typo in the first character
  is no longer caught, which is far rarer than the false pairs removed.
- **Regression test:** `tag-service.test.ts` → "keeps unrelated same-length tags apart despite
  a small edit distance".

### BUG-004 — Process could never clear the inbox

- **Severity:** Critical · **Module:** services / inbox-service
- **Steps:** Process every item in the inbox.
- **Expected:** Inbox zero and the empty state.
- **Actual:** Every item still listed; inbox zero was unreachable.
- **Root cause:** Membership was "status `inbox` OR in the inbox folder", read literally.
  Captures live in the inbox folder, so setting `status: processed` changed nothing.
- **Fix:** An explicit terminal status (`processed`, `archived`) now wins over location;
  folder membership applies only to notes with no status yet. `ScanEngine` shares the rule so
  "skip the inbox" means the same thing in both places.
- **Regression test:** `inbox-view.test.ts` → "drops a processed note from the list even
  though it stays in the inbox folder", plus the membership truth table.

### BUG-005 — Find and Health disagreed about orphans

- **Severity:** Medium · **Module:** services / retrieval-service
- **Steps:** Compare the Health tab's orphan count with the "Orphan notes" saved view.
- **Expected:** The same number.
- **Actual:** Health said 5, Find said 15 — Find counted unprocessed captures.
- **Root cause:** The saved view used the detector's _definition_ but not the health module's
  inbox exclusion.
- **Fix:** The orphan view honours `health.excludeInbox`.
- **Regression test:** `known-answer.test.ts` → "runs the orphan saved view with the detector
  definition".

### BUG-006 — Backup could recursively delete the vault root

- **Severity:** Critical · **Module:** services / backup-service
- **Steps:** Corrupt or hand-edit `data.json` so a backup manifest carries `dir: ""`.
- **Expected:** The bad entry is ignored.
- **Actual:** `prune()` called `rmdir("", recursive)`; in real Obsidian `normalizePath("")` is
  `/`, so a routine prune would recursively delete the whole vault.
- **Root cause:** No confinement check on a path read from user-editable JSON.
- **Fix:** Only paths strictly inside the backup root are deleted, and the root itself is
  refused.
- **Regression test:** `backup-service.test.ts` → "refuses to delete a folder outside the
  backup root" and "refuses to delete the backup root itself".
- **Found by:** adversarial review; the in-memory mock had hidden it.

### BUG-007 — Markdown link corrupted when retargeted

- **Severity:** High · **Module:** services / link-service
- **Steps:** Retarget `[notes](<Old.md#My Summary>)`.
- **Expected:** A valid link.
- **Actual:** `[notes](New.md#My Summary)` — the `<>` that made the space legal were stripped
  while the subpath was copied over unencoded, so the destination ended at `New.md#My`.
- **Fix:** Encode the carried-over subpath; `%` is encoded in caller-supplied paths.
- **Regression test:** in `link-service.test.ts`.

### BUG-008 — Truncated index cache accepted

- **Severity:** Medium · **Module:** services / index-store
- **Steps:** Truncate `index-cache.json` mid-write, restart.
- **Expected:** The payload is discarded.
- **Actual:** It loaded, silently hiding notes from search.
- **Root cause:** The declared `count` was never compared with `entries.length`.
- **Fix:** A mismatch rejects the payload.
- **Regression test:** in `index-store.test.ts`.

### BUG-009 — Action log diverged from disk after a failed write

- **Severity:** Medium · **Module:** services / action-log-service
- **Steps:** Make `saveData` throw, then log an action.
- **Expected:** The entry is not recorded anywhere.
- **Actual:** `log()` threw "not recorded" while `entries()` still returned it, and the next
  unrelated settings write persisted it.
- **Fix:** Roll back the in-memory array and re-emit `settings-changed`.
- **Regression test:** in `action-log-service.test.ts`.

### BUG-010 — Valid empty frontmatter rejected as corrupt

- **Severity:** High · **Module:** services / metadata-service
- **Steps:** `ensureFrontmatterBlock()` then `setProperties()`.
- **Expected:** Properties written.
- **Actual:** `MetadataWriteError`, claiming the note's frontmatter could not be parsed — on a
  block the service had just created.
- **Root cause:** An empty block has no mapping for the cache to report, which was
  indistinguishable from a parse failure.
- **Fix:** A block whose YAML body is whitespace-only is writable; an unterminated fence or
  unparseable YAML still is not.
- **Regression test:** in `metadata-service.test.ts`.

### BUG-011 — Frontmatter cache handed out mutable internals

- **Severity:** Medium · **Module:** services / metadata-service
- **Steps:** `readFrontmatter(file).tags.push('injected')`.
- **Expected:** No effect on Obsidian's cache.
- **Actual:** The cache was corrupted for every later reader.
- **Fix:** Deep-copy sequences and mappings on read.
- **Regression test:** in `metadata-service.test.ts`.

### BUG-012 — Self-linking note could never be reported as an orphan

- **Severity:** Low · **Module:** health / orphan-notes
- **Root cause:** A self-link counted as an outgoing edge, but the backlink builder skips
  self-links, so `A.md` containing only `[[A]]` was invisible to both halves of the test.
- **Fix:** Self-links are excluded from the outgoing-link count.
- **Regression test:** in `orphan-notes.test.ts`.

### BUG-013 — Repeated required fields duplicated in the issue id

- **Severity:** Low · **Module:** health / missing-metadata
- **Root cause:** A key listed twice in settings (or as `type` and `type`) produced repeated
  entries, and since the id derives from the missing list, tidying the setting silently
  invalidated an existing ignore entry.
- **Fix:** Collapse on the trimmed key, preserving first-seen order.
- **Regression test:** in `missing-metadata.test.ts`.

---

## Test-quality defects

Three tests would have passed against a stub and were rewritten rather than deleted.

- **TQ-001** `backup-service.test.ts` "keeps only the ten most recent backups" passed because
  every `create()` was silently returning `null`. It now asserts each backup genuinely
  succeeds before checking the cap. This one was masked by an unfaithful mock — see MOCK-001.
- **TQ-002** `tag-inconsistencies.test.ts` "ignores notes whose frontmatter is corrupt" used a
  tag that also existed in a well-formed note, so the empty result proved nothing. Rewritten
  so the misspelling exists _only_ inside the broken block, plus a positive control.
- **TQ-003** `analytics-service.test.ts` never asserted that `clear()` installs a _copy_ of the
  defaults; a regression to sharing the module-level object would have leaked one vault's
  counters into every store built afterwards.

## Mock fidelity defects

The mock is the foundation every integration count rests on, so a wrong mock is a wrong test
suite.

- **MOCK-001** The `DataAdapter` kept its own file store, separate from the vault's. In real
  Obsidian the adapter _is_ the filesystem for the whole vault, so code that legitimately
  reads a note through the adapter appeared broken. This is what made every backup return
  `null`. Fixed by routing adapter reads, writes and deletes through the vault for vault
  paths.
- **MOCK-002** `getFirstLinkpathDest` scanned every file per link, making a 10 000-note index
  build quadratic — 4 419 ms, which looked like a plugin performance problem. Real Obsidian
  keeps a lookup map; the mock now does too. Index build dropped to **54 ms**, confirming the
  cost was never in the plugin.
- **MOCK-003** `Vault.configDir` was missing, so reading it returned `undefined`. Surfaced
  when the plugin stopped hardcoding `.obsidian`.
