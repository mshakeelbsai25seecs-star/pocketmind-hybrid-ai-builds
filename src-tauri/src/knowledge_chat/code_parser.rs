use crate::knowledge_chat::code_entities::{
    CodeEntityKind, CodeFileParseResult, CodeParseMode, ParsedCodeEntity,
};
use crate::knowledge_chat::code_heuristic::extract_entities_heuristic;
use crate::knowledge_chat::code_languages::{has_tree_sitter, language_id_for_extension, spec_for_extension};

pub fn parse_code_file(source: &str, extension: &str, file_name: Option<&str>) -> CodeFileParseResult {
    let language = language_id_for_extension(extension)
        .unwrap_or("unknown")
        .to_string();

    if !crate::knowledge_chat::code_languages::is_code_extension(extension) {
        return CodeFileParseResult {
            language,
            parse_mode: CodeParseMode::UnsupportedLanguage,
            entities: Vec::new(),
            message: "Not a recognized code extension.".to_string(),
        };
    }

    let spec = spec_for_extension(extension);
    let tree_sitter_supported = has_tree_sitter(extension);

    if tree_sitter_supported {
        #[cfg(feature = "code-entities")]
        {
            match extract_entities_tree_sitter(source, extension, &language) {
                Ok(mut entities) if !entities.is_empty() => {
                    inject_module_preamble(
                        source,
                        extension,
                        file_name,
                        &mut entities,
                        &language,
                        CodeParseMode::TreeSitter,
                    );
                    let count = entities.len();
                    return CodeFileParseResult {
                        language,
                        parse_mode: CodeParseMode::TreeSitter,
                        entities,
                        message: format!(
                            "Parsed {count} entities via Tree-sitter ({}).",
                            spec.map(|s| s.display_name).unwrap_or("code")
                        ),
                    };
                }
                Ok(_) => {}
                Err(err) => {
                    log::warn!("Tree-sitter parse failed for {extension}: {err}");
                }
            }
        }
    }

    let parse_mode = if tree_sitter_supported {
        CodeParseMode::ParseFailed
    } else {
        CodeParseMode::UnsupportedLanguage
    };

    let mut entities = extract_entities_heuristic(source, extension, file_name);
    let resolved_mode = if entities.is_empty() {
        parse_mode
    } else {
        CodeParseMode::HeuristicFallback
    };
    inject_module_preamble(
        source,
        extension,
        file_name,
        &mut entities,
        &language,
        resolved_mode,
    );
    let message = if tree_sitter_supported {
        format!(
            "Parse failed: falling back to heuristic ({} entities).",
            entities.len()
        )
    } else {
        format!(
            "Heuristic fallback: {} not supported by Tree-sitter v1 ({} entities).",
            spec.map(|s| s.display_name).unwrap_or(extension),
            entities.len()
        )
    };

    CodeFileParseResult {
        language,
        parse_mode: if entities.is_empty() {
            parse_mode
        } else {
            resolved_mode
        },
        entities,
        message,
    }
}

