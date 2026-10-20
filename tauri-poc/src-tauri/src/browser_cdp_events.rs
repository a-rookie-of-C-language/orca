use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::browser_webview::BrowserWebviewState;

const EVENT_BROWSER_CDP_EVENT: &str = "browser:cdp-event";

// Why allowlist: DevTools event delivery runs page JavaScript-adjacent code
// paths at page speed, so the renderer may only tap the log-grade domains the
// automation engine buffers, plus Fetch.requestPaused which the engine
// observes and immediately continues, plus Target attach/detach which carry
// only frame identity (no page content) for iframe session tracking. Frame
// binaries (Page.screencastFrame) stay out until a consumer exists.
const ALLOWED_CDP_EVENTS: &[&str] = &[
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Fetch.requestPaused",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
];

#[derive(Default)]
pub struct BrowserCdpEventState {
    tokens: Mutex<HashMap<String, i64>>,
}

fn subscription_key(browser_page_id: &str, event_name: &str) -> String {
    format!("{browser_page_id}\n{event_name}")
}

// Why drop on close/recreate: receivers die with their webview, so a token
// kept past that would make a later subscribe a no-op on the new webview.
pub(crate) fn drop_cdp_subscriptions_for_page(
    cdp_state: &State<'_, BrowserCdpEventState>,
    browser_page_id: &str,
) {
    let prefix = format!("{browser_page_id}\n");
    if let Ok(mut tokens) = cdp_state.tokens.lock() {
        tokens.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpSubscribeArgs {
    pub browser_page_id: String,
    pub event_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpEventPayload {
    pub browser_page_id: String,
    pub event: String,
    pub params: serde_json::Value,
}

fn validated_event_name(event_name: &str) -> Result<&'static str, String> {
    ALLOWED_CDP_EVENTS
        .iter()
        .find(|allowed| **allowed == event_name)
        .copied()
        .ok_or_else(|| "browser CDP event is not subscribed".to_string())
}

// Why request/response split: subscribing only registers the WebView2 event
// tap. The renderer enables the matching domain over poc_browser_cdp first,
// so enable failures surface as command errors instead of silent gaps.
#[tauri::command]
pub fn poc_browser_cdp_subscribe(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    cdp_state: State<'_, BrowserCdpEventState>,
    args: BrowserCdpSubscribeArgs,
) -> Result<(), String> {
    let event_name = validated_event_name(args.event_name.as_str())?;
    let key = subscription_key(args.browser_page_id.as_str(), event_name);
    if cdp_state
        .tokens
        .lock()
        .map_err(|_| "browser CDP event state is unavailable".to_string())?
        .contains_key(&key)
    {
        return Ok(());
    }
    let token = attach_cdp_event(&app, &state, args.browser_page_id.as_str(), event_name)?;
    cdp_state
        .tokens
        .lock()
        .map_err(|_| "browser CDP event state is unavailable".to_string())?
        .insert(key, token);
    Ok(())
}

#[tauri::command]
pub fn poc_browser_cdp_unsubscribe(
    app: AppHandle,
    state: State<'_, BrowserWebviewState>,
    cdp_state: State<'_, BrowserCdpEventState>,
    args: BrowserCdpSubscribeArgs,
) -> Result<(), String> {
    let event_name = validated_event_name(args.event_name.as_str())?;
    let key = subscription_key(args.browser_page_id.as_str(), event_name);
    let token = cdp_state
        .tokens
        .lock()
        .map_err(|_| "browser CDP event state is unavailable".to_string())?
        .remove(&key);
    let Some(token) = token else {
        return Ok(());
    };
    detach_cdp_event(
        &app,
        &state,
        args.browser_page_id.as_str(),
        event_name,
        token,
    )
}

#[cfg(windows)]
fn attach_cdp_event(
    app: &AppHandle,
    state: &BrowserWebviewState,
    browser_page_id: &str,
    event_name: &'static str,
) -> Result<i64, String> {
    use webview2_com::{take_pwstr, DevToolsProtocolEventReceivedEventHandler};
    use windows_core::{HSTRING, PCWSTR, PWSTR};

    let webview = crate::browser_webview::child_webview(app, state, browser_page_id)?;
    let app_for_event = app.clone();
    let page_id_for_event = browser_page_id.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    let dispatch = webview.with_webview(move |platform| {
        let result = (|| -> Result<i64, String> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
            let name = HSTRING::from(event_name);
            let receiver =
                unsafe { core.GetDevToolsProtocolEventReceiver(PCWSTR::from_raw(name.as_ptr())) }
                    .map_err(|error| error.to_string())?;
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
                move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut json = PWSTR::null();
                    unsafe { args.ParameterObjectAsJson(&mut json)? };
                    let params_text = take_pwstr(json);
                    let params = serde_json::from_str::<serde_json::Value>(&params_text)
                        .unwrap_or(serde_json::Value::Null);
                    let _ = app_for_event.emit(
                        EVENT_BROWSER_CDP_EVENT,
                        BrowserCdpEventPayload {
                            browser_page_id: page_id_for_event.clone(),
                            event: event_name.to_string(),
                            params,
                        },
                    );
                    Ok(())
                },
            ));
            let mut token = 0_i64;
            unsafe {
                receiver
                    .add_DevToolsProtocolEventReceived(&handler, &mut token)
                    .map_err(|error| error.to_string())?;
            }
            Ok(token)
        })();
        let _ = sender.send(result);
    });
    if dispatch.is_err() {
        return Err("failed to subscribe browser CDP event".to_string());
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "failed to subscribe browser CDP event".to_string())?
}

#[cfg(not(windows))]
fn attach_cdp_event(
    _app: &AppHandle,
    _state: &BrowserWebviewState,
    _browser_page_id: &str,
    _event_name: &'static str,
) -> Result<i64, String> {
    Err("browser DevTools protocol is only available on Windows".to_string())
}

#[cfg(windows)]
fn detach_cdp_event(
    app: &AppHandle,
    state: &BrowserWebviewState,
    browser_page_id: &str,
    event_name: &'static str,
    token: i64,
) -> Result<(), String> {
    use windows_core::{HSTRING, PCWSTR};

    let webview = crate::browser_webview::child_webview(app, state, browser_page_id)?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let dispatch = webview.with_webview(move |platform| {
        let result = (|| -> Result<(), String> {
            let controller = platform.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
            let name = HSTRING::from(event_name);
            let receiver =
                unsafe { core.GetDevToolsProtocolEventReceiver(PCWSTR::from_raw(name.as_ptr())) }
                    .map_err(|error| error.to_string())?;
            unsafe {
                receiver
                    .remove_DevToolsProtocolEventReceived(token)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })();
        let _ = sender.send(result);
    });
    if dispatch.is_err() {
        return Err("failed to unsubscribe browser CDP event".to_string());
    }
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "failed to unsubscribe browser CDP event".to_string())?
}

#[cfg(not(windows))]
fn detach_cdp_event(
    _app: &AppHandle,
    _state: &BrowserWebviewState,
    _browser_page_id: &str,
    _event_name: &'static str,
    _token: i64,
) -> Result<(), String> {
    Ok(())
}
