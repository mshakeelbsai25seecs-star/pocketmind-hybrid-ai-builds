//! Durable SOC case / memory / import / metrics storage under `{data_root}/soc`.

use crate::deployment::{self, DeploymentConfig};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocCaseIndexEntry {
    pub id: String,
    pub title: String,
    pub status: String,
    pub severity: String,
    pub disposition: String,
    pub source_kind: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub closed_at: Option<i64>,
    pub assignee: String,
    pub external_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocMetricsSummary {
    pub total_cases: usize,
    pub open_cases: usize,
    pub closed_cases: usize,
    pub with_verdict: usize,
    pub disposition_mix: Value,
    pub source_mix: Value,
    pub median_time_to_verdict_ms: Option<f64>,
    pub p90_time_to_verdict_ms: Option<f64>,
    pub median_time_to_close_ms: Option<f64>,
    pub p90_time_to_close_ms: Option<f64>,
    pub override_rate: Option<f64>,
    pub override_count: usize,
    pub investigated_coverage: f64,
    pub computed_at: i64,
}

fn soc_root(config: &DeploymentConfig) -> PathBuf {
    PathBuf::from(&config.data_root).join("soc")
}

fn cases_dir(config: &DeploymentConfig) -> PathBuf {
    soc_root(config).join("cases")
}

fn index_path(config: &DeploymentConfig) -> PathBuf {
    cases_dir(config).join("index.json")
}

fn case_dir(config: &DeploymentConfig, case_id: &str) -> PathBuf {
    cases_dir(config).join(case_id)
}

fn case_json_path(config: &DeploymentConfig, case_id: &str) -> PathBuf {
    case_dir(config, case_id).join("case.json")
}

fn memory_path(config: &DeploymentConfig) -> PathBuf {
    soc_root(config).join("memory").join("entries.json")
}

fn imports_dir(config: &DeploymentConfig) -> PathBuf {
    soc_root(config).join("imports")
}

fn metrics_cache_path(config: &DeploymentConfig) -> PathBuf {
    soc_root(config).join("metrics").join("cache.json")
}

fn connectors_config_path(config: &DeploymentConfig) -> PathBuf {
    soc_root(config).join("connectors").join("config.json")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AppError::Unknown(format!("Failed to create {}: {e}", parent.display()))
        })?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| {
            AppError::Unknown(format!("Failed to create temp {}: {e}", tmp.display()))
        })?;
        f.write_all(bytes)
            .map_err(|e| AppError::Unknown(format!("Failed to write temp {}: {e}", tmp.display())))?;
        f.sync_all()
            .map_err(|e| AppError::Unknown(format!("Failed to sync temp {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        AppError::Unknown(format!(
            "Failed to finalize {}: {e}",
            path.display()
        ))
    })?;
    Ok(())
}

fn read_json_file(path: &Path) -> AppResult<Value> {
    let raw = fs::read_to_string(path).map_err(|e| {
        AppError::Unknown(format!("Failed to read {}: {e}", path.display()))
    })?;
    serde_json::from_str(&raw).map_err(|e| {
        AppError::Unknown(format!("Invalid JSON in {}: {e}", path.display()))
    })
}

fn validate_case_id(case_id: &str) -> AppResult<()> {
    let ok = case_id.len() >= 8
        && case_id.len() <= 80
        && case_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(AppError::Unknown(format!("Invalid case id: {case_id}")));
    }
    Ok(())
}

pub fn ensure_soc_dirs(config: &DeploymentConfig) -> AppResult<Vec<String>> {
    let dirs = [
        soc_root(config),
        cases_dir(config),
        soc_root(config).join("memory"),
        imports_dir(config),
        soc_root(config).join("metrics"),
        soc_root(config).join("connectors"),
    ];
    let mut created = Vec::new();
    for dir in dirs {
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| {
                AppError::Unknown(format!("Failed to create {}: {e}", dir.display()))
            })?;
            created.push(deployment::normalize_path_string(&dir.to_string_lossy()));
        }
    }
    let index = index_path(config);
    if !index.exists() {
        atomic_write(&index, b"[]")?;
    }
    let memory = memory_path(config);
    if !memory.exists() {
        atomic_write(&memory, b"[]")?;
    }
    let connectors = connectors_config_path(config);
    if !connectors.exists() {
        atomic_write(&connectors, b"{}")?;
    }
    Ok(created)
}

