import { Button } from "@/components/ui/button";
import type {
  ReportMetric,
  ReportsBridge,
  SelectedReport,
} from "@/lib/reports-contract";
import { useReports } from "./useReports";
import type {
  SavedRunSelection,
  SavedRunsBridge,
} from "@/lib/saved-runs-contract";
import { useSavedRuns } from "./useSavedRuns";
import { SavedRunHistory } from "./SavedRunHistory";
import "./reports.css";

/** The workspace injects native operations and the selected project; no renderer filesystem access. */
export interface ReportsStageProps {
  bridge: ReportsBridge;
  projectRoot: string | null;
  active?: boolean;
  historyBridge?: SavedRunsBridge;
  executionBusy?: boolean;
  onSavedRunSelected?: (selection: SavedRunSelection) => void;
}

/** Present saved source evidence, direct reported statistics and owner-selected exports. */
export function ReportsStage({
  bridge,
  projectRoot,
  active = true,
  historyBridge,
  executionBusy = false,
  onSavedRunSelected,
}: ReportsStageProps) {
  const history = useSavedRuns({
    bridge: historyBridge,
    projectRoot,
    active,
    blocked: executionBusy,
    onSelected: onSavedRunSelected,
  });
  const controller = useReports(
    bridge,
    projectRoot,
    active && history.ready,
    history.revision,
  );
  const { report, phase, error, message } = controller;
  const pending = phase !== "idle" || history.phase !== "idle" || executionBusy;
  return (
    <section
      className="reports-stage"
      aria-label="Reports stage"
      aria-busy={pending}
    >
      <header className="reports-stage__header">
        <h2>Reports</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !projectRoot}
          onClick={() => void controller.refresh()}
        >
          Refresh saved run
        </Button>
      </header>
      {!bridge.native ? (
        <p className="reports-stage__muted">
          Browser preview has no saved engine evidence. Run and export reports
          in the desktop app.
        </p>
      ) : null}
      {historyBridge?.native && projectRoot ? (
        <SavedRunHistory
          page={history.page}
          phase={history.phase}
          error={history.error}
          restoreError={history.restoreError}
          disabled={phase !== "idle" || executionBusy}
          selectedRunId={report?.runId}
          onRefresh={() => void history.browse()}
          onNext={() => void history.browse(history.page?.nextCursor ?? null)}
          onRestore={() => void history.restore()}
          onOpen={(row) => void history.open(row)}
        />
      ) : null}
      {phase === "loading" ? (
        <p role="status">Reading saved run and verifying its source…</p>
      ) : null}
      {error ? (
        <p className="reports-stage__error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="reports-stage__receipt">
          {message}
        </p>
      ) : null}
      {!report && phase !== "loading" && !error ? (
        <p className="reports-stage__muted">
          Complete a successful backtest for this project to create a report.
          Reports use the selected saved run and never rerun it.
        </p>
      ) : null}
      {report ? (
        <>
          <ReportEvidence report={report} />
          <section
            aria-labelledby="report-export-heading"
            className="reports-stage__section"
          >
            <h3 id="report-export-heading">Export saved source</h3>
            <div className="reports-stage__actions">
              <Button
                size="sm"
                disabled={pending || !bridge.native}
                onClick={() => void controller.exportSaved("html")}
              >
                Export HTML report
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !bridge.native}
                onClick={() => void controller.exportSaved("json")}
              >
                Export original JSON
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !bridge.native}
                onClick={() => void controller.exportSaved("tradesCsv")}
              >
                Export closed trades CSV
              </Button>
            </div>
            <p className="reports-stage__muted">
              Choose a new file in the native save dialog. Existing files are
              never overwritten. HTML works offline; JSON preserves the complete
              original engine output.
            </p>
            {phase === "exporting" ? (
              <p role="status">Choose an export destination…</p>
            ) : null}
          </section>
          <ReportStatistics report={report} />
        </>
      ) : null}
    </section>
  );
}

/** Show the exact frozen run provenance so exported evidence can be traced to its source. */
function ReportEvidence({ report }: { report: SelectedReport }) {
  return (
    <section
      aria-labelledby="report-source-heading"
      className="reports-stage__section"
    >
      <h3 id="report-source-heading">
        {report.strategy} · {report.symbol} · {report.timeframe}
      </h3>
      <dl className="reports-stage__evidence">
        <dt>Saved run</dt>
        <dd>{report.runId}</dd>
        <dt>Completed UTC</dt>
        <dd>{report.completedAt}</dd>
        <dt>Build revision</dt>
        <dd>{report.buildRevision}</dd>
        <dt>Dataset</dt>
        <dd>{report.datasetId}</dd>
        <dt>Source JSON</dt>
        <dd>{report.reportJsonPath}</dd>
        <dt>Source SHA-256</dt>
        <dd className="reports-stage__hash">{report.reportSha256}</dd>
        <dt>Native drawdown method</dt>
        <dd>{report.nativeDrawdownMethod || "n/a"}</dd>
      </dl>
    </section>
  );
}

/** Keep different engine drawdown methods visibly distinct and missing values explicitly unavailable. */
function ReportStatistics({ report }: { report: SelectedReport }) {
  return (
    <section
      aria-labelledby="report-statistics-heading"
      className="reports-stage__section"
    >
      <h3 id="report-statistics-heading">Reported statistics</h3>
      <p className="reports-stage__muted">
        Values come directly from the saved engine JSON. Full replay and native
        price-extremes/deals drawdown use different methods. Missing values are
        n/a.
      </p>
      <table className="reports-stage__statistics">
        <thead>
          <tr>
            <th scope="col">Statistic</th>
            <th scope="col">Reported value</th>
          </tr>
        </thead>
        <tbody>
          {report.metrics.map((metric) => (
            <tr key={metric.label}>
              <th scope="row">{metric.label}</th>
              <td>{formatReportMetric(metric, report.accountCurrency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Format only finite source numbers; preserve actual currency labels without assuming dollars. */
export function formatReportMetric(
  metric: ReportMetric,
  currency: string | null,
): string {
  if (metric.value === null || !Number.isFinite(metric.value)) return "n/a";
  const value = metric.value.toLocaleString(undefined, {
    maximumSignificantDigits: 21,
  });
  if (metric.unit === "money")
    return `${value} ${currency || "(currency n/a)"}`;
  if (metric.unit === "%") return `${value}%`;
  return value;
}
