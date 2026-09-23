//! `delta-blob` URI scheme: serves one side of a binary file's raw bytes straight to
//! an `<img src>`, so image previews never cross IPC as base64.
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::git::cache::DiffCache;
use crate::git::diff::{BlobSide, FileSources};
use crate::git::model::Target;

pub const SCHEME: &str = "delta-blob";

/// Mirrors `MAX_IMAGE_PREVIEW_BYTES` in src/diff/binaryFile.ts: the webview decodes
/// every pixel, so a multi-hundred-MB "image" would stall it.
const MAX_IMAGE_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

struct BlobQuery {
    target: Target,
    path: String,
    side: BlobSide,
    mime: String,
}

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let cache = ctx.app_handle().state::<DiffCache>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || responder.respond(respond(&cache, &request)));
}

fn parse(request: &Request<Vec<u8>>) -> Option<BlobQuery> {
    let url = tauri::Url::parse(&request.uri().to_string()).ok()?;
    let (mut target, mut path, mut side, mut mime) = (None, None, None, None);
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "target" => target = serde_json::from_str(&value).ok(),
            "path" => path = Some(value.into_owned()),
            "side" => side = serde_json::from_value(serde_json::Value::String(value.into_owned())).ok(),
            "mime" => mime = Some(value.into_owned()),
            _ => {}
        }
    }
    let mime = mime.filter(|m| m.starts_with("image/")).unwrap_or_else(|| "application/octet-stream".into());
    Some(BlobQuery { target: target?, path: path?, side: side?, mime })
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

fn respond(cache: &DiffCache, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(q) = parse(request) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let read = |repo: &git2::Repository, sources: &FileSources| match sources.size(repo, q.side) {
        Some(size) if size > MAX_IMAGE_PREVIEW_BYTES => Err(StatusCode::PAYLOAD_TOO_LARGE),
        _ => Ok(sources.read(repo, q.side)),
    };
    match cache.with_sources(&q.target, &q.path, read) {
        Ok(Err(code)) => status(code),
        Ok(Ok(Some(bytes))) => Response::builder()
            .header(header::CONTENT_TYPE, q.mime)
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR)),
        Ok(Ok(None)) => status(StatusCode::NOT_FOUND),
        Err(_) => status(StatusCode::INTERNAL_SERVER_ERROR),
    }
}
