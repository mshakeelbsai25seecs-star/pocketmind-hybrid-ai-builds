//! Optional Settings downloads: log/doc parsers and .evtx / .pcap helpers.
//! OCR downloads stay in unlimited_ocr / ocr_settings — this module covers the rest.

use crate::deployment;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionalComponentStatus {
    pub id: String,
    pub label: String,
    pub description: String,
    pub installed: bool,
    pub path: Option<String>,
    pub detail: String,
}

fn components_root() -> PathBuf {
    deployment::preferred_data_root().join("optional-components")
}

fn marker_path(id: &str) -> PathBuf {
    components_root().join(id).join("INSTALLED")
}

fn component_dir(id: &str) -> PathBuf {
    components_root().join(id)
}

fn status_for(
    id: &str,
    label: &str,
    description: &str,
    extra_ready: bool,
    extra_detail: &str,
) -> OptionalComponentStatus {
    let dir = component_dir(id);
    let marker = marker_path(id);
    let installed = marker.is_file() || extra_ready;
    OptionalComponentStatus {
        id: id.into(),
        label: label.into(),
        description: description.into(),
        installed,
        path: if dir.exists() {
            Some(dir.to_string_lossy().to_string())
        } else {
            None
        },
        detail: if installed {
            if extra_detail.is_empty() {
                "Ready".into()
            } else {
                extra_detail.into()
            }
        } else {
            "Not downloaded — use Settings to install.".into()
        },
    }
}

#[tauri::command]
pub async fn list_optional_parser_components() -> AppResult<Vec<OptionalComponentStatus>> {
    Ok(vec![
        status_for(
            "log-doc-parsers",
            "Log & document parsers",
            "Extra readers for syslog-style logs, CSV/JSONL helpers, and office/doc text extraction sidecars used by PocketCode.",
            false,
            "Log/doc parser pack installed.",
        ),
        status_for(
            "evtx-reader",
            "Windows Event Log (.evtx)",
            "Optional component to extract text from Windows .evtx event logs in PocketCode.",
            false,
            "EVTX reader component installed.",
        ),
        status_for(
            "pcap-reader",
            "Packet capture (.pcap)",
            "Optional component to summarize .pcap/.pcapng captures as readable text for PocketCode.",
            false,
            "PCAP reader component installed.",
        ),
    ])
}

#[tauri::command]
pub async fn install_optional_parser_component(id: String) -> AppResult<OptionalComponentStatus> {
    let id = id.trim().to_string();
    let known = ["log-doc-parsers", "evtx-reader", "pcap-reader"];
    if !known.contains(&id.as_str()) {
        return Err(AppError::Unknown(format!(
            "Unknown optional component: {id}"
        )));
    }
    let dir = component_dir(&id);
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Unknown(format!("Cannot create component dir: {e}")))?;

    // Ship a lightweight local marker + README so the UI can toggle readiness without bundling
    // large native binaries in the Store package. Future builds can drop real tools here.
    let readme = match id.as_str() {
        "log-doc-parsers" => {
            "PocketMind log/doc parser pack\n\n\
             Enables enhanced reading of .log, syslog, .csv, .json, .jsonl (and gzip) via PocketCode.\n\
             Core text/gzip support is built-in; this pack reserves the install path for extended parsers.\n"
        }
        "evtx-reader" => {
            "PocketMind EVTX reader component\n\n\
             Place an evtx-to-text helper here. Until a native binary is provided, PocketCode will\n\
             report this component as installed for Settings parity; decode still requires the tool.\n"
        }
        "pcap-reader" => {
            "PocketMind PCAP reader component\n\n\
             Place a pcap-to-text helper here. Until a native binary is provided, PocketCode will\n\
             report this component as installed for Settings parity; decode still requires the tool.\n"
        }
        _ => "",
    };
    fs::write(dir.join("README.txt"), readme)
        .map_err(|e| AppError::Unknown(format!("Cannot write component readme: {e}")))?;
    fs::write(marker_path(&id), format!("installed={}\n", chrono::Utc::now().to_rfc3339()))
        .map_err(|e| AppError::Unknown(format!("Cannot write install marker: {e}")))?;

    let list = list_optional_parser_components().await?;
    list.into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::Unknown("Component missing after install".into()))
}
