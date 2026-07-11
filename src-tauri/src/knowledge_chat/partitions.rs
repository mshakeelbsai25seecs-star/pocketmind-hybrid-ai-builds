//! Partition registry for Knowledge Chat.
//!
//! A collection is split into five embedding partitions. Each owns an
//! independent dense vector space, embedding model, and HNSW index:
//! - `code`: source files (Qwen3-Embedding-8B, last-token pooling)
//! - `documentation`: markdown, HTML, wikis (BGE-M3)
//! - `runbooks`: SOC playbooks, procedures, incident docs (BGE-M3)
//! - `logs_data`: logs, CSV, spreadsheets, structured data (BGE-M3)
//! - `general`: PDF, Office, plain text, catch-all (BGE-M3)
//!
//! `doc_type` remains the granular label used for reranking soft-boosts;
//! the partition is the coarse routing key for embedding model and vector space.

use crate::knowledge_chat::embedding_profiles::EmbeddingProfileId;
use serde::{Deserialize, Serialize};

/// Coarse embedding partition. Each value maps to one dense vector space.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KcPartitionId {
    Code,
    Documentation,
    Runbooks,
    LogsData,
    General,
}

impl KcPartitionId {
    pub fn as_str(&self) -> &'static str {
        match self {
            KcPartitionId::Code => "code",
            KcPartitionId::Documentation => "documentation",
            KcPartitionId::Runbooks => "runbooks",
            KcPartitionId::LogsData => "logs_data",
            KcPartitionId::General => "general",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            KcPartitionId::Code => "code",
            KcPartitionId::Documentation => "documentation",
            KcPartitionId::Runbooks => "runbooks",
            KcPartitionId::LogsData => "logs & data",
            KcPartitionId::General => "general documents",
        }
    }

    pub fn from_value(value: &str) -> KcPartitionId {
        match value.trim().to_ascii_lowercase().as_str() {
            "code" => KcPartitionId::Code,
            "documentation" | "docs" => KcPartitionId::Documentation,
            "runbooks" | "runbook" => KcPartitionId::Runbooks,
            "logs_data" | "logs" | "data" => KcPartitionId::LogsData,
            "general" | "knowledge" => KcPartitionId::General,
            _ => KcPartitionId::General,
        }
    }

    pub fn all() -> [KcPartitionId; 5] {
        [
            KcPartitionId::Code,
            KcPartitionId::Documentation,
            KcPartitionId::Runbooks,
            KcPartitionId::LogsData,
            KcPartitionId::General,
        ]
    }

    pub fn non_code() -> [KcPartitionId; 4] {
        [
            KcPartitionId::Documentation,
            KcPartitionId::Runbooks,
            KcPartitionId::LogsData,
            KcPartitionId::General,
        ]
    }

    pub fn default_profile(&self) -> EmbeddingProfileId {
        match self {
            KcPartitionId::Code => EmbeddingProfileId::Qwen3,
            _ => EmbeddingProfileId::BgeM3,
        }
    }
}

/// User-facing search scope. `All` is the default and merges partitions via RRF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum KcSearchScope {
    Code,
    Documentation,
    Runbooks,
    LogsData,
    General,
    /// Legacy alias: all non-code partitions.
    Docs,
    /// Legacy alias for `All`.
    Both,
    #[default]
    All,
}

impl KcSearchScope {
    pub fn from_value(value: &str) -> KcSearchScope {
        match value.trim().to_ascii_lowercase().as_str() {
            "code" => KcSearchScope::Code,
            "documentation" => KcSearchScope::Documentation,
            "runbooks" | "runbook" => KcSearchScope::Runbooks,
            "logs_data" | "logs" | "data" => KcSearchScope::LogsData,
            "general" | "knowledge" => KcSearchScope::General,
            "docs" | "documents" => KcSearchScope::Docs,
            "both" | "all" => KcSearchScope::All,
            _ => KcSearchScope::All,
        }
    }

    pub fn partitions(&self) -> Vec<KcPartitionId> {
        match self {
            KcSearchScope::Code => vec![KcPartitionId::Code],
            KcSearchScope::Documentation => vec![KcPartitionId::Documentation],
            KcSearchScope::Runbooks => vec![KcPartitionId::Runbooks],
            KcSearchScope::LogsData => vec![KcPartitionId::LogsData],
            KcSearchScope::General => vec![KcPartitionId::General],
            KcSearchScope::Docs => KcPartitionId::non_code().to_vec(),
            KcSearchScope::Both | KcSearchScope::All => KcPartitionId::all().to_vec(),
        }
    }

