//! Path jail: resolve relative paths under a workspace root, rejecting escapes.

use crate::error::{Error, Result};
use std::path::{Component, Path, PathBuf};

fn contains_parent_traversal(path: &str) -> bool {
    path.replace('\\', "/")
        .split('/')
        .any(|segment| segment == "..")
}

/// Normalize separators and trim; does not resolve `.` / `..` (those are rejected).
pub fn standardize(path: &str) -> String {
    let trimmed = path.trim().trim_matches('"');
    #[cfg(target_os = "windows")]
    {
        trimmed.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.replace('\\', "/")
    }
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    let _ = s;
    path
}

pub fn path_is_under(root: &Path, candidate: &Path) -> bool {
    let root = strip_verbatim_prefix(root.to_path_buf());
    let candidate = strip_verbatim_prefix(candidate.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        let root_l = root.to_string_lossy().to_ascii_lowercase();
        let cand_l = candidate.to_string_lossy().to_ascii_lowercase();
        cand_l == root_l
            || cand_l.starts_with(&(root_l.clone() + "\\"))
            || cand_l.starts_with(&(root_l + "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate == root || candidate.starts_with(&root)
    }
}

pub fn canonicalize_root(root: &Path) -> Result<PathBuf> {
    if !root.exists() {
        return Err(Error::msg(format!(
            "Workspace root does not exist: {}",
            root.display()
        )));
    }
    root.canonicalize()
        .map(strip_verbatim_prefix)
        .map_err(|e| Error::msg(format!("Cannot canonicalize workspace root: {e}")))
}

/// Resolve `rel` under `workspace_root`, rejecting `..` escape. Canonicalizes when the path exists.
pub fn resolve_under_root(workspace_root: &Path, rel: &str) -> Result<PathBuf> {
    let root_canon = canonicalize_root(workspace_root)?;
    let rel = rel.trim();
    if rel.is_empty() || rel == "." {
        return Ok(root_canon);
    }
    if contains_parent_traversal(rel) {
        return Err(Error::msg(
            "Path escapes workspace root (contains ..).".to_string(),
        ));
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        let abs = if rel_path.exists() {
            strip_verbatim_prefix(rel_path.canonicalize().map_err(|e| {
                Error::msg(format!("Cannot canonicalize path: {e}"))
            })?)
        } else {
            PathBuf::from(standardize(rel))
        };
        if !path_is_under(&root_canon, &abs) {
            return Err(Error::msg(
                "Path is outside the workspace root.".to_string(),
            ));
        }
        return Ok(abs);
    }

    let joined = root_canon.join(standardize(rel));
    let mut clean = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                return Err(Error::msg(
                    "Path escapes workspace root (contains ..).".to_string(),
                ));
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }

    if clean.exists() {
        let canon = strip_verbatim_prefix(clean.canonicalize().map_err(|e| {
            Error::msg(format!("Cannot canonicalize path: {e}"))
        })?);
        if !path_is_under(&root_canon, &canon) {
            return Err(Error::msg(
                "Path is outside the workspace root.".to_string(),
            ));
        }
        return Ok(canon);
    }

    if let Some(parent) = clean.parent() {
        if parent.as_os_str().is_empty() {
            // fall through
        } else if parent.exists() {
            let parent_canon = strip_verbatim_prefix(parent.canonicalize().map_err(|e| {
                Error::msg(format!("Cannot canonicalize parent path: {e}"))
            })?);
            if !path_is_under(&root_canon, &parent_canon) {
                return Err(Error::msg(
                    "Path is outside the workspace root.".to_string(),
                ));
            }
            let name = clean
                .file_name()
                .ok_or_else(|| Error::msg("Invalid file path.".to_string()))?;
            return Ok(parent_canon.join(name));
        } else if !path_is_under(&root_canon, parent) {
            return Err(Error::msg(
                "Path is outside the workspace root.".to_string(),
            ));
        }
    }

    if !path_is_under(&root_canon, &clean) {
        return Err(Error::msg(
            "Path is outside the workspace root.".to_string(),
        ));
    }
    Ok(clean)
}

pub fn to_rel_display(root: &Path, absolute: &Path) -> String {
    let root = strip_verbatim_prefix(root.to_path_buf());
    let absolute = strip_verbatim_prefix(absolute.to_path_buf());
    absolute
        .strip_prefix(&root)
        .map(|p| {
            let s = p.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                ".".to_string()
            } else {
                s
            }
        })
        .unwrap_or_else(|_| absolute.to_string_lossy().replace('\\', "/"))
}

pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    strip_verbatim_prefix(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pm_jail_test_{name}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ok.txt"), b"hi").unwrap();
        dir
    }

    #[test]
    fn rejects_parent_escape_etc_passwd() {
        let dir = make_temp_workspace("etc");
        let err = resolve_under_root(&dir, "../etc/passwd").unwrap_err();
        assert!(
            err.to_string().contains("escapes") || err.to_string().contains(".."),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_nested_parent_escape() {
        let dir = make_temp_workspace("nested");
        let err = resolve_under_root(&dir, "foo/../../etc").unwrap_err();
        assert!(
            err.to_string().contains("escapes") || err.to_string().contains(".."),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_outside_root() {
        let dir = make_temp_workspace("abs");
        #[cfg(target_os = "windows")]
        let outside = r"C:\Windows\System32\drivers\etc\hosts";
        #[cfg(not(target_os = "windows"))]
        let outside = "/etc/passwd";
        let err = resolve_under_root(&dir, outside).unwrap_err();
        assert!(
            err.to_string().contains("outside") || err.to_string().contains("escapes"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn accepts_normal_relative_paths() {
        let dir = make_temp_workspace("ok");
        let p = resolve_under_root(&dir, "ok.txt").unwrap();
        assert!(p.is_file());
        assert!(path_is_under(&dir.canonicalize().unwrap(), &p));
        let root = resolve_under_root(&dir, ".").unwrap();
        assert!(root.is_dir());
        let nested = resolve_under_root(&dir, "sub/new.txt").unwrap();
        assert!(path_is_under(
            &canonicalize_root(&dir).unwrap(),
            nested.parent().unwrap()
        ) || nested
            .to_string_lossy()
            .contains("sub"));
        let _ = fs::remove_dir_all(&dir);
    }
}
