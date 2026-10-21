//! Host memory snapshot for the Resource Manager status segment.
//!
//! Electron's `memory:getSnapshot` collects app process metrics plus host
//! totals via `os.totalmem()`/`os.freemem()`/`os.loadavg()`. The web fallback
//! returns zeros for everything. The Tauri shell answers the host block with
//! `GlobalMemoryStatusEx`, which reports total/free/available physical memory
//! in one call — the same numbers Node exposes, plus a real `MemAvailable`
//! equivalent Electron only gets on Linux/macOS. Per-worktree and per-process
//! subtree telemetry stays zero (that is host-daemon work, not a renderer
//! responsibility), matching the existing web fallback for those fields.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageValues {
    pub cpu: f64,
    pub memory: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMemorySnapshot {
    pub total_memory: u64,
    pub free_memory: u64,
    pub available_memory: u64,
    /// Electron labels the Windows path `free-memory` — Node has no
    /// MemAvailable probe there, so `available` is just `free`.
    pub available_memory_source: &'static str,
    pub used_memory: u64,
    pub memory_usage_percent: f64,
    pub cpu_core_count: u32,
    pub load_average1m: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMemorySnapshot {
    #[serde(flatten)]
    pub usage: UsageValues,
    pub main: UsageValues,
    pub renderer: UsageValues,
    pub other: UsageValues,
    pub history: Vec<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub app: AppMemorySnapshot,
    /// Empty on the Tauri shell: subtree telemetry is host-daemon work.
    pub worktrees: Vec<serde_json::Value>,
    pub host: HostMemorySnapshot,
    /// Windows reports working set (resident) bytes, matching Electron's
    /// `getProcessMemoryMetric` on win32.
    pub process_memory_metric: &'static str,
    pub total_cpu: f64,
    pub total_memory: u64,
    pub collected_at: u64,
}

#[cfg(windows)]
fn read_host_memory() -> Option<(u64, u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return None;
        }
        // ullAvailPhys is the Windows equivalent of MemAvailable: memory
        // usable without pushing the host into paging, which is exactly what
        // Electron's `availableMemory` means on Linux/macOS.
        Some((
            status.ullTotalPhys,
            status.ullAvailPhys,
            status.ullAvailPhys,
        ))
    }
}

#[cfg(not(windows))]
fn read_host_memory() -> Option<(u64, u64, u64)> {
    None
}

fn cpu_core_count() -> u32 {
    std::thread::available_parallelism()
        .map(|count| count.get() as u32)
        .unwrap_or(1)
}

#[tauri::command]
pub(crate) fn poc_memory_snapshot() -> Result<MemorySnapshot, String> {
    let (total, free, available) = read_host_memory().unwrap_or((0, 0, 0));
    let used = total.saturating_sub(available);
    let memory_usage_percent = if total > 0 {
        (used as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let usage = UsageValues::default();
    Ok(MemorySnapshot {
        app: AppMemorySnapshot {
            usage,
            main: usage,
            renderer: usage,
            other: usage,
            history: Vec::new(),
        },
        worktrees: Vec::new(),
        host: HostMemorySnapshot {
            total_memory: total,
            free_memory: free,
            available_memory: available,
            available_memory_source: "free-memory",
            used_memory: used,
            memory_usage_percent,
            cpu_core_count: cpu_core_count(),
            // Windows has no POSIX loadavg; Electron reports os.loadavg()[0]
            // which is 0 on Windows too.
            load_average1m: 0.0,
        },
        process_memory_metric: "working-set",
        total_cpu: 0.0,
        total_memory: 0,
        collected_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::poc_memory_snapshot;

    #[test]
    #[cfg(windows)]
    fn reports_real_host_memory() {
        let snapshot = poc_memory_snapshot().expect("snapshot resolves");
        assert!(
            snapshot.host.total_memory > 0,
            "total memory must be non-zero on Windows"
        );
        assert!(snapshot.host.available_memory <= snapshot.host.total_memory);
        assert_eq!(
            snapshot.host.used_memory,
            snapshot.host.total_memory - snapshot.host.available_memory
        );
        assert!(snapshot.host.cpu_core_count >= 1);
        assert_eq!(snapshot.process_memory_metric, "working-set");
    }
}
