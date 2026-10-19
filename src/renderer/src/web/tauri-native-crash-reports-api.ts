import type {
  CrashReportBreadcrumbData,
  CrashReportCopyDiagnosticsArgs,
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult,
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../../shared/crash-reporting'
import type { CrashReportsApi } from '../../../preload/api/crash-report-api'
import { formatCrashReportText } from '../../../shared/crash-reporting'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'

type CrashReportLookup = { reportId?: string }

export function createTauriNativeCrashReportsApi(): CrashReportsApi | null {
  if (!isTauriNativeHost()) {
    return null
  }
  return {
    getLatestPending: () =>
      invokeNative<CrashReportRecord | null>('poc_crash_reports_get_latest_pending'),
    getLatestReport: () => invokeNative<CrashReportRecord | null>('poc_crash_reports_get_latest'),
    dismiss: (args) => invokeNative<CrashReportRecord | null>('poc_crash_reports_dismiss', args),
    recordRendererError: (args: ReactErrorBoundaryReportArgs) =>
      invokeNative<ReactErrorBoundaryReportResult>('poc_crash_reports_record_renderer_error', args),
    recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }): void => {
      void invokeNative('poc_crash_reports_record_breadcrumb', args).catch(() => {})
    },
    submit: (args: CrashReportSubmitArgs): Promise<CrashReportSubmitResult> =>
      invokeNative<CrashReportSubmitResult>('poc_crash_reports_submit', args),
    copyLatestDiagnostics: async (args?: CrashReportCopyDiagnosticsArgs) => {
      const lookup: CrashReportLookup | undefined = args?.reportId
        ? { reportId: args.reportId }
        : undefined
      const report = await invokeNative<CrashReportRecord | null>(
        'poc_crash_reports_get_requested',
        lookup
      )
      if (!report) {
        return { ok: false as const, error: 'No captured crash report is available.' }
      }
      try {
        await invokePlugin('clipboard-manager', 'write_text', {
          text: formatCrashReportText(report, args?.notes),
          label: null
        })
        return { ok: true as const }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },
    readHeapStatistics: () => null
  }
}
