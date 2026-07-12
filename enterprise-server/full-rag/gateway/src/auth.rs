use axum::http::{header, Request, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::body::Body;

pub async fn require_bearer(
    expected: String,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let auth = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or("")
        .trim();
    if token.is_empty() || token != expected {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}
