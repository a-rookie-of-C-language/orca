use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const MAX_SECOND_INSTANCE_DOCUMENTS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecondInstancePayload {
    pub id: u64,
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Debug, Default)]
pub struct SecondInstanceState {
    next_id: AtomicU64,
    pending: Mutex<Vec<SecondInstancePayload>>,
}

impl SecondInstanceState {
    pub fn record(&self, args: Vec<String>, cwd: String) -> SecondInstancePayload {
        let payload = SecondInstancePayload {
            id: self.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            args,
            cwd,
        };
        if let Ok(mut pending) = self.pending.lock() {
            pending.push(payload.clone());
        }
        payload
    }

    pub fn consume(&self) -> Vec<SecondInstancePayload> {
        self.pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub file_path: String,
    pub relative_path: String,
    pub basename: String,
    pub name: String,
}

pub fn resolve_opened_documents(paths: Vec<String>) -> Vec<OpenedDocument> {
    let mut seen = HashSet::new();
    let mut documents = Vec::new();
    for path in paths {
        if documents.len() >= MAX_SECOND_INSTANCE_DOCUMENTS || path.starts_with('-') {
            continue;
        }
        let source = PathBuf::from(&path);
        if !source.is_absolute() || !is_supported_document(&source) {
            continue;
        }
        let Ok(metadata) = fs::metadata(&source) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let normalized = source.to_string_lossy().into_owned();
        let key = if cfg!(windows) {
            normalized.to_ascii_lowercase()
        } else {
            normalized.clone()
        };
        if !seen.insert(key) {
            continue;
        }
        let Some(file_name) = source
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
        else {
            continue;
        };
        let name = source
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| file_name.clone());
        documents.push(OpenedDocument {
            file_path: normalized,
            relative_path: file_name.clone(),
            basename: file_name,
            name,
        });
    }
    documents
}

fn is_supported_document(path: &std::path::Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "mdx" | "markdown" | "csv" | "tsv")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn queues_and_consumes_second_instance_payloads() {
        let state = SecondInstanceState::default();
        let first = state.record(vec!["one".into()], "cwd".into());
        let second = state.record(vec!["two".into()], "cwd".into());

        assert_eq!(first.id + 1, second.id);
        assert_eq!(state.consume().len(), 2);
        assert!(state.consume().is_empty());
    }

    #[test]
    fn resolves_existing_supported_documents_and_deduplicates_paths() {
        let root = std::env::temp_dir().join(format!(
            "orca-tauri-second-instance-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let markdown = root.join("notes.md");
        let unsupported = root.join("notes.txt");
        File::create(&markdown).unwrap();
        File::create(&unsupported).unwrap();

        let documents = resolve_opened_documents(vec![
            markdown.to_string_lossy().into_owned(),
            markdown.to_string_lossy().into_owned(),
            unsupported.to_string_lossy().into_owned(),
        ]);

        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].basename, "notes.md");
        assert_eq!(documents[0].name, "notes");
        assert_eq!(documents[0].relative_path, "notes.md");
        std::fs::remove_dir_all(root).unwrap();
    }
}
