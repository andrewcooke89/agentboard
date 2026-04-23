//! Pre-commit damage guard. Detects the "minion stubbed a file to pass typecheck"
//! pattern that caused the 2026-04-23 recovery. Runs after `git add`, before
//! `git commit`. If damage is detected, the staged diff is rejected, the minion
//! must retry, and the working tree is left unchanged (the caller is responsible
//! for unstaging).
//!
//! Three rules:
//!   1. LOC shrink: single-file commit where new LOC < 60% of old LOC (old >= 50 lines).
//!   2. Stubbed: file becomes an exports-only shell (no real implementation).
//!   3. Export-delete: >3 exported symbols removed.
//!
//! The guard is *advisory on edit, hard on commit* — it never rewrites the file,
//! only reports and blocks.
//!
//! Tuning: thresholds were chosen to catch every known damage case from the
//! 2026-04-23 cascade (Terminal.tsx 1133→48, taskWorker.ts 532→225, cronManager
//! and friends) while leaving legitimate multi-file refactors alone. Refactors
//! that split a file into multiple files commit all of them together, so the
//! "single-file commit" gate is the primary safety valve.

use anyhow::{Context, Result};
use std::path::Path;
use std::process::Command;

/// One detected damage finding. `file` is the path being committed, `rule`
/// identifies which check fired, `detail` is a human-readable explanation.
#[derive(Debug, Clone)]
pub struct DamageFinding {
    pub file: String,
    pub rule: DamageRule,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DamageRule {
    LocShrink,
    Stubbed,
    ExportDelete,
}

impl DamageRule {
    pub fn as_str(self) -> &'static str {
        match self {
            DamageRule::LocShrink => "loc_shrink",
            DamageRule::Stubbed => "stubbed",
            DamageRule::ExportDelete => "export_delete",
        }
    }
}

/// Result of a damage check across a set of staged files.
#[derive(Debug, Clone, Default)]
pub struct DamageReport {
    pub findings: Vec<DamageFinding>,
}

impl DamageReport {
    pub fn is_clean(&self) -> bool {
        self.findings.is_empty()
    }

    /// Multi-line human-readable summary for logs and commit-block messages.
    pub fn summary(&self) -> String {
        if self.findings.is_empty() {
            return "damage_guard: no findings".to_string();
        }
        let mut out = format!(
            "damage_guard: {} finding(s) — commit blocked:\n",
            self.findings.len()
        );
        for f in &self.findings {
            out.push_str(&format!("  [{}] {} — {}\n", f.rule.as_str(), f.file, f.detail));
        }
        out
    }
}

/// Config thresholds. Keep simple so tests can override cleanly.
#[derive(Debug, Clone)]
pub struct DamageThresholds {
    /// Below this LOC a file is too small to reasonably flag.
    pub min_old_loc: usize,
    /// New LOC must be at least this ratio of old LOC.
    pub min_retained_ratio: f64,
    /// Max export signatures allowed to be removed in one commit.
    pub max_exports_removed: usize,
    /// For stub detection: if new file has fewer than this many non-trivial
    /// lines (after stripping comments / imports / exports), flag it.
    pub stub_max_body_lines: usize,
}

impl Default for DamageThresholds {
    fn default() -> Self {
        Self {
            min_old_loc: 50,
            min_retained_ratio: 0.60,
            max_exports_removed: 3,
            stub_max_body_lines: 3,
        }
    }
}

