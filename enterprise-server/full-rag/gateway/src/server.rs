use crate::auth::require_bearer;
use crate::config::GatewayConfig;
use crate::db::GatewayDb;
use crate::http_clients::HttpClients;
use crate::index;
use crate::search;
use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub cfg: GatewayConfig,
    pub db: Arc<GatewayDb>,
    pub http: HttpClients,
    pub index_lock: Arc<Mutex<()>>,
}

pub async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cfg = GatewayConfig::from_env()?;
    std::fs::create_dir_all(&cfg.collections_dir)?;
    let db = Arc::new(GatewayDb::open(&cfg.db_path)?);
    let http = HttpClients::new()?;
    let token = cfg.token.clone();
    let state = AppState {
        cfg: cfg.clone(),
        db,
        http,
        index_lock: Arc::new(Mutex::new(())),
    };

    let public = Router::new().route("/health", get(health));

    let protected = Router::new()
        .route("/v1/models", get(list_models))
        .route("/v1/knowledge/collections", get(list_collections))
        .route("/v1/knowledge/chat", post(knowledge_chat))
        .route("/v1/admin/index", post(admin_index))
        .layer(middleware::from_fn(move |req, next| {
            let expected = token.clone();
            require_bearer(expected, req, next)
        }));

    let app = public
        .merge(protected)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!("nexus-rag-gateway listening on {}", cfg.bind);
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "service": "nexus-rag-gateway",
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn list_models(State(state): State<AppState>) -> Result<impl IntoResponse, (StatusCode, String)> {
    let models = state
        .http
        .list_models(&state.cfg.llm_base_url)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(models))
}

async fn list_collections(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rows = state
        .db
        .list_collections()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    // Shape closer to desktop KcCollection for thin client mapping
    let mapped: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "name": c.name,
                "root_path": c.root_path,
                "status": c.status,
                "embedding_model_path": "",
                "dense_status": c.dense_status,
                "file_count": c.file_count,
                "indexed_file_count": c.indexed_file_count,
                "chunk_count": c.chunk_count,
                "dense_chunk_count": c.dense_chunk_count,
                "code_entity_count": 0,
                "indexed_char_count": 0,
                "last_error": c.last_error,
                "created_at": c.created_at,
                "updated_at": c.updated_at,
                "last_indexed_at": c.updated_at,
                "folder_category": "mixed",
                "partition_config": { "folder_category": "mixed", "partitions": [] }
            })
        })
        .collect();
    Ok(Json(mapped))
}

#[derive(Debug, Deserialize)]
pub struct ChatBody {
    pub message: String,
    #[serde(default)]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub collection_name: Option<String>,
}

async fn knowledge_chat(
    State(state): State<AppState>,
    Json(body): Json<ChatBody>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let key = body
        .collection_id
        .or(body.name)
        .or(body.collection_name)
        .unwrap_or_default();
    if key.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "collection_id or name is required".into(),
        ));
    }
    if body.message.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "message is required".into()));
    }
    let resp = search::knowledge_chat(
        &state.db,
        &state.http,
        &state.cfg,
        key.trim(),
        body.message.trim(),
    )
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(resp))
}

#[derive(Debug, Deserialize)]
pub struct IndexBody {
    pub name: String,
    #[serde(default)]
    pub rebuild: bool,
}

async fn admin_index(
    State(state): State<AppState>,
    Json(body): Json<IndexBody>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let name = body.name.trim();
    if name.is_empty() || name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err((StatusCode::BAD_REQUEST, "invalid collection name".into()));
    }
    let _guard = state.index_lock.lock().await;
    let result = index::index_collection(&state.db, &state.http, &state.cfg, name, body.rebuild)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(result))
}
