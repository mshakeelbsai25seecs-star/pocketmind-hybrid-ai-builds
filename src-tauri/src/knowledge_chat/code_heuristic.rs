use crate::knowledge_chat::code_entities::{CodeEntityKind, CodeParseMode, ParsedCodeEntity};
use crate::knowledge_chat::code_languages::language_id_for_extension;
use crate::knowledge_chat::chunking::line_number_at;

/// Brace-aware entity extraction when Tree-sitter is unavailable or fails.
pub fn extract_entities_heuristic(
    source: &str,
    extension: &str,
    file_name: Option<&str>,
) -> Vec<ParsedCodeEntity> {
    let language = language_id_for_extension(extension)
        .unwrap_or("unknown")
        .to_string();
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let mut entities = Vec::new();
    let mut index = 0i64;
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        if !is_boundary_line(line, extension) {
            i += 1;
            continue;
        }
        let start_line = i;
        let signature = line.trim().to_string();
        let (name, kind) = infer_name_and_kind(&signature, extension);
        if name.is_empty() {
            i += 1;
            continue;
        }
        // Skip nested non-callable assignments (e.g. `const content = input.trim()` inside a fn).
        if kind == CodeEntityKind::Const {
            let indent = line.chars().take_while(|c| c.is_whitespace()).count();
            if indent > 0 && !trimmed_is_export(line) {
                i += 1;
                continue;
            }
        }

        let end_line = if line.contains('{') {
            find_block_end(&lines, i)
        } else if extension.eq_ignore_ascii_case("py") {
            find_python_block_end(&lines, i)
        } else {
            i
        };

        let start_byte = lines[..start_line].iter().map(|l| l.len() + 1).sum::<usize>();
        let body_lines = &lines[start_line..=end_line.min(lines.len().saturating_sub(1))];
        let body = body_lines.join("\n");
        let end_byte = start_byte + body.len();
        let line_start = (start_line + 1) as i32;
        let line_end = (end_line + 1) as i32;
        let doc_comment = extract_leading_comment(&lines, start_line);

        entities.push(ParsedCodeEntity {
            entity_index: index,
            language: language.clone(),
            kind,
            name: name.clone(),
            qualified_name: name,
            signature,
            body,
            line_start,
            line_end,
            start_byte,
            end_byte,
            parse_mode: CodeParseMode::HeuristicFallback,
            doc_comment,
        });
        index += 1;
        i = end_line + 1;
    }

    if entities.is_empty() && source.trim().len() >= 40 {
        let _ = file_name;
        entities.push(ParsedCodeEntity {
            entity_index: 0,
            language,
            kind: CodeEntityKind::Module,
            name: file_name.unwrap_or("module").to_string(),
            qualified_name: file_name.unwrap_or("module").to_string(),
            signature: String::new(),
            body: source.chars().take(4000).collect(),
            line_start: 1,
            line_end: line_number_at(source, source.len()) as i32,
            start_byte: 0,
            end_byte: source.len(),
            parse_mode: CodeParseMode::HeuristicFallback,
            doc_comment: None,
        });
    }

    entities
}

fn is_boundary_line(line: &str, extension: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") {
        return false;
    }
    match extension.to_ascii_lowercase().as_str() {
        "rs" => trimmed.starts_with("pub fn ")
            || trimmed.starts_with("fn ")
            || trimmed.starts_with("pub async fn ")
            || trimmed.starts_with("async fn ")
            || trimmed.starts_with("pub struct ")
            || trimmed.starts_with("struct ")
            || trimmed.starts_with("pub enum ")
            || trimmed.starts_with("enum ")
            || trimmed.starts_with("pub trait ")
            || trimmed.starts_with("trait ")
            || trimmed.starts_with("impl "),
        "py" | "pyw" => trimmed.starts_with("def ") || trimmed.starts_with("async def ") || trimmed.starts_with("class "),
        "java" => trimmed.starts_with("class ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("enum ")
            || (trimmed.contains('(') && (trimmed.starts_with("public ") || trimmed.starts_with("private ") || trimmed.starts_with("protected "))),
        "kt" | "kts" => trimmed.starts_with("fun ") || trimmed.starts_with("class ") || trimmed.starts_with("interface "),
        "go" => trimmed.starts_with("func ") || trimmed.starts_with("type "),
        "cs" => trimmed.starts_with("class ")
            || trimmed.starts_with("interface ")
            || trimmed.starts_with("public ")
            || trimmed.starts_with("private "),
        _ => trimmed.starts_with("export function ")
            || trimmed.starts_with("export async function ")
            || trimmed.starts_with("function ")
            || trimmed.starts_with("async function ")
            || trimmed.starts_with("export class ")
            || trimmed.starts_with("class ")
            || trimmed.starts_with("export const ")
            || trimmed.starts_with("const ")
            || trimmed.starts_with("export interface ")
            || trimmed.starts_with("interface "),
    }
}

