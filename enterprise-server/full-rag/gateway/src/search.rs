use crate::config::GatewayConfig;
use crate::db::{ChunkHit, GatewayDb};
use crate::http_clients::{cosine, HttpClients};
use anyhow::Result;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Serialize)]
pub struct ChatSource {
    pub file_name: String,
    pub relative_path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub partition_id: String,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub answer: String,
    pub sources: Vec<ChatSource>,
    pub collection_id: String,
}

pub async fn knowledge_chat(
    db: &GatewayDb,
    http: &HttpClients,
    cfg: &GatewayConfig,
    collection_key: &str,
    message: &str,
) -> Result<ChatResponse> {
    let collection = db
        .get_by_id_or_name(collection_key)?
        .ok_or_else(|| anyhow::anyhow!("Collection not found: {collection_key}"))?;
    if collection.status != "ready" && collection.chunk_count == 0 {
        anyhow::bail!(
            "Collection '{}' is not ready (status={}). Run admin index first.",
            collection.name,
            collection.status
        );
    }

    let mut hits = db.fts_search(&collection.id, message, 40)?;

    // Dense hybrid: embed query for code + knowledge and score stored vectors.
    let mut dense_scores: HashMap<String, f64> = HashMap::new();
    if let Ok(code_q) = http.embed(&cfg.embed_code_url, &[message.to_string()]).await {
        if let Some(qv) = code_q.first() {
            for chunk in db.load_dense_chunks(&collection.id, 2000)? {
                if chunk.partition_id != "code" {
                    continue;
                }
                if let Some(ref dv) = chunk.dense {
                    let score = cosine(qv, dv);
                    dense_scores
                        .entry(chunk.id.clone())
                        .and_modify(|s| *s = (*s).max(score))
                        .or_insert(score);
                    if !hits.iter().any(|h| h.id == chunk.id) {
                        let mut c = chunk;
                        c.score = score;
                        hits.push(c);
                    }
                }
            }
        }
    }
    if let Ok(know_q) = http
        .embed(&cfg.embed_knowledge_url, &[message.to_string()])
        .await
    {
        if let Some(qv) = know_q.first() {
            for chunk in db.load_dense_chunks(&collection.id, 2000)? {
                if chunk.partition_id == "code" {
                    continue;
                }
                if let Some(ref dv) = chunk.dense {
                    let score = cosine(qv, dv);
                    dense_scores
                        .entry(chunk.id.clone())
                        .and_modify(|s| *s = (*s).max(score))
                        .or_insert(score);
                    if !hits.iter().any(|h| h.id == chunk.id) {
                        let mut c = chunk;
                        c.score = score;
                        hits.push(c);
                    }
                }
            }
        }
    }

    for hit in hits.iter_mut() {
        if let Some(ds) = dense_scores.get(&hit.id) {
            hit.score = hit.score * 0.45 + ds * 0.55;
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(24);

    // Remote rerank
    if !hits.is_empty() && !cfg.rerank_url.is_empty() {
        let docs: Vec<String> = hits
            .iter()
            .map(|h| {
                let snip: String = h.text.chars().take(2000).collect();
                format!("{} | {} | {}", h.file_name, h.title, snip)
            })
            .collect();
        if let Ok(scores) = http.rerank(&cfg.rerank_url, message, &docs).await {
            let max = scores.iter().copied().fold(0.0f64, f64::max).max(1e-9);
            for (hit, raw) in hits.iter_mut().zip(scores.iter()) {
                hit.score = hit.score * 0.35 + (raw / max) * 0.65;
            }
            hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        }
    }

    hits.truncate(8);
    let sources: Vec<ChatSource> = hits
        .iter()
        .map(|h| ChatSource {
            file_name: h.file_name.clone(),
            relative_path: h.relative_path.clone(),
            title: h.title.clone(),
            snippet: h.text.chars().take(400).collect(),
            score: h.score,
            partition_id: h.partition_id.clone(),
        })
        .collect();

    let context = format_context(&hits);
    let system = "You are NexusAI Knowledge Chat on a private organization server. \
Answer ONLY using the provided sources. If sources are insufficient, say you could not find \
enough evidence in the indexed collection. Cite file names inline when helpful.";
    let user = format!("Question:\n{message}\n\nSources:\n{context}");

    let answer = match http.chat_completion(&cfg.llm_base_url, system, &user).await {
        Ok(text) => text,
        Err(err) => {
            // Extractive fallback when LLM is down
            if hits.is_empty() {
                format!("No matching sources found. (LLM unavailable: {err})")
            } else {
                let mut parts = vec![
                    "LLM unavailable; returning top evidence excerpts:".to_string(),
                    String::new(),
                ];
                for (i, h) in hits.iter().take(3).enumerate() {
                    let snip: String = h.text.chars().take(280).collect();
                    parts.push(format!("{}. {} — {}", i + 1, h.file_name, snip));
                }
                parts.join("\n")
            }
        }
    };

    Ok(ChatResponse {
        answer,
        sources,
        collection_id: collection.id,
    })
}

fn format_context(hits: &[ChunkHit]) -> String {
    hits.iter()
        .enumerate()
        .map(|(i, h)| {
            let snip: String = h.text.chars().take(900).collect();
            format!(
                "[{}] file={} path={} partition={}\n{snip}\n",
                i + 1,
                h.file_name,
                h.relative_path,
                h.partition_id
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
