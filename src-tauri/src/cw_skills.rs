//! Discover PocketCode SKILL.md packs (workspace + user skills dir).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::WalkDir;

use crate::deployment;
use crate::error::{AppError, AppResult};
use pocketcode_workspace::WorkspaceSidecar;

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub body: String,
}

fn user_skills_dir() -> PathBuf {
    let dir = deployment::preferred_data_root().join("skills");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn parse_frontmatter(raw: &str) -> (String, String, String) {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        let name = first_heading(raw).unwrap_or_else(|| "Skill".into());
        return (name.clone(), String::new(), raw.trim().to_string());
    }
    let rest = &trimmed[3..];
    let end = rest.find("\n---").or_else(|| rest.find("\r\n---"));
    let Some(end) = end else {
        let name = first_heading(raw).unwrap_or_else(|| "Skill".into());
        return (name, String::new(), raw.trim().to_string());
    };
    let fm = &rest[..end];
    let body_start = end + if rest[end..].starts_with("\r\n---") { 5 } else { 4 };
    let body = rest[body_start..].trim().to_string();
    let mut name = String::new();
    let mut description = String::new();
    for line in fm.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("name:") {
            name = v.trim().trim_matches('"').trim_matches('\'').to_string();
        } else if let Some(v) = line.strip_prefix("description:") {
            description = v.trim().trim_matches('"').trim_matches('\'').to_string();
        }
    }
    if name.is_empty() {
        name = first_heading(&body).unwrap_or_else(|| "Skill".into());
    }
    (name, description, body)
}

fn first_heading(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            let n = rest.trim();
            if !n.is_empty() {
                return Some(n.to_string());
            }
        }
    }
    None
}

fn skill_id_from_path(path: &Path, source: &str) -> String {
    let stem = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .filter(|s| !s.eq_ignore_ascii_case("skills"))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("skill")
        });
    format!("{source}:{stem}")
}

fn load_skill_file(path: &Path, source: &str) -> Option<SkillInfo> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let (name, description, body) = parse_frontmatter(&raw);
    Some(SkillInfo {
        id: skill_id_from_path(path, source),
        name,
        description,
        path: path.to_string_lossy().to_string(),
        source: source.to_string(),
        body,
    })
}

fn collect_skills_in_dir(root: &Path, source: &str, out: &mut Vec<SkillInfo>) {
    if !root.is_dir() {
        return;
    }
    for entry in WalkDir::new(root).max_depth(4).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case("SKILL.md") && !name.eq_ignore_ascii_case("skill.md") {
            continue;
        }
        if let Some(skill) = load_skill_file(path, source) {
            if !out.iter().any(|s| s.id == skill.id) {
                out.push(skill);
            }
        }
    }
}

pub fn list_skills(workspace_root: Option<String>) -> AppResult<Vec<SkillInfo>> {
    let mut out = Vec::new();
    if let Some(ws) = workspace_root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let root = match WorkspaceSidecar::for_workspace(Path::new(ws)) {
            Ok(sidecar) => sidecar.skills_dir(),
            Err(_) => PathBuf::new(),
        };
        if root.is_dir() {
            collect_skills_in_dir(&root, "workspace", &mut out);
        }
    }
    collect_skills_in_dir(&user_skills_dir(), "user", &mut out);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub fn read_skill(path: String) -> AppResult<SkillInfo> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(AppError::Unknown(format!("Skill file not found: {}", p.display())));
    }
    let user_dir = user_skills_dir();
    let source = if p.starts_with(&user_dir) { "user" } else { "workspace" };
    load_skill_file(&p, source).ok_or_else(|| AppError::Unknown("Failed to read skill.".into()))
}

pub fn skills_dir_paths(workspace_root: Option<String>) -> AppResult<serde_json::Value> {
    let user = user_skills_dir();
    let workspace = workspace_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|ws| {
            WorkspaceSidecar::for_workspace(Path::new(ws))
                .ok()
                .map(|sidecar| {
                    let p = sidecar.skills_dir();
                    let _ = fs::create_dir_all(&p);
                    p.to_string_lossy().to_string()
                })
        });
    Ok(serde_json::json!({
        "user": user.to_string_lossy(),
        "workspace": workspace,
    }))
}