/// Run the damage guard over a list of staged files. `working_dir` is the repo
/// root; `changed_files` are repo-relative paths.
///
/// Comparing HEAD's blob to the staged blob. If HEAD doesn't have the file
/// (i.e. this is a new file), none of the rules apply — brand-new files
/// are always allowed through.
pub fn check_damage(
    changed_files: &[String],
    working_dir: &Path,
    thresholds: &DamageThresholds,
) -> Result<DamageReport> {
    let mut report = DamageReport::default();
    let single_file_commit = changed_files.len() == 1;

    for file in changed_files {
        // Skip files we have no expectation of being TS/Rust/source.
        if !is_source_file(file) {
            continue;
        }

        let head_content = match read_head_blob(file, working_dir)? {
            Some(c) => c,
            None => continue, // new file — no damage possible
        };
        let staged_content = match read_staged_blob(file, working_dir)? {
            Some(c) => c,
            None => continue, // being deleted — typecheck will catch unused refs
        };

        let old_loc = line_count(&head_content);
        let new_loc = line_count(&staged_content);

        // Rule 1: LOC shrink. Only for single-file commits — refactors that split
        // into multiple files commit all siblings together, which we allow.
        if single_file_commit
            && old_loc >= thresholds.min_old_loc
            && (new_loc as f64) < (old_loc as f64) * thresholds.min_retained_ratio
        {
            report.findings.push(DamageFinding {
                file: file.clone(),
                rule: DamageRule::LocShrink,
                detail: format!(
                    "LOC went {old_loc} → {new_loc} ({:.0}% retained, threshold {:.0}%)",
                    (new_loc as f64 / old_loc as f64) * 100.0,
                    thresholds.min_retained_ratio * 100.0
                ),
            });
        }

        // Rule 2: stubbed. New file has almost no real body — only imports and
        // exports. This catches minions who keep the type contract but delete
        // the implementation.
        if old_loc >= thresholds.min_old_loc && is_stub(&staged_content, thresholds.stub_max_body_lines) {
            report.findings.push(DamageFinding {
                file: file.clone(),
                rule: DamageRule::Stubbed,
                detail: format!(
                    "file body shrank to ≤{} non-trivial lines while type surface preserved",
                    thresholds.stub_max_body_lines
                ),
            });
        }

        // Rule 3: export-delete. Count named exports before and after.
        let old_exports = collect_exports(&head_content);
        let new_exports = collect_exports(&staged_content);
        let removed: Vec<&String> = old_exports
            .iter()
            .filter(|e| !new_exports.contains(e))
            .collect();
        if removed.len() > thresholds.max_exports_removed {
            report.findings.push(DamageFinding {
                file: file.clone(),
                rule: DamageRule::ExportDelete,
                detail: format!(
                    "{} exports removed (threshold {}): {}",
                    removed.len(),
                    thresholds.max_exports_removed,
                    removed
                        .iter()
                        .take(6)
                        .map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        }
    }

    Ok(report)
}

fn is_source_file(path: &str) -> bool {
    matches!(
        path.rsplit('.').next(),
        Some("ts") | Some("tsx") | Some("js") | Some("jsx") | Some("rs") | Some("py") | Some("go")
    )
}

fn line_count(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        s.lines().count()
    }
}

/// Read `HEAD:<path>` as UTF-8. Returns `Ok(None)` if the file doesn't exist
/// at HEAD (i.e. it's new in this commit). Returns `Err` only for IO failures.
fn read_head_blob(path: &str, working_dir: &Path) -> Result<Option<String>> {
    let output = Command::new("git")
        .args(["show", &format!("HEAD:{path}")])
        .current_dir(working_dir)
        .output()
        .context("git show HEAD:<path> failed to execute")?;
    if !output.status.success() {
        // File doesn't exist at HEAD — treat as new.
        return Ok(None);
    }
    Ok(String::from_utf8(output.stdout).ok())
}

/// Read the staged blob for `path` via `git show :<path>`. Returns `Ok(None)` if
/// the staged entry is empty (deletion).
fn read_staged_blob(path: &str, working_dir: &Path) -> Result<Option<String>> {
    let output = Command::new("git")
        .args(["show", &format!(":{path}")])
        .current_dir(working_dir)
        .output()
        .context("git show :<path> failed to execute")?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8(output.stdout).ok())
}

/// A file is a stub if, stripping comments / imports / re-exports / blank lines,
/// fewer than `max_body_lines` non-trivial lines remain.
fn is_stub(content: &str, max_body_lines: usize) -> bool {
    let body = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("//") && !l.starts_with("/*") && !l.starts_with("*") && !l.starts_with("#"))
        .filter(|l| !l.starts_with("import ") && !l.starts_with("use "))
        .filter(|l| !(l.starts_with("export ") && l.contains(" from ")))
        .count();
    body <= max_body_lines
}

