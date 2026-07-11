use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeParseMode {
    TreeSitter,
    HeuristicFallback,
    UnsupportedLanguage,
    ParseFailed,
}

impl CodeParseMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TreeSitter => "tree_sitter",
            Self::HeuristicFallback => "heuristic",
            Self::UnsupportedLanguage => "unsupported",
            Self::ParseFailed => "failed",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "tree_sitter" => Self::TreeSitter,
            "heuristic" => Self::HeuristicFallback,
            "unsupported" => Self::UnsupportedLanguage,
            "failed" => Self::ParseFailed,
            _ => Self::HeuristicFallback,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeEntityKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    TypeAlias,
    Const,
    Module,
}

impl CodeEntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::TypeAlias => "type_alias",
            Self::Const => "const",
            Self::Module => "module",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "function" => Self::Function,
            "method" => Self::Method,
            "class" => Self::Class,
            "struct" => Self::Struct,
            "enum" => Self::Enum,
            "trait" => Self::Trait,
            "interface" => Self::Interface,
            "type_alias" => Self::TypeAlias,
            "const" => Self::Const,
            "module" => Self::Module,
            _ => Self::Function,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::TypeAlias => "type alias",
            Self::Const => "const",
            Self::Module => "module",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedCodeEntity {
    pub entity_index: i64,
    pub language: String,
    pub kind: CodeEntityKind,
    pub name: String,
    pub qualified_name: String,
    pub signature: String,
    pub body: String,
    pub line_start: i32,
    pub line_end: i32,
    pub start_byte: usize,
    pub end_byte: usize,
    pub parse_mode: CodeParseMode,
    pub doc_comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeFileParseResult {
    pub language: String,
    pub parse_mode: CodeParseMode,
    pub entities: Vec<ParsedCodeEntity>,
    pub message: String,
}