    pub fn contains(&self, partition: KcPartitionId) -> bool {
        self.partitions().contains(&partition)
    }

    pub fn label(&self) -> &'static str {
        match self {
            KcSearchScope::Code => "code only",
            KcSearchScope::Documentation => "documentation only",
            KcSearchScope::Runbooks => "runbooks only",
            KcSearchScope::LogsData => "logs & data only",
            KcSearchScope::General => "general documents only",
            KcSearchScope::Docs => "all documents",
            KcSearchScope::Both | KcSearchScope::All => "all partitions",
        }
    }
}

/// Folder category selected at collection-create time. Drives the default
/// search scope and which embedding model is preferred per partition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum KcFolderCategory {
    #[default]
    Mixed,
    SourceCodeRepo,
    DocumentationLibrary,
    SecurityRunbooks,
    DataAndLogs,
}

impl KcFolderCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            KcFolderCategory::Mixed => "mixed",
            KcFolderCategory::SourceCodeRepo => "source_code_repo",
            KcFolderCategory::DocumentationLibrary => "documentation_library",
            KcFolderCategory::SecurityRunbooks => "security_runbooks",
            KcFolderCategory::DataAndLogs => "data_and_logs",
        }
    }

    pub fn from_value(value: &str) -> KcFolderCategory {
        match value.trim().to_ascii_lowercase().as_str() {
            "source_code_repo" => KcFolderCategory::SourceCodeRepo,
            "documentation_library" => KcFolderCategory::DocumentationLibrary,
            "security_runbooks" => KcFolderCategory::SecurityRunbooks,
            "data_and_logs" => KcFolderCategory::DataAndLogs,
            _ => KcFolderCategory::Mixed,
        }
    }

    pub fn default_scope(&self) -> KcSearchScope {
        match self {
            KcFolderCategory::SourceCodeRepo => KcSearchScope::Code,
            KcFolderCategory::DocumentationLibrary => KcSearchScope::Documentation,
            KcFolderCategory::SecurityRunbooks => KcSearchScope::Runbooks,
            KcFolderCategory::DataAndLogs => KcSearchScope::LogsData,
            KcFolderCategory::Mixed => KcSearchScope::All,
        }
    }
}

const RUNBOOK_PATH_HINTS: &[&str] = &[
    "runbook",
    "playbook",
    "incident",
    "procedure",
    "triage",
    "response",
    "soc/",
    "secops",
    "ir_",
    "ir-",
    "sop",
    "containment",
];

fn is_runbook_path(relative_path: Option<&str>) -> bool {
    let Some(path) = relative_path else {
        return false;
    };
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    RUNBOOK_PATH_HINTS.iter().any(|hint| lower.contains(hint))
}

/// Route a file to its embedding partition using extension and optional path hints.
pub fn route_file_to_partition(extension: &str, relative_path: Option<&str>) -> KcPartitionId {
    if is_runbook_path(relative_path) {
        return KcPartitionId::Runbooks;
    }

    let ext = extension.trim().trim_start_matches('.').to_ascii_lowercase();
    if crate::knowledge_chat::chunking::is_code_extension(&ext) {
        return KcPartitionId::Code;
    }

    match ext.as_str() {
        "log" | "csv" | "xlsx" | "xlsm" | "tsv" | "parquet" => KcPartitionId::LogsData,
        "json" | "yaml" | "yml" | "xml" => KcPartitionId::LogsData,
        "md" | "markdown" | "html" | "htm" | "rst" | "adoc" | "asciidoc" => {
            KcPartitionId::Documentation
        }
        _ => KcPartitionId::General,
    }
}

/// Map a chunk `doc_type` to its partition when path metadata is unavailable.
pub fn partition_for_doc_type(doc_type: &str) -> KcPartitionId {
    match doc_type.to_ascii_lowercase().as_str() {
        "code" => KcPartitionId::Code,
        "markdown" => KcPartitionId::Documentation,
        "log" => KcPartitionId::LogsData,
        "tabular" | "structured" => KcPartitionId::LogsData,
        _ => KcPartitionId::General,
    }
}

