//! Real git status and diffs for the PocketCode editor.
//!
//! Never invents a working tree. Missing git, a non-repo folder, permission
//! errors, binary files, and oversized diffs are reported as structured results.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_DIFF_BYTES: usize = 1_500_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusReport {
    pub is_repo: bool,
    pub git_available: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub files: Vec<GitFileStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiffResult {
    pub path: String,
    pub original: String,
    pub modified: String,
    pub unified: String,
    pub binary: bool,
    pub untracked: bool,
    pub too_large: bool,
    pub is_repo: bool,
    pub git_available: bool,
    pub error: Option<String>,
}

fn git_command(root: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Unknown(
                    "git is not installed or not on PATH. Install Git for Windows to see repository diffs."
                        .to_string(),
                )
            } else if e.kind() == std::io::ErrorKind::PermissionDenied {
                AppError::Unknown(format!("Permission denied running git: {e}"))
            } else {
                AppError::Unknown(format!("Failed to run git: {e}"))
            }
        })
}

fn stdout_str(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn stderr_str(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

pub fn parse_porcelain_line(line: &str) -> Option<GitFileStatus> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.len() < 4 {
        return None;
    }
    // XY PATH  or  XY orig -> PATH for renames
    let index = line.chars().next()?.to_string();
    let worktree = line.chars().nth(1)?.to_string();
    let rest = line.get(3..)?.trim();
    let path = if let Some((_, dest)) = rest.split_once(" -> ") {
        dest.trim().to_string()
    } else {
        rest.trim_matches('"').to_string()
    };
    if path.is_empty() {
        return None;
    }
    let untracked = index == "?" && worktree == "?";
    let conflicted = matches!(
        (index.as_str(), worktree.as_str()),
        ("U", _) | (_, "U") | ("A", "A") | ("D", "D")
    );
    Some(GitFileStatus {
        path,
        index,
        worktree,
        untracked,
        conflicted,
    })
}

pub fn status(workspace_root: &Path) -> AppResult<GitStatusReport> {
    if !workspace_root.exists() {
        return Ok(GitStatusReport {
            is_repo: false,
            git_available: true,
            root: None,
            branch: None,
            files: vec![],
            error: Some("Workspace folder does not exist.".to_string()),
        });
    }
    let probe = match git_command(workspace_root, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(out) => out,
        Err(err) => {
            let msg = err.to_string();
            let missing = msg.contains("not installed") || msg.contains("not on PATH");
            return Ok(GitStatusReport {
                is_repo: false,
                git_available: !missing,
                root: None,
                branch: None,
                files: vec![],
                error: Some(msg),
            });
        }
    };
    if !probe.status.success() {
        return Ok(GitStatusReport {
            is_repo: false,
            git_available: true,
            root: None,
            branch: None,
            files: vec![],
            error: Some(
                "Not a git repository. Open a folder that contains a .git directory to see diffs."
                    .to_string(),
            ),
        });
    }
    let branch_out = git_command(workspace_root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok();
    let branch = branch_out
        .filter(|o| o.status.success())
        .map(|o| stdout_str(&o).trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD");
    let porcelain = git_command(
        workspace_root,
        &["status", "--porcelain=v1", "-uall", "--no-renames"],
    )?;
    if !porcelain.status.success() {
        return Ok(GitStatusReport {
            is_repo: true,
            git_available: true,
            root: Some(workspace_root.display().to_string()),
            branch,
            files: vec![],
            error: Some(stderr_str(&porcelain).if_empty("git status failed.")),
        });
    }
    let mut files = Vec::new();
    for line in stdout_str(&porcelain).lines() {
        if let Some(row) = parse_porcelain_line(line) {
            files.push(row);
        }
    }
    Ok(GitStatusReport {
        is_repo: true,
        git_available: true,
        root: Some(workspace_root.display().to_string()),
        branch,
        files,
        error: None,
    })
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}
impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn read_file_lossy(path: &Path, cap: usize) -> (String, bool, bool) {
    match std::fs::read(path) {
        Ok(buf) => {
            let too_large = buf.len() > cap;
            let slice = if too_large { &buf[..cap] } else { &buf };
            if looks_binary(slice) {
                return (String::new(), true, too_large);
            }
            (String::from_utf8_lossy(slice).to_string(), false, too_large)
        }
        Err(e) => (format!("/* could not read file: {e} */\n"), false, false),
    }
}

fn join_workspace(root: &Path, rel: &str) -> PathBuf {
    let trimmed = rel.trim().trim_start_matches(['/', '\\']);
    let mut p = root.to_path_buf();
    for part in trimmed.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".") {
        if part == ".." {
            continue;
        }
        p.push(part);
    }
    p
}

pub fn diff_file(workspace_root: &Path, path: &str) -> AppResult<GitDiffResult> {
    let empty = |err: Option<String>, git_available: bool, is_repo: bool| GitDiffResult {
        path: path.to_string(),
        original: String::new(),
        modified: String::new(),
        unified: String::new(),
        binary: false,
        untracked: false,
        too_large: false,
        is_repo,
        git_available,
        error: err,
    };
    if path.trim().is_empty() {
        return Ok(empty(Some("No file selected.".into()), true, true));
    }
    let abs = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        join_workspace(workspace_root, path)
    };
    let rel = path.replace('\\', "/");

    let st = status(workspace_root)?;
    if !st.git_available {
        let (modified, binary, too_large) = read_file_lossy(&abs, MAX_DIFF_BYTES);
        return Ok(GitDiffResult {
            path: rel,
            original: String::new(),
            modified,
            unified: String::new(),
            binary,
            untracked: true,
            too_large,
            is_repo: false,
            git_available: false,
            error: st.error,
        });
    }
    if !st.is_repo {
        let (modified, binary, too_large) = read_file_lossy(&abs, MAX_DIFF_BYTES);
        return Ok(GitDiffResult {
            path: rel,
            original: String::new(),
            modified,
            unified: String::new(),
            binary,
            untracked: true,
            too_large,
            is_repo: false,
            git_available: true,
            error: st.error,
        });
    }

    let file_row = st.files.iter().find(|f| {
        f.path.replace('\\', "/") == rel || rel.ends_with(&f.path.replace('\\', "/"))
    });
    let untracked = file_row.map(|f| f.untracked).unwrap_or(false);

    if untracked || !abs.exists() {
        let (modified, binary, too_large) = read_file_lossy(&abs, MAX_DIFF_BYTES);
        let unified = if binary {
            format!("Binary file {rel} (untracked)")
        } else {
            modified
                .lines()
                .map(|l| format!("+{l}"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        return Ok(GitDiffResult {
            path: rel,
            original: String::new(),
            modified,
            unified,
            binary,
            untracked: true,
            too_large,
            is_repo: true,
            git_available: true,
            error: None,
        });
    }

    let show = git_command(workspace_root, &["show", &format!("HEAD:{rel}")]);
    let original = match show {
        Ok(out) if out.status.success() => {
            if looks_binary(&out.stdout) {
                return Ok(GitDiffResult {
                    path: rel,
                    original: String::new(),
                    modified: String::new(),
                    unified: "Binary file (git HEAD vs working tree)".into(),
                    binary: true,
                    untracked: false,
                    too_large: out.stdout.len() > MAX_DIFF_BYTES,
                    is_repo: true,
                    git_available: true,
                    error: None,
                });
            }
            let s = stdout_str(&out);
            if s.len() > MAX_DIFF_BYTES {
                s.chars().take(MAX_DIFF_BYTES).collect()
            } else {
                s
            }
        }
        Ok(_) | Err(_) => String::new(), // new file in index or no HEAD
    };

    let (modified, binary, too_large) = read_file_lossy(&abs, MAX_DIFF_BYTES);
    if binary {
        return Ok(GitDiffResult {
            path: rel,
            original: String::new(),
            modified: String::new(),
            unified: "Binary file — diff not shown.".into(),
            binary: true,
            untracked: false,
            too_large,
            is_repo: true,
            git_available: true,
            error: None,
        });
    }

    let diff_out = git_command(
        workspace_root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--unified=3",
            "HEAD",
            "--",
            &rel,
        ],
    )?;
    let mut unified = stdout_str(&diff_out);
    if unified.trim().is_empty() {
        // staged-only change
        let staged = git_command(
            workspace_root,
            &[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "--cached",
                "HEAD",
                "--",
                &rel,
            ],
        )?;
        unified = stdout_str(&staged);
    }
    let too_large_diff = unified.len() > MAX_DIFF_BYTES;
    if too_large_diff {
        unified = unified.chars().take(MAX_DIFF_BYTES).collect();
        unified.push_str("\n…[diff truncated — file is large]");
    }

    Ok(GitDiffResult {
        path: rel,
        original,
        modified,
        unified,
        binary: false,
        untracked: false,
        too_large: too_large || too_large_diff,
        is_repo: true,
        git_available: true,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_line;

    #[test]
    fn porcelain_modified() {
        let row = parse_porcelain_line(" M src/auth.ts").unwrap();
        assert_eq!(row.path, "src/auth.ts");
        assert_eq!(row.worktree, "M");
        assert!(!row.untracked);
    }

    #[test]
    fn porcelain_untracked() {
        let row = parse_porcelain_line("?? apps/web/src/lib/auth.ts").unwrap();
        assert!(row.untracked);
        assert_eq!(row.path, "apps/web/src/lib/auth.ts");
    }

    #[test]
    fn porcelain_conflict() {
        let row = parse_porcelain_line("UU package.json").unwrap();
        assert!(row.conflicted);
    }
}