fn infer_name_and_kind(signature: &str, extension: &str) -> (String, CodeEntityKind) {
    let trimmed = signature.trim();
    let ext = extension.to_ascii_lowercase();
    if ext == "rs" {
        if trimmed.contains(" struct ") || trimmed.starts_with("struct ") || trimmed.contains("pub struct ") {
            return (extract_after_keyword(trimmed, "struct"), CodeEntityKind::Struct);
        }
        if trimmed.contains(" enum ") || trimmed.starts_with("enum ") {
            return (extract_after_keyword(trimmed, "enum"), CodeEntityKind::Enum);
        }
        if trimmed.contains(" trait ") || trimmed.starts_with("trait ") {
            return (extract_after_keyword(trimmed, "trait"), CodeEntityKind::Trait);
        }
        if trimmed.contains("fn ") {
            return (extract_after_keyword(trimmed, "fn"), CodeEntityKind::Function);
        }
    }
    if ext == "py" || ext == "pyw" {
        if trimmed.starts_with("class ") {
            return (extract_after_keyword(trimmed, "class"), CodeEntityKind::Class);
        }
        if trimmed.starts_with("def ") || trimmed.starts_with("async def ") {
            let kw = if trimmed.starts_with("async def ") { "async def" } else { "def" };
            return (extract_after_keyword(trimmed, kw), CodeEntityKind::Function);
        }
    }
    if trimmed.starts_with("class ") || trimmed.contains(" class ") {
        return (extract_after_keyword(trimmed, "class"), CodeEntityKind::Class);
    }
    if trimmed.starts_with("interface ") || trimmed.contains(" interface ") {
        return (extract_after_keyword(trimmed, "interface"), CodeEntityKind::Interface);
    }
    if trimmed.starts_with("function ") || trimmed.contains(" function ") {
        return (extract_after_keyword(trimmed, "function"), CodeEntityKind::Function);
    }
    if trimmed.starts_with("const ") || trimmed.contains(" const ") {
        let name = extract_after_keyword(trimmed, "const");
        if const_initializer_is_callable(trimmed) {
            return (name, CodeEntityKind::Function);
        }
        return (name, CodeEntityKind::Const);
    }
    if trimmed.starts_with("func ") {
        return (extract_after_keyword(trimmed, "func"), CodeEntityKind::Function);
    }
    if trimmed.starts_with("fun ") {
        return (extract_after_keyword(trimmed, "fun"), CodeEntityKind::Function);
    }
    (extract_first_identifier(trimmed), CodeEntityKind::Function)
}

fn trimmed_is_export(line: &str) -> bool {
    line.trim_start().starts_with("export ")
}

fn const_initializer_is_callable(signature: &str) -> bool {
    let lower = signature.to_lowercase();
    lower.contains("=>")
        || lower.contains("= function")
        || lower.contains("= async function")
}

fn extract_after_keyword(line: &str, keyword: &str) -> String {
    let lower = line.to_lowercase();
    let pos = lower.find(keyword).unwrap_or(0);
    let rest = line[pos + keyword.len()..].trim();
    extract_first_identifier(rest)
}

fn extract_first_identifier(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            out.push(ch);
        } else if !out.is_empty() {
            break;
        }
    }
    out
}

fn find_block_end(lines: &[&str], start: usize) -> usize {
    let mut depth = 0i32;
    for (offset, line) in lines.iter().enumerate().skip(start) {
        for ch in line.chars() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return offset;
                    }
                }
                _ => {}
            }
        }
    }
    lines.len().saturating_sub(1)
}

fn find_python_block_end(lines: &[&str], start: usize) -> usize {
    let base_indent = lines[start].chars().take_while(|c| c.is_whitespace()).count();
    for (offset, line) in lines.iter().enumerate().skip(start + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let indent = line.chars().take_while(|c| c.is_whitespace()).count();
        if indent <= base_indent {
            return offset.saturating_sub(1);
        }
    }
    lines.len().saturating_sub(1)
}

fn extract_leading_comment(lines: &[&str], start: usize) -> Option<String> {
    let mut comments = Vec::new();
    let mut idx = start;
    while idx > 0 {
        idx -= 1;
        let trimmed = lines[idx].trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("///") || trimmed.starts_with('*') {
            comments.push(trimmed.trim_start_matches('/').trim_start_matches('*').trim().to_string());
            continue;
        }
        break;
    }
    if comments.is_empty() {
        None
    } else {
        comments.reverse();
        Some(comments.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_handle_send_from_tsx() {
        let source = include_str!("../../../test-fixtures/kc-qa-corpus/code/ChatView.tsx");
        let entities = extract_entities_heuristic(source, "tsx", Some("ChatView.tsx"));
        let handle_send = entities.iter().find(|e| e.name == "handleSend").expect("handleSend");
        assert_eq!(handle_send.kind, CodeEntityKind::Function);
        assert!(handle_send.line_start <= 10);
        assert!(handle_send.line_end >= 15);
        assert!(handle_send.body.contains("setInput('')"));
        assert!(
            entities.iter().all(|e| e.name != "content"),
            "nested local `content` must not be extracted"
        );
    }
}
