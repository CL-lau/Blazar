use serde::Serialize;
use std::path::{Path, PathBuf};

const BUILT_INS: &[(&str, &str, &str)] = &[
    ("codex", "Codex", "codex"),
    ("claude", "Claude Code", "claude"),
    ("pi", "Pi", "pi"),
    ("dsh", "DSH", "dsh"),
    ("omp", "OMP", "omp"),
];

#[derive(Serialize)]
pub struct AgentInstallation {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    path: Option<PathBuf>,
}

fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| {
        if !metadata.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        true
    })
}

#[tauri::command]
pub fn detect_local_agents() -> Vec<AgentInstallation> {
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = std::env::home_dir() {
        directories.extend(
            [".local/bin", ".cargo/bin", ".npm-global/bin", "bin"].map(|dir| home.join(dir)),
        );
    }
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    BUILT_INS
        .iter()
        .map(|&(id, name, command)| AgentInstallation {
            id,
            name,
            command,
            path: directories
                .iter()
                .map(|dir| dir.join(command))
                .find(|path| executable(path)),
        })
        .collect()
}