/// Extract named exports from source. Regex-free simple scanner that handles:
///   - TS/JS: `export function foo`, `export const foo`, `export class Foo`,
///     `export interface Foo`, `export type Foo`, `export enum Foo`,
///     `export async function foo`, `export default function foo`.
///   - Rust: `pub fn foo`, `pub struct Foo`, `pub enum Foo`, `pub trait Foo`,
///     `pub const FOO`, `pub static FOO`, `pub type Foo`.
fn collect_exports(content: &str) -> Vec<String> {
    let mut names = Vec::new();
    for raw in content.lines() {
        let line = raw.trim_start();
        // Skip obvious noise.
        if line.is_empty() || line.starts_with("//") || line.starts_with("*") {
            continue;
        }
        // TS/JS export keyword.
        if let Some(rest) = line.strip_prefix("export ") {
            if let Some(name) = parse_export_name(rest) {
                names.push(name);
            }
            continue;
        }
        // Rust pub keyword.
        if let Some(rest) = line.strip_prefix("pub ") {
            if let Some(name) = parse_rust_export_name(rest) {
                names.push(name);
            }
        }
    }
    names
}

fn parse_export_name(rest: &str) -> Option<String> {
    // Drop async / default qualifiers.
    let rest = rest.trim_start_matches("async ").trim_start_matches("default ");
    // kind: function / const / let / var / class / interface / type / enum / function*
    for kw in ["function*", "function", "async function", "class", "interface", "type", "enum", "const", "let", "var"] {
        if let Some(after) = rest.strip_prefix(&format!("{kw} ")) {
            return Some(take_ident(after));
        }
    }
    None
}

fn parse_rust_export_name(rest: &str) -> Option<String> {
    // Drop async / unsafe / extern qualifiers.
    let rest = rest
        .trim_start_matches("async ")
        .trim_start_matches("unsafe ")
        .trim_start_matches("extern ");
    for kw in ["fn", "struct", "enum", "trait", "const", "static", "type", "mod"] {
        if let Some(after) = rest.strip_prefix(&format!("{kw} ")) {
            return Some(take_ident(after));
        }
    }
    None
}

