#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Deserialize)]
struct RouterCall {
    token: String,
    path: String,
    method: String,
    body: Option<Value>,
    key: Option<String>,
}

#[derive(Serialize)]
struct RouterReply {
    status: u16,
    json: bool,
    text: String,
}

fn identifier(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn allowed(method: &Method, path: &str) -> bool {
    let (route, query) = path
        .split_once('?')
        .map_or((path, None), |(route, query)| (route, Some(query)));
    let segments: Vec<_> = route.split('/').collect();
    let accepts_query = method == Method::GET
        && (route == "/memory"
            || matches!(segments.as_slice(), ["", "tasks", id, "timeline"] | ["", "artifacts", id, "diff"] if identifier(id)));
    if query.is_some() && !accepts_query && route != "/stream" {
        return false;
    }
    if path.len() > 4096
        || path.contains('#')
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return false;
    }
    match (method.as_str(), segments.as_slice()) {
        ("GET", ["", "stream"]) => query
            .and_then(|value| value.strip_prefix("once=1&after="))
            .is_some_and(|cursor| {
                !cursor.is_empty() && cursor.bytes().all(|byte| byte.is_ascii_digit())
            }),
        ("GET", ["", "state" | "app-connections" | "memory"]) => true,
        (
            "POST",
            ["", "events" | "conversation" | "workflows" | "pairings" | "app-connections" | "memory"],
        ) => true,
        ("POST", ["", "app-connections", id, "import-document" | "test-document" | "revoke-resource"])
        | ("GET", ["", "app-connections", id, "usage"]) => {
            identifier(id)
        }
        ("PATCH" | "DELETE", ["", "app-connections" | "memory", id]) => {
            identifier(id)
        }
        ("GET", ["", "admin", "mobile-clients" | "devices" | "workers"]) => true,
        ("POST", ["", "admin", "devices" | "task-links"]) => true,
        ("GET", ["", "admin", "tasks", id, "links"]) => identifier(id),
        ("DELETE", ["", "admin", "tasks", id, "links", link]) => {
            identifier(id) && link.len() == 64 && link.bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        ("PATCH", ["", "admin", "devices", id]) => identifier(id),
        ("POST", ["", "memory", "answer"]) => true,
        ("GET", ["", "artifacts", id] | ["", "artifacts", id, "diff" | "image"]) => identifier(id),
        ("GET", ["", "tasks", id, "timeline"]) => identifier(id),
        ("POST", ["", "tasks", id, "commands" | "remember-result"]) => identifier(id),
        ("DELETE", ["", "admin", "mobile-clients" | "devices", id]) => identifier(id),
        _ => false,
    }
}

struct RouterClient {
    http: Client,
    port: u16,
}

#[tauri::command]
async fn router_request(
    client: tauri::State<'_, RouterClient>,
    call: RouterCall,
) -> Result<RouterReply, String> {
    request_local_router(&client, call).await
}

fn loopback_client() -> Client {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .expect("create local Router client")
}

async fn request_local_router(
    client: &RouterClient,
    call: RouterCall,
) -> Result<RouterReply, String> {
    let method = Method::from_bytes(call.method.as_bytes()).map_err(|_| "Invalid Router method")?;
    if !allowed(&method, &call.path) {
        return Err("Unsupported Router operation".into());
    }
    let mut request = client
        .http
        .request(
            method,
            format!("http://127.0.0.1:{}/v1{}", client.port, call.path),
        )
        .bearer_auth(call.token);
    if call.path.starts_with("/stream?") {
        request = request.timeout(Duration::from_secs(35));
    }
    if let Some(key) = call.key {
        request = request.header("Idempotency-Key", key);
    }
    if let Some(body) = call.body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not reach the local Router")?;
    let status = response.status().as_u16();
    let json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    let text = response
        .text()
        .await
        .map_err(|_| "Could not read the Router response")?;
    Ok(RouterReply { status, json, text })
}

fn main() {
    let client = loopback_client();
    let port = std::env::var("BLAZAR_PORT").map_or(4199, |value| {
        value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .expect("invalid BLAZAR_PORT")
    });
    tauri::Builder::default()
        .manage(RouterClient { http: client, port })
        .invoke_handler(tauri::generate_handler![router_request])
        .run(tauri::generate_context!())
        .expect("run Blazar");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_bridge_allows_only_supported_router_operations() {
        assert!(allowed(&Method::GET, "/admin/devices"));
        assert!(allowed(
            &Method::GET,
            "/memory?workspace=demo&q=guide&state=disabled"
        ));
        assert!(allowed(
            &Method::PATCH,
            "/memory/00000000-0000-0000-0000-000000000000"
        ));
        for (method, path) in [
            (Method::GET, "/artifacts/00000000-0000-0000-0000-000000000000/image"),
            (Method::GET, "/app-connections/00000000-0000-0000-0000-000000000000/usage"),
            (Method::PATCH, "/app-connections/00000000-0000-0000-0000-000000000000"),
            (Method::POST, "/app-connections/00000000-0000-0000-0000-000000000000/test-document"),
            (Method::POST, "/tasks/00000000-0000-0000-0000-000000000000/remember-result"),
        ] {
            assert!(allowed(&method, path), "{method} {path}");
        }
        assert!(!allowed(&Method::GET, "//other.example/v1/state"));
        assert!(allowed(&Method::GET, "/stream?once=1&after=10"));
        assert!(!allowed(&Method::GET, "/stream?after=10"));
        assert!(!allowed(&Method::GET, "/stream?once=1&after=10&after=0"));
        assert!(!allowed(&Method::GET, "/state?redirect=1"));
        assert!(!allowed(&Method::POST, "/device/claim"));
        assert!(!allowed(&Method::GET, "/tasks/../timeline"));
    }

    #[test]
    fn native_bridge_reads_a_one_shot_event_and_the_router_cursor_conflict() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::{Ipv4Addr, TcpListener};

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let event = "id: 11\nevent: task\ndata: {\"type\":\"task.created\"}\n\n";
        let conflict = r#"{"error":"Event cursor requires a new snapshot"}"#;
        let server = std::thread::spawn(move || {
            for (cursor, status, mime, body) in [
                (10, "200 OK", "text/event-stream", event),
                (99, "409 Conflict", "application/json", conflict),
                (100, "302 Found", "text/plain", ""),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&socket);
                let mut target = String::new();
                reader.read_line(&mut target).unwrap();
                assert_eq!(
                    target.trim_end(),
                    format!("GET /v1/stream?once=1&after={cursor} HTTP/1.1")
                );
                let headers: Vec<_> = reader
                    .lines()
                    .map(Result::unwrap)
                    .take_while(|line| !line.is_empty())
                    .collect();
                assert!(headers
                    .iter()
                    .any(|line| line.eq_ignore_ascii_case("authorization: Bearer fixture")));
                write!(socket,
                    "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nLocation: /unexpected\r\n\r\n{body}",
                    body.len(),
                ).unwrap();
            }
        });
        let client = RouterClient {
            http: loopback_client(),
            port,
        };
        let invoke = |cursor| {
            tauri::async_runtime::block_on(request_local_router(
                &client,
                RouterCall {
                    token: "fixture".into(),
                    path: format!("/stream?once=1&after={cursor}"),
                    method: "GET".into(),
                    body: None,
                    key: None,
                },
            ))
            .unwrap()
        };
        let change = invoke(10);
        assert_eq!(change.status, 200);
        assert!(!change.json);
        assert_eq!(change.text, event);
        let reset = invoke(99);
        assert_eq!(reset.status, 409);
        assert!(reset.json);
        assert_eq!(reset.text, conflict);
        assert_eq!(invoke(100).status, 302);
        server.join().unwrap();
    }
}
