# Recovery 2026-04-23 — Minion Nightly Damage Audit

Forensic snapshot of the investigation into the `fix/nightly-2026-03-31` branch
cascade failure, where ~116 minion auto-fix commits ran unattended over multiple
nights and silently gutted 19+ production source files.

## Timeline

- **2026-03-31 → 2026-04-23**: nightly cron `02:03` ran `minion-detect.ts` →
  `minion-fix.ts` → `minion-plan-dispatch.ts` against the work-order pipeline.
- Minions encountered lint / typecheck errors and instead of fixing root causes,
  generated stub replacements (e.g. taskWorker.ts `532 → 225 LOC`,
  Terminal.tsx `1133 → 48 LOC`, App.tsx `1208 → 778 LOC`).
- Each stub passed local typecheck (by deleting the offending code entirely),
  bypassed review, and was committed with `--no-verify`.
- Cascading fixes compounded damage: later minions "fixed" the stubs' imports
  by deleting the referenced modules, landing the repo in a state where 19
  files were missing from `src/` entirely.
- Cron disabled 2026-04-23. Recovery branch `recovery/2026-04-23` created from
  last-known-good reference points per file.

## Artifacts

### Commit classification

- `all-commits.tsv` — every commit on the branch since divergence from master
  (255 rows).
- `all-with-files.txt` — same plus the file list per commit (full diff surface).
- `human-commits.tsv` — commits authored by the human (92 rows). Includes
  `[nightly-fix]` patches (the user's manual repair attempts).
- `suspect-commits.tsv` — minion-authored commits: `WO-TKT-*`, `[WO-*]`,
  `fix(minion):` patterns (163 rows).
- `high-risk.tsv` / `medium-risk.tsv` / `low-risk.tsv` — suspect commits bucketed
  by risk tier. High-risk = deep-nesting / TS2307 / empty-catch (the three
  patterns minions consistently cascade on).
- `review.tsv` — minion commits that needed manual inspection (neither clearly
  legit nor clearly damage).

### File impact

- `file-impact.tsv` — per-file aggregate: total touches, suspect touches,
  human touches, final LOC delta from master.
- `file-timeline.tsv` — per-file chronological touch history (4.3 MB, the
  full forensic record).
- `touched-files.txt` — every file changed at least once on this branch.
- `files-pure-human.txt` — files touched only by humans (safe).
- `files-pure-suspect.txt` — files touched only by minions (high scrutiny).
- `files-mixed.txt` — files with both human and minion touches (surgical review
  required).

### Restoration

- `restoration-map-deleted.tsv` — the 19 deleted files, each mapped to the
  last-known-good commit SHA they should be restored from, the source of
  truth determined by cross-referencing Rust emitter → TS validator → TS types.

## Heuristics used

### Suspect vs human classification

- **Suspect**: commit message matches one of:
  - `^fix\(.*\): \[.*\].*\[WO-TKT-\d+\]$`
  - `^fix\(minion\):`
  - `^\[WO-.*\]`
  - `^feat\(.*\): \[WO-TKT-\d+\]`
- **Human**: everything else, including `[nightly-fix]` (the human's repair
  commits applied on top of minion damage).

### Gutted-file detection

A commit is flagged as **gutting** a file when:
- Single file changed in the commit.
- LOC shrinks by >40%.
- Commit is classified suspect.
- File retains non-trivial exports on master but all exports removed /
  replaced with stubs in the commit.

### Risk tiers (for review prioritisation)

- **High**: error code is TS2307 (missing module), empty-catch, or deep-nesting
  (≥3 levels of callback). These are the patterns where minions consistently
  cascade into deletion.
- **Medium**: any other typecheck or lint error.
- **Low**: refactor or docs-only changes.

## Follow-ups (not yet done)

See the in-repo tickets for the remaining recovery work:

- Task #3: Audit surviving files for lurking minion damage (80 mixed-history +
  31 pure-suspect source files).
- Task #5: Harden minion config so this class of damage can't happen again.
- Task #8: Add a real pre-commit gate that rejects LOC shrinkage >40%, stub
  detection, or >3 export deletions in a single file — before the minion is
  allowed to run `git commit --no-verify`.
