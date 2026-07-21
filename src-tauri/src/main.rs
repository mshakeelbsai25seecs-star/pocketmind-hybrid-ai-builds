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

use tauri::{Manager, WindowEvent};
use std::sync::Arc;
use tokio::sync::Mutex;

use commands::AppState;
use database::Database;
use hardware::HardwareMonitor;
use crypto::CryptoVault;

fn main() {
    env_logger::init();
    deployment::configure_process_storage_env();

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

    tauri::Builder::default()
        .manage(AppState {
            db: Arc::new(Mutex::new(db)),
            hardware: Arc::new(Mutex::new(HardwareMonitor::new())),
            crypto: Arc::new(CryptoVault::new(&device_key)),
            local_backend: Arc::new(llm::local::LlamaCppBackend::new()),
            kc_embed_pool: knowledge_chat::runtime::KcEmbedPool::new(),
            kc_rerank_pool: knowledge_chat::llama_rerank::KcRerankPool::new(),
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
            commands::download_model,
            commands::process_attachments,
            commands::get_runtime_diagnostics,
            commands::get_gpu_runtime_report,
            commands::kill_llama_servers,
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
        ])
        .setup(|app| {
            knowledge_chat::qa_corpus::spawn_startup_bootstrap(app.handle());
            Ok(())
        })
        .on_window_event(|event| {
            if let WindowEvent::CloseRequested { .. } = event.event() {
                let state = event.window().state::<AppState>();
                let embed_pool = state.kc_embed_pool.clone();
                let rerank_pool = state.kc_rerank_pool.clone();
                tauri::async_runtime::spawn(async move {
                    embed_pool.shutdown().await;
                    rerank_pool.shutdown().await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}