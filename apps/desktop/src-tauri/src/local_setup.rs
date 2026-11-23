use std::process::Command;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn start_local_router(app: AppHandle) -> Result<(), String> {
    let runtime = app
        .path()
        .resolve("router-runtime", tauri::path::BaseDirectory::Resource)
        .map_err(|_| "Could not locate the bundled Router.")?;

    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(runtime.join("node"))
            .arg(runtime.join("deploy/macos/setup-router.mjs"))
            .arg("--start")
            .output()
            .map_err(|_| "Could not start the bundled Router. Reinstall Blazar from the DMG.")?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr
            .lines()
            .find_map(|line| line.strip_prefix("Error: "))
            .unwrap_or("Could not start the local Router. Check the Blazar Router logs.");
        Err(message.to_owned())
    })
    .await
    .map_err(|_| "Router setup did not finish.")?
}

#[tauri::command]
pub async fn add_local_agent(
    app: AppHandle,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    use std::process::Stdio;

    let runtime = app
        .path()
        .resolve("router-runtime", tauri::path::BaseDirectory::Resource)
        .map_err(|_| "Could not locate the bundled Agent service.")?;
    let body = serde_json::to_vec(&input).map_err(|_| "Invalid Agent configuration.")?;
    if body.len() > 80_000 {
        return Err("Agent configuration is too large.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(runtime.join("node"))
            .arg("--experimental-strip-types")
            .arg(runtime.join("deploy/macos/setup-agent.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Could not start the bundled Agent setup.")?;
        let write = child
            .stdin
            .take()
            .ok_or("Could not open Agent setup input.")?
            .write_all(&body);
        let output = child
            .wait_with_output()
            .map_err(|_| "Agent setup did not finish.")?;
        if output.status.success() && write.is_ok() {
            return serde_json::from_slice(&output.stdout)
                .map_err(|_| "Could not read Agent setup result.".into());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr
            .lines()
            .find_map(|line| line.strip_prefix("Error: "))
            .unwrap_or("Could not set up the Agent.")
            .to_owned())
    })
    .await
    .map_err(|_| "Agent setup did not finish.")?
}
