use crate::database::Database;
use crate::error::{AppError, AppResult};
use crate::file_context;
use crate::knowledge_chat::code_entities::CodeParseMode;
use crate::knowledge_chat::code_languages::is_code_extension;
use crate::knowledge_chat::code_parser::parse_code_file;
use crate::knowledge_chat::chunking::{
    chunk_code_splitter, chunk_document_for_index, truncate_title, ChunkIndexOptions,
};
use crate::knowledge_chat::contextual_index::{
    build_contextual_prefix, build_enriched_embed_text, build_entity_contextual_prefix,
    ContextualIndexInput,
};
use crate::knowledge_chat::db::{self, StoredChunkInput};
use crate::knowledge_chat::db_entities::{self, StoredCodeEntityInput};
use crate::knowledge_chat::filter::{is_usable_extracted_text_for_extension, normalized_text_fingerprint, should_skip_file, should_treat_index_message_as_skip};
use crate::knowledge_chat::ocr_repair::{is_ocr_markdown_name, repair_ocr_markdown};
use crate::knowledge_chat::pdf_ocr::{ocr_pdf_to_markdown_sync, ocr_sidecar_path, pdf_needs_ocr};
use crate::knowledge_chat::lexical::top_terms;
use crate::knowledge_chat::scanner::normalize_path;
use crate::knowledge_chat::types::{KcCollectionStatus, KcFileRecord, KcIndexProgress, KcIndexResult, KC_MAX_CHARS_PER_FILE};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use crate::product;
use tauri::Window;

pub struct LexicalIndexOutcome {
    pub indexed_files: usize,
    pub skipped_files: usize,
    pub skipped_during_index: usize,
    pub failed_files: usize,
    pub unchanged_files: usize,
    pub warnings: Vec<String>,
    pub total_files: usize,
}

struct PreparedFileIndex {
    file_id: String,
    content_hash: String,
    text_fingerprint: String,
    chunks: Vec<StoredChunkInput>,
    code_entities: Option<CodeEntityIndexPayload>,
}

struct CodeEntityIndexPayload {
    parse_mode: CodeParseMode,
    language: String,
    entities: Vec<StoredCodeEntityInput>,
    index_message: String,
}

struct IndexRunOptions {
    contextual_indexing: bool,
    semantic_chunking: bool,
    llm_contextual_summaries: bool,
}

pub fn index_lexical(
    db: &Database,
    collection_id: &str,
    rebuild: bool,
    incremental: bool,
    window: Option<&Window>,
) -> AppResult<LexicalIndexOutcome> {
    if rebuild {
        db::clear_collection_index(db, collection_id)?;
    }

    db::update_collection_status(db, collection_id, KcCollectionStatus::Indexing, None)?;
    emit_progress(window, collection_id, "prepare", 0, 0, None, "Preparing local index run...");

    let product_cfg = product::load_product_config(db);
    let index_options = IndexRunOptions {
        contextual_indexing: product_cfg.enable_contextual_indexing,
        semantic_chunking: product_cfg.enable_semantic_chunking,
        llm_contextual_summaries: product_cfg.enable_llm_contextual_summaries,
    };

    let files = db::list_pending_files(db, collection_id)?;
    let total = files.len();
    let mut indexed_files = 0usize;
    let mut failed_files = 0usize;
    let mut skipped_during_index = 0usize;
    let mut unchanged_files = 0usize;
    let mut warnings = Vec::new();

    emit_progress(
        window,
        collection_id,
        "extract",
        0,
        total,
        None,
        "Extracting and chunking files in parallel...",
    );

    let prepared: Vec<Result<PreparedFileIndex, (KcFileRecord, String)>> = files
        .par_iter()
        .map(|file| prepare_file_index(file, incremental, &index_options).map_err(|err| (file.clone(), err.to_string())))
        .collect();

    for (index, result) in prepared.into_iter().enumerate() {
        emit_progress(
            window,
            collection_id,
            "extract",
            index + 1,
            total,
            Some(files[index].name.clone()),
            "Writing indexed chunks...",
        );

        match result {
            Ok(prepared) if prepared.chunks.is_empty() && prepared.code_entities.is_none() => {
                unchanged_files += 1;
            }
            Ok(prepared_file) => {
                let file = files.iter().find(|f| f.id == prepared_file.file_id).ok_or_else(|| {
                    AppError::Unknown("Indexed file record missing during write phase.".to_string())
                })?;
                let tx = db
                    .conn()
                    .unchecked_transaction()
                    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
                let write_result = if let Some(payload) = prepared_file.code_entities {
                    db_entities::replace_file_code_entities(
                        &tx,
                        collection_id,
                        file,
                        &prepared_file.content_hash,
                        payload.parse_mode,
                        &payload.language,
                        &payload.entities,
                    )
                    .map(|_| {
                        if !payload.index_message.is_empty() {
                            warnings.push(format!("{}: {}", file.relative_path, payload.index_message));
                        }
                    })
                } else {
                    db::replace_file_chunks(&tx, collection_id, file, &prepared_file.content_hash, &prepared_file.chunks)
                };
                if let Err(err) = write_result {
                    let message = err.to_string();
                    db::mark_file_error(&tx, &file.id, &message).ok();
                    tx.commit().ok();
                    failed_files += 1;
                    warnings.push(format!("{}: {message}", file.relative_path));
                } else {
                    tx.commit().map_err(|e| AppError::DatabaseError(e.to_string()))?;
                    indexed_files += 1;
                }
            }
            Err((file, message)) => {
                let tx = db
                    .conn()
                    .unchecked_transaction()
                    .map_err(|e| AppError::DatabaseError(e.to_string()))?;
                if should_treat_index_message_as_skip(&message) {
                    db::mark_file_skipped(&tx, &file.id, &message).ok();
                    skipped_during_index += 1;
                } else {
                    db::mark_file_error(&tx, &file.id, &message).ok();
                    failed_files += 1;
                    warnings.push(format!("{}: {message}", file.relative_path));
                }
                tx.commit().ok();
            }
        }
    }

    let skipped_files = db::list_files_by_status(
        db,
        collection_id,
        Some(crate::knowledge_chat::types::KcFileStatus::Skipped),
    )?
    .len();

    Ok(LexicalIndexOutcome {
        indexed_files,
        skipped_files,
        skipped_during_index,
        failed_files,
        unchanged_files,
        warnings,
        total_files: total,
    })
}

