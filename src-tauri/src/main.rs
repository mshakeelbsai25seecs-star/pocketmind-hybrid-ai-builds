#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod hardware;
mod database;
mod crypto;
mod models;
mod llm;
mod characters;
mod file_context;
mod commands;
mod deployment;
mod product;
mod ocr_settings;
mod audit;
mod gguf;
mod knowledge_chat;
mod tooling;
mod sandbox_runners;
mod code_workspace;
mod cw_checkpoints;
mod cw_symbol_index;
mod cw_terminal;
mod cw_pty;
mod cw_git;
mod cw_diagnostics;
mod cw_debug;
mod cw_output;
mod image_studio;
mod cw_plans;
mod cw_ocr;
mod cw_pdf_pages;
mod cw_pdf_prepare;
mod cw_skills;
mod mcp_host;
mod llama_server_host;
mod process_util;
mod power_features;
mod power_commands;
mod unlimited_ocr;
mod doc_export;

use tauri::{GlobalShortcutManager, Manager, WindowEvent};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tokio::sync::Mutex;

use commands::AppState;
use database::Database;
use hardware::HardwareMonitor;
use crypto::CryptoVault;
use llm::InferenceBackend;

fn main() {
    env_logger::init();
    deployment::configure_process_storage_env();
    pocketcode_workspace::init_store_root(deployment::preferred_data_root().join("pocketcode"));

    let device_key = CryptoVault::derive_key_from_device();

    let db = match Database::new() {
        Ok(db) => db,
        Err(err) => {
            eprintln!(
                "PocketMind Hybrid AI could not open the database at {}: {err}",
                deployment::app_database_dir().display()
            );
            std::process::exit(1);
        }
    };

    let generation_cancel = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .manage(AppState {
            db: Arc::new(Mutex::new(db)),
            hardware: Arc::new(Mutex::new(HardwareMonitor::new())),
            crypto: Arc::new(CryptoVault::new(&device_key)),
            local_backend: Arc::new(llm::local::LlamaCppBackend::new(generation_cancel.clone())),
            kc_embed_pool: knowledge_chat::runtime::KcEmbedPool::new(),
            kc_rerank_pool: knowledge_chat::llama_rerank::KcRerankPool::new(),
            generation_cancel,
            download_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            download_tracked: Arc::new(Mutex::new(Vec::new())),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_system_info,
            commands::get_model_recommendations,
            commands::create_conversation,
            commands::get_conversations,
            commands::delete_conversation,
            commands::update_conversation_title,
            commands::add_message,
            commands::update_message,
            commands::get_messages,
            commands::stream_generate,
            commands::generate_response,
            commands::stop_generation,
            commands::unload_chat_model,
            commands::create_character,
            commands::get_characters,
            commands::update_character,
            commands::delete_character,
            commands::store_api_key,
            commands::remove_api_key,
            commands::get_api_key_providers,
            commands::validate_api_key,
            commands::get_enterprise_server_config,
            commands::save_enterprise_server_config,
            commands::get_enterprise_server_token,
            commands::clear_enterprise_server_key,
            commands::list_enterprise_server_models,
            commands::test_enterprise_server_connection,
            commands::get_local_models,
            commands::delete_local_model,
            commands::import_local_model,
            commands::scan_model_folder,
            commands::begin_model_download_job,
            commands::cancel_model_download,
            commands::download_model,
            commands::process_attachments,
            commands::get_runtime_diagnostics,
            commands::get_gpu_runtime_report,
            commands::kill_llama_servers,
            commands::path_exists,
            commands::link_mmproj_beside_model,
            commands::write_soc_text_export,
            commands::scan_soc_knowledge_folder,
            commands::validate_soc_dense_embedding_provider,
            commands::embed_soc_dense_texts,
            commands::save_soc_dense_index,
            commands::load_soc_dense_index,
            commands::ocr_soc_pdf,
            commands::export_backup,
            commands::import_backup,
            commands::get_settings,
            commands::set_setting,
            commands::get_deployment_config,
            commands::set_deployment_config,
            commands::get_deployment_paths,
            commands::ensure_deployment_directories,
            commands::validate_deployment_path,
            commands::get_last_session,
            knowledge_chat::kc_list_collections,
            knowledge_chat::kc_get_collection,
            knowledge_chat::kc_create_collection,
            knowledge_chat::kc_delete_collection,
            knowledge_chat::kc_scan_collection,
            knowledge_chat::kc_list_collection_files,
            knowledge_chat::kc_index_collection,
            knowledge_chat::kc_hybrid_search,
            knowledge_chat::kc_prepare_search_query,
            knowledge_chat::kc_embed_query,
            knowledge_chat::kc_validate_embedding_model,
            knowledge_chat::kc_set_default_embedding_model,
            knowledge_chat::kc_get_default_embedding_model,
            knowledge_chat::kc_discover_embedding_models,
            knowledge_chat::kc_resolve_embedding_model,
            knowledge_chat::kc_quick_scan_folder,
            knowledge_chat::kc_preview_partition_mix,
            knowledge_chat::kc_run_eval,
            knowledge_chat::kc_collection_health,
            knowledge_chat::kc_ocr_capabilities,
            knowledge_chat::kc_set_collection_image_rag,
            knowledge_chat::kc_image_rag_enrich,
            knowledge_chat::kc_system_readiness,
            commands::get_ocr_image_rag_config,
            commands::save_ocr_image_rag_config,
            commands::test_image_rag_connection,
            unlimited_ocr::probe_unlimited_ocr_status,
            unlimited_ocr::download_unlimited_ocr_model,
            doc_export::generate_document_spec,
            doc_export::export_document,
            doc_export::generate_and_export_document,
            doc_export::probe_doc_export,
            doc_export::install_doc_export_support,
            knowledge_chat::kc_build_file_catalog,
            knowledge_chat::kc_load_selected_files,
            knowledge_chat::kc_build_repo_map,
            knowledge_chat::kc_codebase_explorer_context,
            knowledge_chat::kc_ensure_qa_corpus,
            commands::get_product_config,
            commands::set_product_config,
            commands::log_audit_event,
            commands::get_audit_log,
            commands::export_audit_log,
            power_commands::tooling_status,
            power_commands::tooling_repair,
            power_commands::list_workspace_profiles,
            power_commands::create_workspace_profile,
            power_commands::switch_workspace_profile,
            power_commands::delete_workspace_profile,
            power_commands::get_active_workspace_profile,
            power_commands::configure_backup_schedule,
            power_commands::get_backup_schedule,
            power_commands::run_encrypted_backup,
            power_commands::restore_encrypted_backup,
            power_commands::verify_local_model_integrity,
            power_commands::scan_orphan_files,
            power_commands::delete_orphan_files,
            power_commands::batch_process_folder,
            power_commands::cw_can_use,
            power_commands::cw_list_dir,
            power_commands::cw_glob,
            power_commands::cw_grep,
            power_commands::cw_read_file,
            power_commands::cw_load_project_rules,
            power_commands::cw_apply_edit_preview,
            power_commands::cw_apply_edit_write,
            power_commands::cw_run_sandbox,
            power_commands::cw_list_runners,
            power_commands::cw_terminal_start,
            power_commands::cw_terminal_read,
            power_commands::cw_terminal_kill,
            power_commands::cw_terminal_list,
            power_commands::cw_terminal_kill_all,
            power_commands::cw_pty_shells,
            power_commands::cw_pty_spawn,
            power_commands::cw_pty_write,
            power_commands::cw_pty_resize,
            power_commands::cw_pty_kill,
            power_commands::cw_pty_list,
            power_commands::cw_git_status,
            power_commands::cw_git_diff,
            power_commands::cw_diagnostics_run,
            power_commands::cw_output_snapshot,
            power_commands::cw_output_clear,
            power_commands::cw_debug_start,
            power_commands::cw_debug_eval,
            power_commands::cw_debug_stop,
            power_commands::cw_debug_current,
            power_commands::image_studio_generate,
            power_commands::image_studio_save_b64,
            power_commands::image_studio_save_bytes,
            power_commands::cw_delete_file,
            power_commands::cw_checkpoint_begin,
            power_commands::cw_checkpoint_snapshot_write,
            power_commands::cw_checkpoint_snapshot_delete,
            power_commands::cw_list_checkpoints,
            power_commands::cw_restore_checkpoint,
            power_commands::cw_restore_checkpoint_file,
            power_commands::cw_checkpoint_manifest,
            power_commands::cw_ensure_symbol_index,
            power_commands::cw_repo_map,
            power_commands::cw_find_symbol,
            power_commands::cw_read_symbol,
            power_commands::cw_plan_write,
            power_commands::cw_plan_read,
            power_commands::cw_plan_list,
            power_commands::cw_plan_update_markdown,
            power_commands::cw_plan_update_status,
            power_commands::cw_ocr_image,
            power_commands::cw_prepare_pdfs,
            power_commands::cw_prepare_pdf,
            power_commands::cw_image_base64,
            power_commands::cw_save_temp_image,
            power_commands::cw_pdf_page_images,
            power_commands::cw_archive_workspace_zip_base64,
            power_commands::local_model_vision_ready,
            power_commands::cw_whisper_transcribe,
            power_commands::cw_list_skills,
            power_commands::cw_read_skill,
            power_commands::cw_skills_dirs,
            power_commands::mcp_list_servers,
            power_commands::mcp_get_config,
            power_commands::mcp_save_config,
            power_commands::mcp_list_tools,
            power_commands::mcp_call_tool,
            power_commands::mcp_test_server,
            power_commands::mcp_config_path,
            power_commands::mcp_setup_cursor_bridge,
            power_commands::mcp_export_to_cursor,
            power_commands::mcp_cursor_paths,
            power_commands::get_llama_server_host_hint,
        ])
        .setup(|app| {
            knowledge_chat::qa_corpus::spawn_startup_bootstrap(app.handle());

            let handle = app.handle();
            if let Err(err) = app.global_shortcut_manager().register("Ctrl+Shift+Space", move || {
                let _ = handle.emit_all("quick-compose-open", ());
            }) {
                log::warn!("Failed to register Ctrl+Shift+Space quick-compose shortcut: {err}");
            }

            // Ensure workspace profile schema exists before profile-aware queries run.
            {
                let state = app.state::<AppState>();
                let db = tauri::async_runtime::block_on(state.db.lock());
                if let Err(err) = power_features::ensure_profile_schema(&db) {
                    log::warn!("Workspace profile schema init: {err}");
                }
            }

            // Smart RAM offload: under sustained memory pressure, reduce gpu_layers
            // and unload the chat model so Automatic Optimizer relaunches leaner next turn.
            let pressure_db = app.state::<AppState>().db.clone();
            let pressure_hw = app.state::<AppState>().hardware.clone();
            let pressure_backend = app.state::<AppState>().local_backend.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(45)).await;
                    let info = {
                        let mut hw = pressure_hw.lock().await;
                        hw.get_system_info()
                    };
                    let total = info.memory.total_bytes.max(1);
                    let available = info.memory.available_bytes;
                    let pressure = (available as f64 / total as f64) < 0.12;
                    if !pressure {
                        continue;
                    }
                    let mut config = {
                        let db = pressure_db.lock().await;
                        deployment::load_deployment_config(&db)
                    };
                    if config.gpu_layers > 0 {
                        let reduced = (config.gpu_layers / 2).max(0);
                        if reduced != config.gpu_layers {
                            log::warn!(
                                "Memory pressure detected ({:.1}% free); reducing gpu_layers {} → {}",
                                (available as f64 / total as f64) * 100.0,
                                config.gpu_layers,
                                reduced
                            );
                            config.gpu_layers = reduced;
                            let db = pressure_db.lock().await;
                            let _ = deployment::save_deployment_config(&db, &config);
                            crate::llm::runtime_discovery::set_embed_gpu_layers(config.gpu_layers);
                        }
                    }
                    let _ = pressure_backend.unload_model().await;
                }
            });

            // Scheduled encrypted backup loop (checks every 15 minutes).
            let backup_db = app.state::<AppState>().db.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(900)).await;
                    power_commands::tick_backup_scheduler(backup_db.clone()).await;
                }
            });

            Ok(())
        })
        .on_window_event(|event| {
            match event.event() {
                WindowEvent::CloseRequested { .. } => {
                    let state = event.window().state::<AppState>();
                    let embed_pool = state.kc_embed_pool.clone();
                    let rerank_pool = state.kc_rerank_pool.clone();
                    tauri::async_runtime::spawn(async move {
                        embed_pool.shutdown().await;
                        rerank_pool.shutdown().await;
                    });
                }
                WindowEvent::Resized(_) => {
                    if event.window().is_minimized().unwrap_or(false) {
                        let state = event.window().state::<AppState>();
                        let backend = state.local_backend.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = backend.unload_model().await;
                        });
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}