fn entry_from_case(case: &Value) -> AppResult<SocCaseIndexEntry> {
    let id = case
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Unknown("Case missing id".into()))?
        .to_string();
    Ok(SocCaseIndexEntry {
        id,
        title: case
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        status: case
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("new")
            .to_string(),
        severity: case
            .get("severity")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        disposition: case
            .get("disposition")
            .and_then(|v| v.as_str())
            .unwrap_or("undetermined")
            .to_string(),
        source_kind: case
            .pointer("/source/kind")
            .and_then(|v| v.as_str())
            .unwrap_or("manual")
            .to_string(),
        created_at: case
            .get("createdAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        updated_at: case
            .get("updatedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        closed_at: case.get("closedAt").and_then(|v| v.as_i64()),
        assignee: case
            .get("assignee")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        external_id: case
            .pointer("/source/externalId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

fn load_index(config: &DeploymentConfig) -> AppResult<Vec<SocCaseIndexEntry>> {
    ensure_soc_dirs(config)?;
    let path = index_path(config);
    let value = read_json_file(&path)?;
    let list = value
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for item in list {
        match serde_json::from_value::<SocCaseIndexEntry>(item) {
            Ok(entry) => out.push(entry),
            Err(_) => continue,
        }
    }
    Ok(out)
}

fn save_index(config: &DeploymentConfig, entries: &[SocCaseIndexEntry]) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(entries)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize index: {e}")))?;
    atomic_write(&index_path(config), &bytes)
}

pub fn rebuild_index(config: &DeploymentConfig) -> AppResult<Vec<SocCaseIndexEntry>> {
    ensure_soc_dirs(config)?;
    let mut entries = Vec::new();
    let root = cases_dir(config);
    if root.exists() {
        for entry in fs::read_dir(&root)
            .map_err(|e| AppError::Unknown(format!("Failed to read cases dir: {e}")))?
        {
            let entry = entry
                .map_err(|e| AppError::Unknown(format!("Failed to read cases entry: {e}")))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let case_path = path.join("case.json");
            if !case_path.exists() {
                continue;
            }
            let case = read_json_file(&case_path)?;
            if let Ok(idx) = entry_from_case(&case) {
                entries.push(idx);
            }
        }
    }
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_index(config, &entries)?;
    Ok(entries)
}

pub fn list_cases(config: &DeploymentConfig) -> AppResult<Vec<SocCaseIndexEntry>> {
    let entries = load_index(config)?;
    if entries.is_empty() {
        // Recover if index was wiped but case folders remain.
        let root = cases_dir(config);
        if root.exists() {
            let has_case = fs::read_dir(&root)
                .map(|rd| {
                    rd.filter_map(|e| e.ok())
                        .any(|e| e.path().join("case.json").exists())
                })
                .unwrap_or(false);
            if has_case {
                return rebuild_index(config);
            }
        }
    }
    Ok(entries)
}

pub fn get_case(config: &DeploymentConfig, case_id: &str) -> AppResult<Value> {
    validate_case_id(case_id)?;
    ensure_soc_dirs(config)?;
    let path = case_json_path(config, case_id);
    if !path.exists() {
        return Err(AppError::Unknown(format!("Case not found: {case_id}")));
    }
    read_json_file(&path)
}

pub fn upsert_case(config: &DeploymentConfig, mut case: Value) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    let id = case
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Unknown("Case id is required".into()))?
        .to_string();
    validate_case_id(&id)?;

    let schema = case
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if schema != SCHEMA_VERSION as u64 {
        if schema == 0 {
            case.as_object_mut()
                .ok_or_else(|| AppError::Unknown("Case must be an object".into()))?
                .insert("schemaVersion".into(), json!(SCHEMA_VERSION));
        } else {
            return Err(AppError::Unknown(format!(
                "Unsupported case schemaVersion {schema}; expected {SCHEMA_VERSION}"
            )));
        }
    }

    let now = Utc::now().timestamp_millis();
    let obj = case
        .as_object_mut()
        .ok_or_else(|| AppError::Unknown("Case must be an object".into()))?;
    if !obj.contains_key("createdAt") {
        obj.insert("createdAt".into(), json!(now));
    }
    obj.insert("updatedAt".into(), json!(now));

    let dir = case_dir(config, &id);
    fs::create_dir_all(dir.join("import")).map_err(|e| {
        AppError::Unknown(format!("Failed to create case dirs: {e}"))
    })?;
    fs::create_dir_all(dir.join("artifacts")).map_err(|e| {
        AppError::Unknown(format!("Failed to create artifacts dir: {e}"))
    })?;

    let bytes = serde_json::to_vec_pretty(&case)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize case: {e}")))?;
    atomic_write(&case_json_path(config, &id), &bytes)?;

    let entry = entry_from_case(&case)?;
    let mut index = load_index(config)?;
    if let Some(pos) = index.iter().position(|e| e.id == id) {
        index[pos] = entry;
    } else {
        index.push(entry);
    }
    index.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_index(config, &index)?;
    Ok(case)
}

pub fn delete_case(config: &DeploymentConfig, case_id: &str) -> AppResult<()> {
    validate_case_id(case_id)?;
    ensure_soc_dirs(config)?;
    let dir = case_dir(config, case_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| {
            AppError::Unknown(format!("Failed to delete case {case_id}: {e}"))
        })?;
    }
    let mut index = load_index(config)?;
    index.retain(|e| e.id != case_id);
    save_index(config, &index)?;
    Ok(())
}

pub fn list_memory(config: &DeploymentConfig) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    read_json_file(&memory_path(config))
}

