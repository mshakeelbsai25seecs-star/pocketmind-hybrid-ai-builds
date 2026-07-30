//! Shared PocketCode workspace tools for desktop and agent-host.
//!
//! No Tauri dependency — path jail, FS tools, sandbox, symbols, checkpoints, plans.

pub mod checkpoints;
pub mod error;
pub mod path;
pub mod plans;
pub mod sandbox;
pub mod store;
pub mod symbols;
pub mod terminal;
pub mod tools;
pub mod types;

pub use checkpoints::{
    begin_checkpoint, get_manifest, list_checkpoints, restore_checkpoint, restore_file,
    snapshot_before_delete, snapshot_before_write,
};
pub use error::{Error, Result};
pub use path::{canonicalize_root, resolve_under_root, standardize};
pub use store::{
    init_store_root, read_project_rules, store_root, write_project_rules, WorkspaceSidecar,
};
pub use plans::{list_plans, read_plan, update_plan_markdown, update_plan_status, write_plan};
pub use sandbox::{list_runners, run as run_sandbox};
pub use symbols::{ensure_index, find_symbol, read_symbol, repo_map};
pub use terminal::{
    kill as terminal_kill, kill_all as terminal_kill_all, list as terminal_list,
    read as terminal_read, start as terminal_start, TerminalSnapshot, TerminalStartInfo,
};
pub use tools::{
    apply_edit_preview, apply_edit_write, delete_file, glob_file_search, grep, list_dir, read_file,
};
pub use types::*;
