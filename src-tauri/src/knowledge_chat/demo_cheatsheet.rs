//! Demo folder cheatsheet: maps files/symbols to topics for guided RAG + LLM prompting.

use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const DEMO_CHEATSHEET_FILENAME: &str = "demo_cheatsheet.json";

#[derive(Debug, Clone, Deserialize)]
pub struct DemoCheatsheet {
    pub collection_name: String,
    #[serde(default)]
    pub version: u32,
    pub entries: Vec<DemoCheatsheetEntry>,
    #[serde(default)]
    pub question_routes: Vec<DemoQuestionRoute>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DemoCheatsheetEntry {
    pub id: String,
    pub file: String,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub line_start: i32,
    #[serde(default)]
    pub line_end: i32,
    pub summary: String,
    #[serde(default)]
    pub evidence_hint: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DemoQuestionRoute {
    pub patterns: Vec<String>,
    pub entry_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DemoCheatsheetMatch {
    pub entries: Vec<DemoCheatsheetEntry>,
    pub pinned_paths: Vec<String>,
    pub prompt_block: String,
}

pub fn load_cheatsheet_for_collection(collection_name: &str, root_path: &str) -> Option<DemoCheatsheet> {
    // Universal: only load a cheatsheet from the collection root — never fall back
    // to the bundled QA corpus path for unrelated customer folders.
    let path = Path::new(root_path).join(DEMO_CHEATSHEET_FILENAME);
    let sheet = read_cheatsheet_file(&path)?;
    if sheet.collection_name.eq_ignore_ascii_case(collection_name)
        || collection_name.is_empty()
        || sheet.collection_name.is_empty()
    {
        return Some(sheet);
    }
    None
}

fn read_cheatsheet_file(path: &Path) -> Option<DemoCheatsheet> {
    if !path.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn match_cheatsheet(query: &str, cheatsheet: &DemoCheatsheet) -> DemoCheatsheetMatch {
    let normalized = normalize_text(query);
    if normalized.len() < 3 {
        return empty_match();
    }

    let mut matched_ids: Vec<String> = Vec::new();
    let mut scores: Vec<(i32, String)> = Vec::new();

    for route in &cheatsheet.question_routes {
        let route_hit = route
            .patterns
            .iter()
            .any(|pattern| normalized.contains(&normalize_text(pattern)));
        if route_hit {
            for id in &route.entry_ids {
                if !matched_ids.iter().any(|existing| existing == id) {
                    matched_ids.push(id.clone());
                    scores.push((100, id.clone()));
                }
            }
        }
    }

    for entry in &cheatsheet.entries {
        let mut score = 0i32;
        if normalized.contains(&normalize_text(&entry.file)) {
            score += 40;
        }
        let file_name = Path::new(&entry.file)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if !file_name.is_empty() && normalized.contains(&normalize_text(file_name)) {
            score += 35;
        }
        for symbol in &entry.symbols {
            let sym = normalize_text(symbol);
            if sym.len() >= 4 && normalized.contains(&sym) {
                score += 50;
            }
        }
        for topic in &entry.topics {
            let topic_norm = normalize_text(topic);
            if topic_norm.len() >= 4 && normalized.contains(&topic_norm) {
                score += 25;
            }
        }
        if score > 0 && !matched_ids.iter().any(|id| id == &entry.id) {
            matched_ids.push(entry.id.clone());
            scores.push((score, entry.id.clone()));
        } else if score > 0 {
            if let Some(slot) = scores.iter_mut().find(|(_, id)| id == &entry.id) {
                slot.0 = slot.0.max(score);
            }
        }
    }

    scores.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let ordered_ids: Vec<String> = scores.into_iter().map(|(_, id)| id).collect();

    let entries: Vec<DemoCheatsheetEntry> = ordered_ids
        .iter()
        .filter_map(|id| cheatsheet.entries.iter().find(|e| &e.id == id).cloned())
        .collect();

    if entries.is_empty() {
        return empty_match();
    }

    let pinned_paths = pinned_relative_paths(&entries);
    let prompt_block = format_cheatsheet_for_prompt(&entries);
    DemoCheatsheetMatch {
        entries,
        pinned_paths,
        prompt_block,
    }
}

pub fn pinned_relative_paths(entries: &[DemoCheatsheetEntry]) -> Vec<String> {
    let mut out = Vec::new();
    for entry in entries {
        let path = entry.file.replace('\\', "/");
        if !path.is_empty() && !out.iter().any(|p| p == &path) {
            out.push(path);
        }
    }
    out
}

pub fn format_cheatsheet_for_prompt(entries: &[DemoCheatsheetEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        "Use this DEMO FOLDER CHEATSHEET to pick the correct attached file and line citations.".to_string(),
        "Do not invent facts outside the cheatsheet and attached source blocks.".to_string(),
        String::new(),
    ];
    for entry in entries {
        let anchor = if entry.line_start > 0 && entry.line_end >= entry.line_start {
            format!("L{}-L{}", entry.line_start, entry.line_end)
        } else if entry.line_start > 0 {
            format!("L{}", entry.line_start)
        } else {
            String::new()
        };
        let symbols = if entry.symbols.is_empty() {
            String::new()
        } else {
            format!(" | symbols: {}", entry.symbols.join(", "))
        };
        lines.push(format!(
            "- **{}** ({}{}) — {}",
            entry.file, anchor, symbols, entry.summary
        ));
        if !entry.evidence_hint.is_empty() {
            lines.push(format!("  cite: `{}`", entry.evidence_hint.trim()));
        }
    }
    lines.join("\n")
}

pub fn cheatsheet_enabled_for_collection(
    enabled: bool,
    collection_name: &str,
    root_path: &str,
) -> bool {
    if !enabled {
        return false;
    }
    load_cheatsheet_for_collection(collection_name, root_path).is_some()
}

fn empty_match() -> DemoCheatsheetMatch {
    DemoCheatsheetMatch {
        entries: Vec::new(),
        pinned_paths: Vec::new(),
        prompt_block: String::new(),
    }
}

fn normalize_text(value: &str) -> String {
    value
        .to_lowercase()
        .replace(['`', '"', '\''], "")
        .replace('_', "")
        .replace('-', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn resolve_pinned_absolute_path(root_path: &str, relative_path: &str) -> Option<PathBuf> {
    let root = Path::new(root_path);
    let rel = relative_path.trim_start_matches(['/', '\\']);
    let path = root.join(rel);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qa_cheatsheet() -> DemoCheatsheet {
        load_cheatsheet_for_collection("NexusAI QA Corpus", "")
            .expect("bundled QA cheatsheet")
    }

    #[test]
    fn loads_bundled_qa_cheatsheet() {
        let sheet = qa_cheatsheet();
        assert!(sheet.entries.len() >= 10);
    }

    #[test]
    fn matches_handlesend_question() {
        let sheet = qa_cheatsheet();
        let m = match_cheatsheet("What does handleSend do in ChatView.tsx?", &sheet);
        assert!(!m.entries.is_empty());
        assert!(m.pinned_paths.iter().any(|p| p.contains("ChatView.tsx")));
    }

    #[test]
    fn matches_paraphrase_api_timeout() {
        let sheet = qa_cheatsheet();
        let m = match_cheatsheet("Which env var sets the API timeout?", &sheet);
        assert!(m.pinned_paths.iter().any(|p| p.contains("config_loader.py")));
    }

    #[test]
    fn matches_vpn_first_step() {
        let sheet = qa_cheatsheet();
        let m = match_cheatsheet("First step for VPN brute force alert?", &sheet);
        assert!(m.pinned_paths.iter().any(|p| p.contains("vpn-incident-response")));
    }

    #[test]
    fn format_includes_summary() {
        let sheet = qa_cheatsheet();
        let m = match_cheatsheet("What does error code E-402 mean?", &sheet);
        assert!(m.prompt_block.contains("E-402"));
        assert!(m.prompt_block.contains("DEMO FOLDER CHEATSHEET"));
    }

    #[test]
    fn demo_cheatsheet_covers_eval_questions() {
        use crate::knowledge_chat::qa_eval_expanded::qa_corpus_paraphrase_cases;
        use crate::knowledge_chat::qa_standard_cases::qa_corpus_standard_cases;

        let sheet = qa_cheatsheet();
        let mut questions: Vec<String> = qa_corpus_standard_cases()
            .into_iter()
            .map(|c| c.question)
            .collect();
        questions.extend(
            qa_corpus_paraphrase_cases()
                .into_iter()
                .map(|c| c.question),
        );
        for question in questions {
            let matched = match_cheatsheet(&question, &sheet);
            assert!(
                !matched.pinned_paths.is_empty(),
                "cheatsheet should match: {question}"
            );
        }
    }
}
