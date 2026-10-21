use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

// Host-owned record of which server lease this desktop is currently serving,
// per environment. The renderer reports lease ready/page mount/close; cookie
// import and partition settle validate against this instead of trusting
// per-request renderer identity. Ephemeral by design: a restart clears every
// lease, exactly like the renderer registry it mirrors.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRouteAuthority {
    pub authority_runtime_id: String,
    pub authority_epoch: String,
    pub browser_host_client_id: String,
    pub browser_host_generation: i64,
    pub execution_host_key: String,
}

#[derive(Debug, Default)]
pub struct ClientRouteAuthorityState {
    authorities: Mutex<HashMap<String, ClientRouteAuthority>>,
}

impl ClientRouteAuthorityState {
    pub fn note(&self, environment_id: &str, authority: ClientRouteAuthority) -> bool {
        if environment_id.is_empty()
            || authority.authority_runtime_id.is_empty()
            || authority.execution_host_key.is_empty()
        {
            return false;
        }
        let Ok(mut authorities) = self.authorities.lock() else {
            return false;
        };
        authorities.insert(environment_id.to_owned(), authority);
        true
    }

    pub fn close(&self, environment_id: &str) -> bool {
        let Ok(mut authorities) = self.authorities.lock() else {
            return false;
        };
        authorities.remove(environment_id).is_some()
    }

    pub fn get(&self, environment_id: &str) -> Option<ClientRouteAuthority> {
        self.authorities
            .lock()
            .ok()
            .and_then(|authorities| authorities.get(environment_id).cloned())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRouteAuthorityNoteArgs {
    pub environment_id: String,
    pub authority_runtime_id: String,
    pub authority_epoch: String,
    pub browser_host_client_id: String,
    pub browser_host_generation: i64,
    pub execution_host_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRouteAuthorityCloseArgs {
    pub environment_id: String,
}

#[tauri::command]
pub fn poc_browser_client_route_note_authority(
    state: State<ClientRouteAuthorityState>,
    args: ClientRouteAuthorityNoteArgs,
) -> bool {
    state.note(
        &args.environment_id,
        ClientRouteAuthority {
            authority_runtime_id: args.authority_runtime_id,
            authority_epoch: args.authority_epoch,
            browser_host_client_id: args.browser_host_client_id,
            browser_host_generation: args.browser_host_generation,
            execution_host_key: args.execution_host_key,
        },
    )
}

#[tauri::command]
pub fn poc_browser_client_route_close_authority(
    state: State<ClientRouteAuthorityState>,
    args: ClientRouteAuthorityCloseArgs,
) -> bool {
    state.close(&args.environment_id)
}

#[cfg(test)]
mod tests {
    use super::ClientRouteAuthority;
    use super::ClientRouteAuthorityState;

    fn authority(host_key: &str) -> ClientRouteAuthority {
        ClientRouteAuthority {
            authority_runtime_id: "runtime-1".to_owned(),
            authority_epoch: "epoch-1".to_owned(),
            browser_host_client_id: "host-1".to_owned(),
            browser_host_generation: 3,
            execution_host_key: host_key.to_owned(),
        }
    }

    #[test]
    fn notes_updates_and_closes_per_environment() {
        let state = ClientRouteAuthorityState::default();
        assert!(!state.note("", authority("native:1")));
        assert!(!state.note(
            "env-1",
            ClientRouteAuthority {
                execution_host_key: String::new(),
                ..authority("native:1")
            }
        ));
        assert!(state.note("env-1", authority("native:1")));
        assert_eq!(
            state.get("env-1").map(|entry| entry.execution_host_key),
            Some("native:1".to_owned())
        );
        assert!(state.get("env-2").is_none());
        assert!(state.note("env-1", authority("native:2")));
        assert_eq!(
            state.get("env-1").map(|entry| entry.execution_host_key),
            Some("native:2".to_owned())
        );
        assert!(state.close("env-1"));
        assert!(!state.close("env-1"));
        assert!(state.get("env-1").is_none());
    }
}