#[cfg(feature = "code-entities")]
fn extract_entities_tree_sitter(
    source: &str,
    extension: &str,
    language: &str,
) -> Result<Vec<ParsedCodeEntity>, String> {
    use streaming_iterator::StreamingIterator;
    use tree_sitter::{Language, Parser, Query, QueryCursor};

    let lang: Language = match language {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" | "kotlin" => tree_sitter_java::LANGUAGE.into(),
        "csharp" => tree_sitter_c_sharp::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        _ if extension.eq_ignore_ascii_case("tsx") || extension.eq_ignore_ascii_case("jsx") => {
            tree_sitter_typescript::LANGUAGE_TSX.into()
        }
        _ => return Err(format!("No Tree-sitter grammar for {language}")),
    };

    let query_src = query_for_language(language, extension);

    let mut parser = Parser::new();
    parser
        .set_language(&lang)
        .map_err(|e| format!("set_language: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "parse returned None".to_string())?;
    let root = tree.root_node();

    let query = Query::new(&lang, query_src).map_err(|e| format!("query: {e}"))?;
    let mut cursor = QueryCursor::new();
    let mut captures = cursor.captures(&query, root, source.as_bytes());

    let mut entities = Vec::new();
    let mut index = 0i64;
    while let Some((mat, _)) = captures.next() {
        for capture in mat.captures {
            let cap_name = query.capture_names()[capture.index as usize];
            if cap_name != "def" {
                continue;
            }
            let entity_node = capture.node;
            let entity_name = entity_node
                .child_by_field_name("name")
                .or_else(|| first_named_child(entity_node))
                .map(|n| node_text(source, n))
                .unwrap_or_default();
            if entity_name.is_empty() {
                continue;
            }
            let kind = kind_from_node(entity_node.kind());
            let start = entity_node.start_byte();
            let end = entity_node.end_byte();
            let body = source.get(start..end).unwrap_or("").to_string();
            let signature = body.lines().next().unwrap_or("").trim().to_string();
            entities.push(ParsedCodeEntity {
                entity_index: index,
                language: language.to_string(),
                kind,
                name: entity_name.clone(),
                qualified_name: entity_name,
                signature,
                body,
                line_start: (entity_node.start_position().row + 1) as i32,
                line_end: (entity_node.end_position().row + 1) as i32,
                start_byte: start,
                end_byte: end,
                parse_mode: CodeParseMode::TreeSitter,
                doc_comment: extract_doc_above(source, start),
            });
            index += 1;
        }
    }

    entities.sort_by_key(|e| e.start_byte);
    entities.dedup_by_key(|e| e.start_byte);

    if entities.is_empty() {
        return Err("Tree-sitter found no entities".to_string());
    }
    Ok(entities)
}

#[cfg(feature = "code-entities")]
fn query_for_language(language: &str, extension: &str) -> &'static str {
    match language {
        "rust" => RUST_QUERY,
        "python" => PYTHON_QUERY,
        "javascript" => JS_QUERY,
        "typescript" => TS_QUERY,
        "go" => GO_QUERY,
        "java" | "kotlin" => JAVA_QUERY,
        "csharp" => CSHARP_QUERY,
        "cpp" => CPP_QUERY,
        "c" => C_QUERY,
        _ if extension.eq_ignore_ascii_case("tsx") || extension.eq_ignore_ascii_case("jsx") => TS_QUERY,
        _ => JS_QUERY,
    }
}

#[cfg(feature = "code-entities")]
fn first_named_child(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
    (0..node.named_child_count()).find_map(|i| node.named_child(i))
}

#[cfg(feature = "code-entities")]
fn node_text(source: &str, node: tree_sitter::Node) -> String {
    source
        .get(node.start_byte()..node.end_byte())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[cfg(feature = "code-entities")]
fn kind_from_node(kind: &str) -> CodeEntityKind {
    match kind {
        k if k.contains("class") => CodeEntityKind::Class,
        k if k.contains("struct") => CodeEntityKind::Struct,
        k if k.contains("enum") => CodeEntityKind::Enum,
        k if k.contains("trait") => CodeEntityKind::Trait,
        k if k.contains("interface") => CodeEntityKind::Interface,
        k if k.contains("method") => CodeEntityKind::Method,
        k if k.contains("type_alias") => CodeEntityKind::TypeAlias,
        k if k.contains("const") => CodeEntityKind::Const,
        _ => CodeEntityKind::Function,
    }
}

#[cfg(feature = "code-entities")]
fn extract_doc_above(source: &str, start_byte: usize) -> Option<String> {
    let prefix = source.get(..start_byte).unwrap_or("");
    let mut lines: Vec<&str> = prefix.lines().collect();
    let mut comments = Vec::new();
    while let Some(line) = lines.pop() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("//") || trimmed.starts_with("///") || trimmed.starts_with('#') {
            comments.push(trimmed.trim_start_matches('/').trim_start_matches('*').trim());
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

fn inject_module_preamble(
    source: &str,
    extension: &str,
    file_name: Option<&str>,
    entities: &mut Vec<ParsedCodeEntity>,
    language: &str,
    parse_mode: CodeParseMode,
) {
    let preamble = extract_module_preamble_text(source, extension, entities);
    if preamble.trim().is_empty() {
        return;
    }
    for entity in entities.iter_mut() {
        entity.entity_index += 1;
    }
    let line_end = preamble.lines().count().max(1) as i32;
    let qualified = format!(
        "{}::module_preamble",
        file_name.unwrap_or("module")
    );
    entities.insert(
        0,
        ParsedCodeEntity {
            entity_index: 0,
            language: language.to_string(),
            kind: CodeEntityKind::Module,
            name: "module_preamble".to_string(),
            qualified_name: qualified,
            signature: String::new(),
            body: preamble.clone(),
            line_start: 1,
            line_end,
            start_byte: 0,
            end_byte: preamble.len(),
            parse_mode,
            doc_comment: None,
        },
    );
}

fn extract_module_preamble_text(
    source: &str,
    extension: &str,
    entities: &[ParsedCodeEntity],
) -> String {
    let lines: Vec<&str> = source.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    let first_entity_line = entities
        .iter()
        .filter(|e| e.name != "module_preamble")
        .map(|e| e.line_start.max(1) as usize)
        .min()
        .unwrap_or(lines.len() + 1);

    let end = first_entity_line.saturating_sub(1).min(lines.len());
    if end == 0 {
        return String::new();
    }

    let preamble: String = lines[..end].join("\n");
    if preamble.trim().is_empty() {
        return String::new();
    }

    let has_imports = preamble.lines().any(|line| is_import_line(line, extension));
    let has_doc_or_const = preamble.lines().any(|line| {
        let t = line.trim();
        !t.is_empty()
            && !is_import_line(t, extension)
            && (t.starts_with('#') || t.starts_with("//") || t.contains('='))
    });

    if has_imports || (has_doc_or_const && end <= 12) {
        preamble
    } else {
        String::new()
    }
}

fn is_import_line(line: &str, extension: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') && !t.starts_with("#include") {
        return false;
    }
    match extension.to_ascii_lowercase().as_str() {
        "py" | "pyw" => t.starts_with("import ") || t.starts_with("from "),
        "rs" => t.starts_with("use ") || t.starts_with("extern crate"),
        "go" => t.starts_with("import "),
        "java" | "kt" | "kts" => t.starts_with("import "),
        "cs" => t.starts_with("using "),
        "cpp" | "cc" | "cxx" | "h" | "hpp" | "c" => t.starts_with("#include"),
        _ => {
            t.starts_with("import ")
                || t.starts_with("from ")
                || t.starts_with("require(")
                || t.starts_with("const ") && t.contains(" require(")
        }
    }
}

const RUST_QUERY: &str = r#"
(function_item name: (identifier) @name) @def
(struct_item name: (type_identifier) @name) @def
(enum_item name: (type_identifier) @name) @def
(trait_item name: (type_identifier) @name) @def
"#;

const PYTHON_QUERY: &str = r#"
(function_definition name: (identifier) @name) @def
(class_definition name: (identifier) @name) @def
"#;

const JS_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @def
(class_declaration name: (identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(lexical_declaration
  (variable_declarator name: (identifier) @name) @def)
"#;

const TS_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @def
(class_declaration name: (type_identifier) @name) @def
(method_definition name: (property_identifier) @name) @def
(lexical_declaration
  (variable_declarator name: (identifier) @name) @def)
"#;

const GO_QUERY: &str = r#"
(function_declaration name: (identifier) @name) @def
(method_declaration name: (field_identifier) @name) @def
(type_declaration (type_spec name: (type_identifier) @name)) @def
"#;

const JAVA_QUERY: &str = r#"
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
"#;

const CSHARP_QUERY: &str = r#"
(class_declaration name: (identifier) @name) @def
(interface_declaration name: (identifier) @name) @def
(method_declaration name: (identifier) @name) @def
"#;

const CPP_QUERY: &str = r#"
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
(class_specifier name: (type_identifier) @name) @def
"#;

const C_QUERY: &str = r#"
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
(struct_specifier name: (type_identifier) @name) @def
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_loader_has_module_preamble() {
        let source = include_str!("../../../test-fixtures/kc-qa-corpus/code/config_loader.py");
        let result = parse_code_file(source, "py", Some("config_loader.py"));
        let preamble = result
            .entities
            .iter()
            .find(|e| e.name == "module_preamble")
            .expect("module_preamble entity");
        assert!(preamble.body.contains("import os"));
    }

    #[test]
    fn parses_chatview_tsx() {
        let source = include_str!("../../../test-fixtures/kc-qa-corpus/code/ChatView.tsx");
        let result = parse_code_file(source, "tsx", Some("ChatView.tsx"));
        assert!(!result.entities.is_empty(), "{}", result.message);
        let handle_send = result
            .entities
            .iter()
            .find(|e| e.name == "handleSend")
            .expect("handleSend entity");
        assert!(handle_send.body.contains("setInput"));
        assert!(handle_send.line_start <= 10);
        assert!(handle_send.line_end >= 15);
        assert!(handle_send.line_start >= 10 && handle_send.line_end <= 16);
    }
}