pub fn save_memory(config: &DeploymentConfig, entries: Value) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    if !entries.is_array() {
        return Err(AppError::Unknown("Memory entries must be an array".into()));
    }
    let bytes = serde_json::to_vec_pretty(&entries)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize memory: {e}")))?;
    atomic_write(&memory_path(config), &bytes)?;
    Ok(entries)
}

pub fn save_import_batch(config: &DeploymentConfig, batch: Value) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    let id = batch
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Unknown("Import batch id is required".into()))?
        .to_string();
    validate_case_id(&id)?; // same charset rules
    let bytes = serde_json::to_vec_pretty(&batch)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize import batch: {e}")))?;
    atomic_write(&imports_dir(config).join(format!("{id}.json")), &bytes)?;
    Ok(batch)
}

pub fn write_case_artifact(
    config: &DeploymentConfig,
    case_id: &str,
    relative_name: &str,
    contents: &str,
) -> AppResult<String> {
    validate_case_id(case_id)?;
    ensure_soc_dirs(config)?;
    let clean = relative_name
        .replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .collect::<Vec<_>>()
        .join("/");
    if clean.is_empty() {
        return Err(AppError::Unknown("Artifact name is required".into()));
    }
    let path = case_dir(config, case_id).join("artifacts").join(&clean);
    atomic_write(&path, contents.as_bytes())?;
    Ok(deployment::normalize_path_string(&path.to_string_lossy()))
}

pub fn write_case_import_blob(
    config: &DeploymentConfig,
    case_id: &str,
    relative_name: &str,
    contents: &str,
) -> AppResult<String> {
    validate_case_id(case_id)?;
    ensure_soc_dirs(config)?;
    let clean = relative_name
        .replace('\\', "/")
        .split('/')
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .collect::<Vec<_>>()
        .join("/");
    if clean.is_empty() {
        return Err(AppError::Unknown("Import blob name is required".into()));
    }
    let path = case_dir(config, case_id).join("import").join(&clean);
    atomic_write(&path, contents.as_bytes())?;
    Ok(deployment::normalize_path_string(&path.to_string_lossy()))
}

pub fn export_case_markdown(
    config: &DeploymentConfig,
    case_id: &str,
    markdown: &str,
    filename: Option<String>,
) -> AppResult<String> {
    validate_case_id(case_id)?;
    ensure_soc_dirs(config)?;
    let name = filename
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("{case_id}.md"));
    let safe = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("case.md");
    let path = PathBuf::from(&config.export_dir).join(safe);
    if !config.is_path_allowed(&path.to_string_lossy()) {
        return Err(AppError::Unknown(format!(
            "Export path not allowed: {}",
            path.display()
        )));
    }
    atomic_write(&path, markdown.as_bytes())?;
    Ok(deployment::normalize_path_string(&path.to_string_lossy()))
}

fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted.get(idx).copied()
}

pub fn recompute_metrics(config: &DeploymentConfig) -> AppResult<SocMetricsSummary> {
    ensure_soc_dirs(config)?;
    let index = list_cases(config)?;
    let mut disposition_mix = serde_json::Map::new();
    let mut source_mix = serde_json::Map::new();
    let mut time_to_verdict: Vec<f64> = Vec::new();
    let mut time_to_close: Vec<f64> = Vec::new();
    let mut closed = 0usize;
    let mut with_verdict = 0usize;
    let mut override_count = 0usize;
    let mut override_denom = 0usize;

    for entry in &index {
        let d_key = entry.disposition.clone();
        let d_count = disposition_mix.get(&d_key).and_then(|v| v.as_u64()).unwrap_or(0);
        disposition_mix.insert(d_key, json!(d_count + 1));

        let s_key = entry.source_kind.clone();
        let s_count = source_mix.get(&s_key).and_then(|v| v.as_u64()).unwrap_or(0);
        source_mix.insert(s_key, json!(s_count + 1));

        if entry.closed_at.is_some() || entry.status == "closed" {
            closed += 1;
        }

        if let Ok(case) = get_case(config, &entry.id) {
            let has_verdict = case.get("verdict").map(|v| !v.is_null()).unwrap_or(false);
            if has_verdict {
                with_verdict += 1;
            }
            let created = case.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0) as f64;
            if let Some(fv) = case.pointer("/timings/firstVerdictAt").and_then(|v| v.as_i64()) {
                if fv > 0 && created > 0.0 {
                    time_to_verdict.push(fv as f64 - created);
                }
            }
            if let Some(closed_at) = case.get("closedAt").and_then(|v| v.as_i64()) {
                if closed_at > 0 && created > 0.0 {
                    time_to_close.push(closed_at as f64 - created);
                }
            }
            if case.get("status").and_then(|v| v.as_str()) == Some("closed") {
                let ai = case.pointer("/verdict/aiDisposition").and_then(|v| v.as_str());
                let final_d = case.get("disposition").and_then(|v| v.as_str());
                if let (Some(a), Some(f)) = (ai, final_d) {
                    override_denom += 1;
                    if a != f {
                        override_count += 1;
                    }
                }
            }
        }
    }

    time_to_verdict.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    time_to_close.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let total = index.len();
    let open = total.saturating_sub(closed);
    let summary = SocMetricsSummary {
        total_cases: total,
        open_cases: open,
        closed_cases: closed,
        with_verdict,
        disposition_mix: Value::Object(disposition_mix),
        source_mix: Value::Object(source_mix),
        median_time_to_verdict_ms: percentile(&time_to_verdict, 0.5),
        p90_time_to_verdict_ms: percentile(&time_to_verdict, 0.9),
        median_time_to_close_ms: percentile(&time_to_close, 0.5),
        p90_time_to_close_ms: percentile(&time_to_close, 0.9),
        override_rate: if override_denom > 0 {
            Some(override_count as f64 / override_denom as f64)
        } else {
            None
        },
        override_count,
        investigated_coverage: if total > 0 {
            with_verdict as f64 / total as f64
        } else {
            0.0
        },
        computed_at: Utc::now().timestamp_millis(),
    };

    let bytes = serde_json::to_vec_pretty(&summary)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize metrics: {e}")))?;
    atomic_write(&metrics_cache_path(config), &bytes)?;
    Ok(summary)
}

pub fn get_connectors_config(config: &DeploymentConfig) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    read_json_file(&connectors_config_path(config))
}

pub fn save_connectors_config(config: &DeploymentConfig, value: Value) -> AppResult<Value> {
    ensure_soc_dirs(config)?;
    if !value.is_object() {
        return Err(AppError::Unknown("Connectors config must be an object".into()));
    }
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|e| AppError::Unknown(format!("Failed to serialize connectors config: {e}")))?;
    atomic_write(&connectors_config_path(config), &bytes)?;
    Ok(value)
}

pub fn clear_legacy_localstorage_hint() -> &'static str {
    // Frontend clears pocketmind-soc-incidents-v1 when it only contains the old seed.
    "pocketmind-soc-incidents-v1"
}