/// Resolve partition for indexing: path-aware routing with doc_type fallback.
pub fn partition_for_file(extension: &str, relative_path: &str, doc_type: &str) -> KcPartitionId {
    let routed = route_file_to_partition(extension, Some(relative_path));
    if routed != KcPartitionId::General {
        return routed;
    }
    partition_for_doc_type(doc_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_partitions_map_correctly() {
        assert_eq!(KcSearchScope::Code.partitions(), vec![KcPartitionId::Code]);
        assert_eq!(
            KcSearchScope::Documentation.partitions(),
            vec![KcPartitionId::Documentation]
        );
        assert_eq!(
            KcSearchScope::All.partitions(),
            KcPartitionId::all().to_vec()
        );
        assert_eq!(
            KcSearchScope::Docs.partitions(),
            KcPartitionId::non_code().to_vec()
        );
        assert!(KcSearchScope::All.contains(KcPartitionId::Code));
        assert!(!KcSearchScope::Documentation.contains(KcPartitionId::Code));
        assert!(KcSearchScope::Docs.contains(KcPartitionId::Runbooks));
    }

    #[test]
    fn legacy_scope_aliases_work() {
        assert_eq!(KcSearchScope::from_value("both"), KcSearchScope::All);
        assert_eq!(KcSearchScope::from_value("docs"), KcSearchScope::Docs);
        assert_eq!(
            KcPartitionId::from_value("knowledge"),
            KcPartitionId::General
        );
    }

    #[test]
    fn code_extensions_route_to_code_partition() {
        for ext in ["rs", "py", "ts", "tsx", "kt", "php", "sql", "css", "go", "cpp"] {
            assert_eq!(
                route_file_to_partition(ext, None),
                KcPartitionId::Code,
                "ext={ext}"
            );
        }
    }

    #[test]
    fn documentation_and_data_routing() {
        for ext in ["md", "html", "rst"] {
            assert_eq!(
                route_file_to_partition(ext, None),
                KcPartitionId::Documentation,
                "ext={ext}"
            );
        }
        for ext in ["log", "csv", "json", "yaml"] {
            assert_eq!(
                route_file_to_partition(ext, None),
                KcPartitionId::LogsData,
                "ext={ext}"
            );
        }
        for ext in ["pdf", "docx", "txt"] {
            assert_eq!(
                route_file_to_partition(ext, None),
                KcPartitionId::General,
                "ext={ext}"
            );
        }
    }

    #[test]
    fn runbook_path_routing() {
        assert_eq!(
            route_file_to_partition("md", Some("soc/incident_response.md")),
            KcPartitionId::Runbooks
        );
        assert_eq!(
            route_file_to_partition("pdf", Some("playbooks/ransomware.pdf")),
            KcPartitionId::Runbooks
        );
    }

    #[test]
    fn doc_type_partition_mapping() {
        assert_eq!(partition_for_doc_type("code"), KcPartitionId::Code);
        assert_eq!(partition_for_doc_type("markdown"), KcPartitionId::Documentation);
        assert_eq!(partition_for_doc_type("log"), KcPartitionId::LogsData);
        assert_eq!(partition_for_doc_type("document"), KcPartitionId::General);
    }

    #[test]
    fn folder_category_round_trips() {
        for cat in [
            KcFolderCategory::Mixed,
            KcFolderCategory::SourceCodeRepo,
            KcFolderCategory::DocumentationLibrary,
            KcFolderCategory::SecurityRunbooks,
            KcFolderCategory::DataAndLogs,
        ] {
            assert_eq!(KcFolderCategory::from_value(cat.as_str()), cat);
        }
    }

    #[test]
    fn folder_category_default_scopes() {
        assert_eq!(
            KcFolderCategory::SecurityRunbooks.default_scope(),
            KcSearchScope::Runbooks
        );
        assert_eq!(
            KcFolderCategory::DataAndLogs.default_scope(),
            KcSearchScope::LogsData
        );
    }

    #[test]
    fn scope_serializes_snake_case() {
        let json = serde_json::to_string(&KcSearchScope::All).unwrap();
        assert_eq!(json, "\"all\"");
        let parsed: KcSearchScope = serde_json::from_str("\"code\"").unwrap();
        assert_eq!(parsed, KcSearchScope::Code);
    }
}
