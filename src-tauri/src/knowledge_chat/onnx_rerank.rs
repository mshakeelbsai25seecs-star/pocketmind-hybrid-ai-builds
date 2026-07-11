use crate::database::Database;
use crate::deployment::load_deployment_config;
use crate::knowledge_chat::types::KcSearchHit;
use std::path::PathBuf;
use std::sync::Mutex;

static ONNX_RERANKER: Mutex<Option<OnnxReranker>> = Mutex::new(None);

struct OnnxReranker {
    #[cfg(feature = "onnx-reranker")]
    session: ort::session::Session,
    #[cfg(feature = "onnx-reranker")]
    tokenizer: tokenizers::Tokenizer,
    max_length: usize,
}

/// Returns true when ONNX scores were applied. Only the top `top_n` hits are
/// rescored; `blend_self`/`blend_new` weight the prior score against the new
/// cross-encoder score.
pub fn onnx_rerank_hits(
    db: &Database,
    query: &str,
    hits: &mut [KcSearchHit],
    top_n: usize,
    blend_self: f64,
    blend_new: f64,
) -> bool {
    if hits.is_empty() {
        return false;
    }
    let Some((model_path, tokenizer_path)) = resolve_reranker_paths(db) else {
        return false;
    };

    let mut guard = match ONNX_RERANKER.lock() {
        Ok(value) => value,
        Err(_) => return false,
    };
    if guard.is_none() {
        *guard = OnnxReranker::load(&model_path, &tokenizer_path).ok();
    }
    let Some(reranker) = guard.as_mut() else {
        return false;
    };

    let capped = hits.len().min(top_n.max(1));
    let scores = reranker.score_batch(query, &hits[..capped]);
    if scores.len() != capped {
        return false;
    }

    let max_score = scores.iter().copied().fold(0.0f32, f32::max);
    for (hit, raw) in hits[..capped].iter_mut().zip(scores.iter()) {
        let normalized = if max_score > 0.0 { raw / max_score } else { 0.0 };
        hit.rerank_score = hit.rerank_score * blend_self + (normalized as f64) * blend_new;
    }
    hits.sort_by(|a, b| {
        b.rerank_score
            .partial_cmp(&a.rerank_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (idx, hit) in hits.iter_mut().enumerate() {
        hit.rank = idx + 1;
    }
    true
}

pub fn onnx_reranker_configured(db: &Database) -> bool {
    resolve_reranker_paths(db).is_some()
}

impl OnnxReranker {
    fn load(model_path: &std::path::Path, tokenizer_path: &std::path::Path) -> Result<Self, String> {
        #[cfg(feature = "onnx-reranker")]
        {
            use ort::session::Session;

            let mut builder = Session::builder().map_err(|e| e.to_string())?;
            let session = builder
                .commit_from_file(model_path)
                .map_err(|e| e.to_string())?;
            let tokenizer = tokenizers::Tokenizer::from_file(tokenizer_path).map_err(|e| e.to_string())?;
            return Ok(Self {
                session,
                tokenizer,
                max_length: 512,
            });
        }
        #[cfg(not(feature = "onnx-reranker"))]
        {
            let _ = (model_path, tokenizer_path);
            Err("Build without `onnx-reranker` feature. Use dense pair rerank or rebuild with --features onnx-reranker.".to_string())
        }
    }

    fn score_batch(&mut self, query: &str, hits: &[KcSearchHit]) -> Vec<f32> {
        #[cfg(feature = "onnx-reranker")]
        {
            self.score_batch_onnx(query, hits)
        }
        #[cfg(not(feature = "onnx-reranker"))]
        {
            let _ = (query, hits);
            Vec::new()
        }
    }

    #[cfg(feature = "onnx-reranker")]
    fn score_batch_onnx(&mut self, query: &str, hits: &[KcSearchHit]) -> Vec<f32> {
        use ndarray::Array2;
        use ort::value::TensorRef;

        let mut input_ids = Vec::new();
        let mut attention_mask = Vec::new();
        let mut token_type_ids = Vec::new();
        let mut encoded = 0usize;

        for hit in hits {
            // The ONNX cross-encoder is model-agnostic, so format the document
            // without any embedding-model instruction prefix.
            let doc = super::dense_rerank::format_document_text(
                super::embedding_profiles::EmbeddingProfileId::Generic,
                hit,
            );
            let encoding = match self.tokenizer.encode((query, doc.as_str()), true) {
                Ok(value) => value,
                Err(_) => continue,
            };
            encoded += 1;
            let ids: Vec<i64> = encoding.get_ids().iter().map(|id| *id as i64).collect();
            let mask: Vec<i64> = encoding.get_attention_mask().iter().map(|v| *v as i64).collect();
            let types: Vec<i64> = encoding.get_type_ids().iter().map(|v| *v as i64).collect();
            let len = ids.len().min(self.max_length);
            let mut padded_ids = ids.into_iter().take(len).collect::<Vec<_>>();
            let mut padded_mask = mask.into_iter().take(len).collect::<Vec<_>>();
            let mut padded_types = types.into_iter().take(len).collect::<Vec<_>>();
            while padded_ids.len() < self.max_length {
                padded_ids.push(0);
                padded_mask.push(0);
                padded_types.push(0);
            }
            input_ids.extend(padded_ids);
            attention_mask.extend(padded_mask);
            token_type_ids.extend(padded_types);
        }

        if encoded == 0 || input_ids.is_empty() {
            return Vec::new();
        }

        let batch = encoded;
        let ids_array = match Array2::from_shape_vec((batch, self.max_length), input_ids) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
        let mask_array = match Array2::from_shape_vec((batch, self.max_length), attention_mask) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
        let types_array = match Array2::from_shape_vec((batch, self.max_length), token_type_ids) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };

        let outputs = match self.session.run(ort::inputs![
            "input_ids" => TensorRef::from_array_view(ids_array.view()).unwrap(),
            "attention_mask" => TensorRef::from_array_view(mask_array.view()).unwrap(),
            "token_type_ids" => TensorRef::from_array_view(types_array.view()).unwrap(),
        ]) {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };

        let logits = match outputs.values().next() {
            Some(value) => value,
            None => return Vec::new(),
        };
        let (shape, data) = match logits.try_extract_tensor::<f32>() {
            Ok(value) => value,
            Err(_) => return Vec::new(),
        };
        if shape.len() == 2 && shape[0] as usize == batch {
            return data
                .chunks(shape[1] as usize)
                .map(|row| row.first().copied().unwrap_or(0.0))
                .collect();
        }
        if data.len() >= batch {
            return data.iter().take(batch).copied().collect();
        }
        Vec::new()
    }
}

fn resolve_reranker_paths(db: &Database) -> Option<(PathBuf, PathBuf)> {
    let setting: Option<String> = db
        .conn()
        .query_row(
            "SELECT value FROM settings WHERE key = 'kc_reranker_model_path'",
            [],
            |row| row.get(0),
        )
        .ok();
    let model_path = setting
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            let deploy = load_deployment_config(db);
            let path = deploy.reranker_model_path.trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })?;
    let model = PathBuf::from(&model_path);
    if !model.is_file() {
        return None;
    }
    let tokenizer = model
        .parent()
        .map(|dir| dir.join("tokenizer.json"))
        .filter(|path| path.is_file())
        .or_else(|| {
            let candidate = model.with_file_name("tokenizer.json");
            candidate.is_file().then_some(candidate)
        })?;
    Some((model, tokenizer))
}