fn prepare_file_index(
    file: &KcFileRecord,
    incremental: bool,
    index_options: &IndexRunOptions,
) -> AppResult<PreparedFileIndex> {
    if let Some(reason) = should_skip_file(&file.name, &file.extension, Some(&file.relative_path)) {
        return Err(AppError::Unknown(reason));
    }

    let path_hash = path_metadata_hash(&file.absolute_path, file.modified_at, file.size_bytes);
    if incremental
        && file.status == crate::knowledge_chat::types::KcFileStatus::Indexed
        && file.content_hash.as_deref() == Some(path_hash.as_str())
    {
        return Ok(PreparedFileIndex {
            file_id: file.id.clone(),
            content_hash: path_hash,
            text_fingerprint: file.text_fingerprint.clone().unwrap_or_default(),
            chunks: Vec::new(),
            code_entities: None,
        });
    }

    let path = normalize_path(&file.absolute_path);
    let contexts = file_context::process_files(
        vec![path.clone()],
        Some(KC_MAX_CHARS_PER_FILE),
        Some(KC_MAX_CHARS_PER_FILE),
    )?;
    let context = contexts
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Unknown(format!("No extraction result for {path}")))?;

    let mut extracted = if context.chunks.is_empty() {
        context.text.clone()
    } else {
        context
            .chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    if file.extension.eq_ignore_ascii_case("pdf") && pdf_needs_ocr(&extracted, &context.warnings) {
        let sidecar = ocr_sidecar_path(std::path::Path::new(&path));
        if sidecar.is_file() {
            if let Ok(existing) = std::fs::read_to_string(&sidecar) {
                if is_usable_extracted_text_for_extension(&existing, &file.extension).is_ok() {
                    extracted = existing;
                }
            }
        } else if let Ok(ocr_text) = ocr_pdf_to_markdown_sync(&path) {
            let _ = std::fs::write(&sidecar, &ocr_text);
            extracted = ocr_text;
        }
    }

    let extracted = if is_ocr_markdown_name(&file.name) || extracted.contains("## Page ") {
        repair_ocr_markdown(&extracted)
    } else {
        extracted
    };

    is_usable_extracted_text_for_extension(&extracted, &file.extension).map_err(AppError::Unknown)?;
    let text_fingerprint = normalized_text_fingerprint(&extracted);
    if incremental && file.text_fingerprint.as_deref() == Some(text_fingerprint.as_str()) {
        return Ok(PreparedFileIndex {
            file_id: file.id.clone(),
            content_hash: path_hash,
            text_fingerprint,
            chunks: Vec::new(),
            code_entities: None,
        });
    }

    if is_code_extension(&file.extension) {
        let parsed = parse_code_file(&extracted, &file.extension, Some(&file.name));
        let entities: Vec<StoredCodeEntityInput> = parsed
            .entities
            .into_iter()
            .map(|entity| {
                let embed_source = format!(
                    "{} {} {} {}",
                    entity.name, entity.qualified_name, entity.signature, entity.body
                );
                let contextual_prefix = if index_options.contextual_indexing {
                    build_entity_contextual_prefix(
                        &file.name,
                        entity.kind.as_str(),
                        &entity.name,
                        &entity.language,
                    )
                } else {
                    String::new()
                };
                let body_with_context = if contextual_prefix.is_empty() {
                    entity.body.clone()
                } else {
                    build_enriched_embed_text(
                        &contextual_prefix,
                        &entity.body,
                        &entity.name,
                        index_options.llm_contextual_summaries,
                        None,
                    )
                };
                StoredCodeEntityInput {
                    entity_index: entity.entity_index,
                    language: entity.language.clone(),
                    parse_mode: entity.parse_mode,
                    entity_kind: entity.kind.as_str().to_string(),
                    entity_name: entity.name.clone(),
                    qualified_name: entity.qualified_name.clone(),
                    signature: entity.signature.clone(),
                    body: body_with_context,
                    line_start: entity.line_start,
                    line_end: entity.line_end,
                    start_byte: entity.start_byte as i64,
                    end_byte: entity.end_byte as i64,
                    doc_comment: entity.doc_comment.clone(),
                    text_fingerprint: normalized_text_fingerprint(&entity.body),
                    top_terms: top_terms(&embed_source, 12),
                    lexical_vector: Vec::new(),
                    dense_vector: None,
                }
            })
            .collect();

        if entities.is_empty() {
            // LanguageParser (Tree-sitter) produced nothing — fall back to
            // LlamaIndex CodeSplitter-style line windows so the file is still
            // searchable instead of failing the whole index.
            let splitter_chunks = chunk_code_splitter(
                &extracted,
                &file.extension,
                Some(&file.name),
            );
            if splitter_chunks.is_empty() {
                return Err(AppError::Unknown(format!(
                    "Code parsing produced no entities: {}",
                    parsed.message
                )));
            }
            let partition = crate::knowledge_chat::partitions::partition_for_file(
                &file.extension,
                &file.relative_path,
                "code",
            );
            let stored: Vec<StoredChunkInput> = splitter_chunks
                .into_iter()
                .map(|chunk| {
                    let text = chunk.text.trim().to_string();
                    let contextual_parent = if index_options.contextual_indexing {
                        let prefix = build_contextual_prefix(&ContextualIndexInput {
                            file_name: &file.name,
                            relative_path: Some(&file.relative_path),
                            section_path: &chunk.section_path,
                            title: &chunk.title,
                            doc_type: &chunk.doc_type,
                            partition_id: partition.as_str(),
                        });
                        build_enriched_embed_text(
                            &prefix,
                            &chunk.parent_text,
                            &chunk.section_path,
                            index_options.llm_contextual_summaries,
                            None,
                        )
                    } else {
                        chunk.parent_text.clone()
                    };
                    StoredChunkInput {
                        file_id: file.id.clone(),
                        chunk_index: chunk.index,
                        title: truncate_title(&chunk.title),
                        start_char: chunk.start_char,
                        end_char: chunk.end_char,
                        line_start: chunk.line_start,
                        line_end: chunk.line_end,
                        page_start: chunk.page_start,
                        page_end: chunk.page_end,
                        text: text.clone(),
                        parent_text: contextual_parent,
                        section_path: chunk.section_path,
                        partition_id: partition.as_str().to_string(),
                        doc_type: chunk.doc_type,
                        text_fingerprint: normalized_text_fingerprint(&text),
                        top_terms: top_terms(&text, 12),
                        lexical_vector: Vec::new(),
                        dense_vector: None,
                    }
                })
                .filter(|chunk| !chunk.text.is_empty())
                .collect();
            return Ok(PreparedFileIndex {
                file_id: file.id.clone(),
                content_hash: path_hash,
                text_fingerprint,
                chunks: stored,
                code_entities: None,
            });
        }

        return Ok(PreparedFileIndex {
            file_id: file.id.clone(),
            content_hash: path_hash,
            text_fingerprint,
            chunks: Vec::new(),
            code_entities: Some(CodeEntityIndexPayload {
                parse_mode: parsed.parse_mode,
                language: parsed.language,
                entities,
                index_message: parsed.message,
            }),
        });
    }

    let chunk_opts = ChunkIndexOptions {
        semantic_chunking: index_options.semantic_chunking,
        contextual_indexing: index_options.contextual_indexing,
    };
    let structured = chunk_document_for_index(&extracted, &file.extension, Some(&file.name), &chunk_opts);
    let partition = crate::knowledge_chat::partitions::partition_for_file(
        &file.extension,
        &file.relative_path,
        "document",
    );
    let stored: Vec<StoredChunkInput> = structured
        .into_iter()
        .map(|chunk| {
            let text = chunk.text.trim().to_string();
            let contextual_parent = if index_options.contextual_indexing {
                let prefix = build_contextual_prefix(&ContextualIndexInput {
                    file_name: &file.name,
                    relative_path: Some(&file.relative_path),
                    section_path: &chunk.section_path,
                    title: &chunk.title,
                    doc_type: &chunk.doc_type,
                    partition_id: partition.as_str(),
                });
                build_enriched_embed_text(
                    &prefix,
                    &chunk.parent_text,
                    &chunk.section_path,
                    index_options.llm_contextual_summaries,
                    None,
                )
            } else {
                chunk.parent_text.clone()
            };
            StoredChunkInput {
                file_id: file.id.clone(),
                chunk_index: chunk.index,
                title: truncate_title(&chunk.title),
                start_char: chunk.start_char,
                end_char: chunk.end_char,
                line_start: chunk.line_start,
                line_end: chunk.line_end,
                page_start: chunk.page_start,
                page_end: chunk.page_end,
                text: text.clone(),
                parent_text: contextual_parent,
                section_path: chunk.section_path,
                partition_id: partition.as_str().to_string(),
                doc_type: chunk.doc_type,
                text_fingerprint: normalized_text_fingerprint(&text),
                top_terms: top_terms(&text, 12),
                lexical_vector: Vec::new(),
                dense_vector: None,
            }
        })
        .filter(|chunk| !chunk.text.is_empty())
        .collect();

    if stored.is_empty() {
        return Err(AppError::Unknown(
            "Chunking produced no searchable text; file skipped.".to_string(),
        ));
    }

    Ok(PreparedFileIndex {
        file_id: file.id.clone(),
        content_hash: path_hash,
        text_fingerprint,
        chunks: stored,
        code_entities: None,
    })
}