fn take_ident(s: &str) -> String {
    s.chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thresholds() -> DamageThresholds {
        DamageThresholds::default()
    }

    #[test]
    fn line_count_handles_empty_and_trailing_newline() {
        assert_eq!(line_count(""), 0);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count("a\n"), 1);
        assert_eq!(line_count("a\nb\n"), 2);
    }

    #[test]
    fn is_stub_flags_export_only_file() {
        let content = r#"
import foo from 'bar'
import baz from 'qux'

export function doIt(): void {}
"#;
        assert!(is_stub(content, 1));
    }

    #[test]
    fn is_stub_rejects_real_implementation() {
        let content = r#"
import foo from 'bar'

export function doIt(x: number): number {
  const doubled = x * 2
  const offset = doubled + 1
  return offset
}
"#;
        assert!(!is_stub(content, 3));
    }

    #[test]
    fn collect_exports_ts_variants() {
        let content = r#"
export function foo() {}
export const bar = 1
export class Baz {}
export interface Qux { x: number }
export type Wibble = string
export enum Wobble { A, B }
export default function defaultFn() {}
export async function asyncFn() {}
"#;
        let names = collect_exports(content);
        assert!(names.contains(&"foo".to_string()));
        assert!(names.contains(&"bar".to_string()));
        assert!(names.contains(&"Baz".to_string()));
        assert!(names.contains(&"Qux".to_string()));
        assert!(names.contains(&"Wibble".to_string()));
        assert!(names.contains(&"Wobble".to_string()));
        assert!(names.contains(&"defaultFn".to_string()));
        assert!(names.contains(&"asyncFn".to_string()));
    }

    #[test]
    fn collect_exports_rust_variants() {
        let content = r#"
pub fn foo() {}
pub struct Bar;
pub enum Baz { A }
pub trait Qux {}
pub const X: i32 = 1;
pub type Y = i32;
"#;
        let names = collect_exports(content);
        assert!(names.contains(&"foo".to_string()));
        assert!(names.contains(&"Bar".to_string()));
        assert!(names.contains(&"Baz".to_string()));
        assert!(names.contains(&"Qux".to_string()));
        assert!(names.contains(&"X".to_string()));
        assert!(names.contains(&"Y".to_string()));
    }

    #[test]
    fn collect_exports_ignores_non_exports() {
        let content = r#"
function internal() {}
const local = 1
// export pseudo-code inside a comment
"#;
        let names = collect_exports(content);
        assert!(names.is_empty());
    }

    #[test]
    fn is_source_file_distinguishes_extensions() {
        assert!(is_source_file("foo/bar.ts"));
        assert!(is_source_file("foo/bar.tsx"));
        assert!(is_source_file("foo/bar.rs"));
        assert!(!is_source_file("foo/bar.yaml"));
        assert!(!is_source_file("foo/README.md"));
        assert!(!is_source_file("Cargo.toml"));
    }

    #[test]
    fn damage_report_summary_formatting() {
        let r = DamageReport {
            findings: vec![
                DamageFinding {
                    file: "a.ts".into(),
                    rule: DamageRule::LocShrink,
                    detail: "test detail".into(),
                },
                DamageFinding {
                    file: "b.ts".into(),
                    rule: DamageRule::Stubbed,
                    detail: "stub".into(),
                },
            ],
        };
        let s = r.summary();
        assert!(s.contains("2 finding(s)"));
        assert!(s.contains("loc_shrink"));
        assert!(s.contains("stubbed"));
        assert!(s.contains("a.ts"));
        assert!(s.contains("b.ts"));
    }

    /// Set up a scratch git repo, commit the given `head_files` as the HEAD
    /// baseline, then overwrite + stage `staged_files`. Returns the repo path.
    fn make_scratch_repo(
        head_files: &[(&str, &str)],
        staged_files: &[(&str, &str)],
    ) -> tempfile::TempDir {
        use std::fs;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path();
        let run = |args: &[&str]| {
            let out = Command::new("git").args(args).current_dir(path).output().unwrap();
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t.t"]);
        run(&["config", "user.name", "t"]);
        run(&["config", "commit.gpgsign", "false"]);
        for (rel, content) in head_files {
            let p = path.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, content).unwrap();
            run(&["add", rel]);
        }
        run(&["commit", "-q", "-m", "baseline"]);
        for (rel, content) in staged_files {
            let p = path.join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, content).unwrap();
            run(&["add", rel]);
        }
        dir
    }

    #[test]
    fn end_to_end_flags_gutted_file() {
        // Baseline: 200 real lines of logic.
        let mut head = String::from("import { useEffect } from 'react'\n");
        for i in 0..200 {
            head.push_str(&format!("export const doStuff{} = () => {{ return {}; }}\n", i, i));
        }
        // Minion stubs it: kept one export, deleted everything else.
        let staged = "import { useEffect } from 'react'\nexport const Terminal = () => null\n";

        let dir = make_scratch_repo(&[("src/Terminal.tsx", &head)], &[("src/Terminal.tsx", staged)]);
        let report = check_damage(
            &["src/Terminal.tsx".to_string()],
            dir.path(),
            &DamageThresholds::default(),
        )
        .expect("damage check");

        assert!(!report.is_clean(), "expected findings, got {:?}", report);
        let rules: std::collections::HashSet<_> =
            report.findings.iter().map(|f| f.rule).collect();
        assert!(rules.contains(&DamageRule::LocShrink));
        assert!(rules.contains(&DamageRule::ExportDelete));
    }

    #[test]
    fn end_to_end_passes_legitimate_small_change() {
        // Small fix: rename one variable, ~1-line change.
        let head = r#"import { log } from './log'

export function handleEvent(ev: Event): void {
  log('got event', ev)
  if (ev.type === 'click') {
    log('click detected')
    doSomething(ev)
  }
}

export function doSomething(ev: Event): void {
  log('doing thing', ev.target)
}
"#;
        let staged = r#"import { log } from './log'

export function handleEvent(ev: Event): void {
  log('got event (renamed)', ev)
  if (ev.type === 'click') {
    log('click detected')
    doSomething(ev)
  }
}

export function doSomething(ev: Event): void {
  log('doing thing', ev.target)
}
"#;
        let dir = make_scratch_repo(&[("src/app.ts", head)], &[("src/app.ts", staged)]);
        let report = check_damage(
            &["src/app.ts".to_string()],
            dir.path(),
            &DamageThresholds::default(),
        )
        .expect("damage check");

        assert!(
            report.is_clean(),
            "legit small change should pass, got {}",
            report.summary()
        );
    }

    #[test]
    fn end_to_end_allows_multi_file_refactor_split() {
        // Simulate the legit refactor: original file shrinks to 40% because
        // logic moved to a new sibling file. Both commit together.
        let mut big = String::from("import React from 'react'\n");
        for i in 0..100 {
            big.push_str(&format!("export const helper{} = () => {};\n", i, i));
        }
        // After refactor: main file keeps shell, subsections file holds bulk.
        let small = r#"import React from 'react'
import { AutoApprovalBanner, AmendmentDetails } from './AmendmentSubSections'
export const AmendmentStatusPanel = () => null
"#;
        let mut subsections = String::from("import React from 'react'\n");
        for i in 0..100 {
            subsections.push_str(&format!("export const helper{} = () => {};\n", i, i));
        }
        let dir = make_scratch_repo(
            &[("src/Panel.tsx", &big)],
            &[
                ("src/Panel.tsx", small),
                ("src/AmendmentSubSections.tsx", &subsections),
            ],
        );

        // Multi-file commit — LOC shrink rule suppressed, and exports *moved*
        // rather than deleted (not counted across files, but export_delete fires
        // per-file only so the shrink-only file would fire. Here we check the
        // single-file rule is off.)
        let report = check_damage(
            &[
                "src/Panel.tsx".to_string(),
                "src/AmendmentSubSections.tsx".to_string(),
            ],
            dir.path(),
            &DamageThresholds::default(),
        )
        .expect("damage check");

        // LOC-shrink must NOT fire in multi-file commits.
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.rule == DamageRule::LocShrink),
            "multi-file refactor should not trigger loc_shrink, got {}",
            report.summary()
        );
    }

    #[test]
    fn end_to_end_allows_new_file() {
        // Brand-new file (no HEAD version) should never fire any rule.
        let new = "export const x = 1\n";
        let dir = make_scratch_repo(
            &[("README.md", "baseline\n")],
            &[("src/new.ts", new)],
        );
        let report = check_damage(
            &["src/new.ts".to_string()],
            dir.path(),
            &DamageThresholds::default(),
        )
        .expect("damage check");
        assert!(report.is_clean());
    }

    #[test]
    fn damage_rules_are_orthogonal_on_representative_minion_damage() {
        // Taken from the real Terminal.tsx damage: went from ~1133 LOC to 48 LOC,
        // kept one named export, deleted dozens.
        let mut old_content = String::from("import { useEffect } from 'react'\n");
        for i in 0..1130 {
            old_content.push_str(&format!("export const x{} = {};\n", i, i));
        }
        let new_content = "import { useEffect } from 'react'\nexport const Terminal = () => null\n";

        let old_loc = line_count(&old_content);
        let new_loc = line_count(new_content);
        let t = thresholds();

        // LOC shrink should fire.
        let shrink_ratio = new_loc as f64 / old_loc as f64;
        assert!(shrink_ratio < t.min_retained_ratio);

        // Export-delete should fire (1130 exports gone).
        let old_exports = collect_exports(&old_content);
        let new_exports = collect_exports(new_content);
        let removed = old_exports.iter().filter(|e| !new_exports.contains(e)).count();
        assert!(removed > t.max_exports_removed);
    }
}
