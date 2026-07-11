/// Central registry for code file extensions, languages, and Tree-sitter availability.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParserBackend {
    TreeSitter,
    HeuristicOnly,
}

#[derive(Debug, Clone, Copy)]
pub struct CodeLanguageSpec {
    pub language_id: &'static str,
    pub extensions: &'static [&'static str],
    pub parser: ParserBackend,
    pub display_name: &'static str,
}

const SPECS: &[CodeLanguageSpec] = &[
    CodeLanguageSpec {
        language_id: "javascript",
        extensions: &["js", "jsx", "mjs", "cjs"],
        parser: ParserBackend::TreeSitter,
        display_name: "JavaScript",
    },
    CodeLanguageSpec {
        language_id: "typescript",
        extensions: &["ts", "tsx"],
        parser: ParserBackend::TreeSitter,
        display_name: "TypeScript",
    },
    CodeLanguageSpec {
        language_id: "python",
        extensions: &["py", "pyw"],
        parser: ParserBackend::TreeSitter,
        display_name: "Python",
    },
    CodeLanguageSpec {
        language_id: "rust",
        extensions: &["rs"],
        parser: ParserBackend::TreeSitter,
        display_name: "Rust",
    },
    CodeLanguageSpec {
        language_id: "go",
        extensions: &["go"],
        parser: ParserBackend::TreeSitter,
        display_name: "Go",
    },
    CodeLanguageSpec {
        language_id: "java",
        extensions: &["java"],
        parser: ParserBackend::TreeSitter,
        display_name: "Java",
    },
    CodeLanguageSpec {
        language_id: "kotlin",
        extensions: &["kt", "kts"],
        parser: ParserBackend::TreeSitter,
        display_name: "Kotlin",
    },
    CodeLanguageSpec {
        language_id: "csharp",
        extensions: &["cs"],
        parser: ParserBackend::TreeSitter,
        display_name: "C#",
    },
    CodeLanguageSpec {
        language_id: "cpp",
        extensions: &["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
        parser: ParserBackend::TreeSitter,
        display_name: "C++",
    },
    CodeLanguageSpec {
        language_id: "c",
        extensions: &["c", "h"],
        parser: ParserBackend::TreeSitter,
        display_name: "C",
    },
    CodeLanguageSpec {
        language_id: "sql",
        extensions: &["sql"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "SQL",
    },
    CodeLanguageSpec {
        language_id: "ruby",
        extensions: &["rb"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "Ruby",
    },
    CodeLanguageSpec {
        language_id: "php",
        extensions: &["php"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "PHP",
    },
    CodeLanguageSpec {
        language_id: "swift",
        extensions: &["swift"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "Swift",
    },
    CodeLanguageSpec {
        language_id: "scala",
        extensions: &["scala"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "Scala",
    },
    CodeLanguageSpec {
        language_id: "shell",
        extensions: &["sh", "bash", "ps1"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "Shell",
    },
    CodeLanguageSpec {
        language_id: "css",
        extensions: &["css", "scss", "less"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "CSS",
    },
    CodeLanguageSpec {
        language_id: "vue",
        extensions: &["vue", "svelte"],
        parser: ParserBackend::HeuristicOnly,
        display_name: "Vue/Svelte",
    },
];

pub fn spec_for_extension(extension: &str) -> Option<&'static CodeLanguageSpec> {
    let ext = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    SPECS.iter().find(|spec| spec.extensions.iter().any(|item| *item == ext.as_str()))
}

pub fn is_code_extension(extension: &str) -> bool {
    spec_for_extension(extension).is_some()
}

pub fn all_code_extensions() -> Vec<&'static str> {
    SPECS
        .iter()
        .flat_map(|spec| spec.extensions.iter().copied())
        .collect()
}

pub fn language_id_for_extension(extension: &str) -> Option<&'static str> {
    spec_for_extension(extension).map(|spec| spec.language_id)
}

pub fn has_tree_sitter(extension: &str) -> bool {
    spec_for_extension(extension)
        .map(|spec| spec.parser == ParserBackend::TreeSitter)
        .unwrap_or(false)
}

pub fn is_tree_sitter_language(language_id: &str) -> bool {
    SPECS
        .iter()
        .any(|spec| spec.language_id == language_id && spec.parser == ParserBackend::TreeSitter)
}
