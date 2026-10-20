use serde::Deserialize;
use std::io::{BufRead, BufReader, Read};
use std::sync::mpsc::Sender;

const MAX_READINESS_LINE_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Readiness {
    #[serde(rename = "type")]
    kind: String,
    schema_version: u32,
    pairing: Pairing,
}

#[derive(Deserialize)]
struct Pairing {
    available: bool,
    scope: Option<String>,
    url: Option<String>,
}

fn pairing_url(line: &[u8]) -> Option<String> {
    let ready: Readiness = serde_json::from_slice(line).ok()?;
    if ready.kind != "orca_server_ready"
        || ready.schema_version != 1
        || !ready.pairing.available
        || ready.pairing.scope.as_deref() != Some("runtime")
    {
        return None;
    }
    ready
        .pairing
        .url
        .filter(|url| url.starts_with("orca://pair?code="))
}

pub fn drain_readiness(output: impl Read, sender: Sender<Result<String, String>>) {
    let mut reader = BufReader::new(output);
    let mut published = false;
    loop {
        let mut line = Vec::new();
        match reader
            .by_ref()
            .take(MAX_READINESS_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() as u64 > MAX_READINESS_LINE_BYTES => {
                let _ = sender.send(Err("Runtime output exceeded the readiness limit.".into()));
                // Drain overlong lines without retaining credentials or arbitrary output.
                loop {
                    line.clear();
                    if reader
                        .by_ref()
                        .take(MAX_READINESS_LINE_BYTES)
                        .read_until(b'\n', &mut line)
                        .unwrap_or(0)
                        == 0
                        || line.last() == Some(&b'\n')
                    {
                        break;
                    }
                }
            }
            Ok(_) if !published => {
                if let Some(url) = pairing_url(&line) {
                    published = true;
                    let _ = sender.send(Ok(url));
                }
            }
            Ok(_) => {}
        }
    }
    if !published {
        let _ = sender.send(Err(
            "Runtime exited before publishing a pairing offer.".into()
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    fn offer(scope: &str) -> String {
        format!(
            r#"{{"type":"orca_server_ready","schemaVersion":1,"pairing":{{"available":true,"scope":"{scope}","url":"orca://pair?code=test"}}}}"#
        )
    }

    #[test]
    fn accepts_only_runtime_readiness() {
        assert_eq!(
            pairing_url(offer("runtime").as_bytes()).as_deref(),
            Some("orca://pair?code=test")
        );
        assert!(pairing_url(offer("mobile").as_bytes()).is_none());
        assert!(pairing_url(
            offer("runtime")
                .replace("schemaVersion\":1", "schemaVersion\":2")
                .as_bytes()
        )
        .is_none());
    }

    #[test]
    fn drains_after_readiness_without_publishing_logs_or_duplicate_tokens() {
        let (send, receive) = channel();
        let output = format!("log\n{}\n{}\nsecret\n", offer("runtime"), offer("runtime"));
        drain_readiness(output.as_bytes(), send);
        assert_eq!(
            receive.into_iter().collect::<Vec<_>>(),
            vec![Ok("orca://pair?code=test".into())]
        );
    }

    #[test]
    fn bounds_lines_and_reports_missing_readiness() {
        let (send, receive) = channel();
        drain_readiness(
            vec![b'x'; MAX_READINESS_LINE_BYTES as usize + 20].as_slice(),
            send,
        );
        assert!(receive.into_iter().all(|result| result.is_err()));
    }
}
