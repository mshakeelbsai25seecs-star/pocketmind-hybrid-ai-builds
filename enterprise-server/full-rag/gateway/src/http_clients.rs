use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

#[derive(Clone)]
pub struct HttpClients {
    pub client: Client,
}

impl HttpClients {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .context("build HTTP client")?;
        Ok(Self { client })
    }

    pub async fn embed(&self, base_v1: &str, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/embeddings", base_v1.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": "embed",
            "input": texts,
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("embeddings {status}: {text}"));
        }
        let payload: Value = resp.json().await.context("parse embeddings JSON")?;
        let data = payload
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("embeddings missing data"))?;
        let mut out = Vec::with_capacity(data.len());
        for item in data {
            let arr = item
                .get("embedding")
                .and_then(|v| v.as_array())
                .ok_or_else(|| anyhow!("missing embedding array"))?;
            let mut vec: Vec<f32> = arr.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect();
            l2_normalize(&mut vec);
            out.push(vec);
        }
        Ok(out)
    }

    pub async fn rerank(
        &self,
        rerank_base: &str,
        query: &str,
        documents: &[String],
    ) -> Result<Vec<f64>> {
        if documents.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/v1/rerank", rerank_base.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": "rerank",
            "query": query,
            "documents": documents,
            "top_n": documents.len(),
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("rerank {status}: {text}"));
        }
        let payload: Value = resp.json().await.context("parse rerank JSON")?;
        let mut scores = vec![0.0f64; documents.len()];
        let results = payload
            .get("results")
            .or_else(|| payload.get("data"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for item in results {
            let idx = item.get("index").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as usize;
            let score = item
                .get("relevance_score")
                .or_else(|| item.get("score"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if idx < scores.len() {
                scores[idx] = score;
            }
        }
        Ok(scores)
    }

    pub async fn list_models(&self, llm_base: &str) -> Result<Value> {
        let url = format!("{}/models", llm_base.trim_end_matches('/'));
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            // Soft stub so desktop model pickers still work during pilot
            return Ok(serde_json::json!({
                "object": "list",
                "data": [{ "id": "nexus-rag-llm", "object": "model", "owned_by": "nexusai" }]
            }));
        }
        Ok(resp.json().await.unwrap_or_else(|_| {
            serde_json::json!({
                "object": "list",
                "data": [{ "id": "nexus-rag-llm", "object": "model", "owned_by": "nexusai" }]
            })
        }))
    }

    pub async fn chat_completion(&self, llm_base: &str, system: &str, user: &str) -> Result<String> {
        let url = format!("{}/chat/completions", llm_base.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": "nexus-rag-llm",
            "temperature": 0.2,
            "max_tokens": 1024,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ]
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow!("LLM {status}: {text}"));
        }
        let payload: Value = resp.json().await.context("parse chat JSON")?;
        let content = payload
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() {
            Err(anyhow!("empty LLM response"))
        } else {
            Ok(content)
        }
    }
}

fn l2_normalize(values: &mut [f32]) {
    let mag = values.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>().sqrt();
    if mag <= 0.0 {
        return;
    }
    for v in values.iter_mut() {
        *v = (*v as f64 / mag) as f32;
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum()
}