fn path_metadata_hash(path: &str, modified_at: i64, size_bytes: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(modified_at.to_le_bytes());
    hasher.update(size_bytes.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn finalize_index(
    db: &Database,
    collection_id: &str,
    outcome: LexicalIndexOutcome,
    dense_status: &str,
    window: Option<&Window>,
) -> AppResult<KcIndexResult> {
    let collection = db::refresh_collection_stats(db, collection_id, Some(dense_status))?;
    let final_status = if outcome.indexed_files > 0 || outcome.failed_files == 0 {
        KcCollectionStatus::Ready
    } else {
        KcCollectionStatus::Failed
    };
    let failure_message = format!("{} file(s) failed during indexing.", outcome.failed_files);
    db::update_collection_status(
        db,
        collection_id,
        final_status.clone(),
        if outcome.failed_files > 0 {
            Some(failure_message.as_str())
        } else {
            None
        },
    )?;

    emit_progress(
        window,
        collection_id,
        "complete",
        outcome.total_files,
        outcome.total_files,
        None,
        "Indexing complete.",
    );

    Ok(KcIndexResult {
        collection_id: collection_id.to_string(),
        indexed_files: outcome.indexed_files,
        skipped_files: outcome.skipped_files,
        failed_files: outcome.failed_files,
        unchanged_files: outcome.unchanged_files,
        total_files: collection.file_count,
        total_indexed_files: collection.indexed_file_count,
        chunk_count: collection.chunk_count as usize,
        dense_chunk_count: collection.dense_chunk_count as usize,
        indexed_char_count: collection.indexed_char_count as usize,
        warnings: outcome.warnings,
        file_issues: db::list_non_indexed_file_issues(db, collection_id)?,
        status: final_status,
    })
}

fn emit_progress(
    window: Option<&Window>,
    collection_id: &str,
    phase: &str,
    current: usize,
    total: usize,
    file_name: Option<String>,
    message: &str,
) {
    if let Some(window) = window {
        let payload = KcIndexProgress {
            collection_id: collection_id.to_string(),
            phase: phase.to_string(),
            current,
            total,
            file_name,
            message: message.to_string(),
        };
        let _ = window.emit("kc-index-progress", payload);
    }
}
