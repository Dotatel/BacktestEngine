import { Button } from "@/components/ui/button";
import type { SavedRunPage, SavedRunSummary } from "@/lib/saved-runs-contract";

/** Presentation-only metadata catalogue; actions delegate verification and persistence to the injected hook. */
export interface SavedRunHistoryProps {
  page: SavedRunPage | null;
  phase: "idle" | "restoring" | "listing" | "opening";
  error: string;
  restoreError: string;
  disabled: boolean;
  selectedRunId?: string;
  onRefresh: () => void;
  onNext: () => void;
  onRestore: () => void;
  onOpen: (row: SavedRunSummary) => void;
}

/** Browse recorded identities without treating catalogue metadata as verified financial evidence. */
export function SavedRunHistory({
  page,
  phase,
  error,
  restoreError,
  disabled,
  selectedRunId,
  onRefresh,
  onNext,
  onRestore,
  onOpen,
}: SavedRunHistoryProps) {
  const pending = phase !== "idle";
  return (
    <section
      className="reports-stage__section"
      aria-labelledby="saved-history-heading"
      aria-busy={pending}
    >
      <div className="reports-stage__header">
        <h3 id="saved-history-heading">Saved runs</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || pending}
          onClick={onRefresh}
        >
          Refresh history
        </Button>
      </div>
      <p className="reports-stage__muted">
        Runs recorded for this project. Opening verifies their saved inputs and
        report; it does not run the strategy again.
      </p>
      {pending ? <p role="status">{historyStatus(phase)}</p> : null}
      {error ? (
        <p role="alert" className="reports-stage__error">
          {error}
        </p>
      ) : null}
      {restoreError ? (
        <div className="reports-stage__history-error">
          <p role="alert" className="reports-stage__error">
            {restoreError}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={onRestore}
          >
            Retry saved selection
          </Button>
        </div>
      ) : null}
      {page?.rows.length === 0 ? (
        <p className="reports-stage__muted">
          No recorded runs in this page. Complete a successful backtest to save
          its report.
        </p>
      ) : null}
      {page?.rows.length ? (
        <ul className="reports-stage__history-list">
          {page.rows.map((row) => (
            <li
              key={`${row.runId}:${row.completionSha256}`}
              className="reports-stage__history-row"
            >
              <div className="reports-stage__history-identity">
                <strong>
                  {row.strategy} · {row.symbol} · {row.timeframe}
                </strong>
                <span className="reports-stage__muted">
                  Completed UTC{" "}
                  <time dateTime={row.completedAt}>{row.completedAt}</time>
                </span>
                <span className="reports-stage__hash">{row.runId}</span>
              </div>
              <div className="reports-stage__actions">
                {selectedRunId === row.runId ? (
                  <span className="reports-stage__muted">Selected</span>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || pending}
                  aria-label={`Verify and open run ${row.runId}`}
                  onClick={() => onOpen(row)}
                >
                  Verify and open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {page?.nextCursor ? (
        <div className="reports-stage__actions">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || pending}
            onClick={onNext}
          >
            Next page
          </Button>
          <span className="reports-stage__muted">
            Up to 25 runs per page. Refresh starts again.
          </span>
        </div>
      ) : null}
      {page &&
      (page.issues.length > 0 ||
        page.unassignedEntries > 0 ||
        page.additionalIssueCount > 0) ? (
        <details className="reports-stage__history-issues">
          <summary>Some stored entries could not be listed</summary>
          <p className="reports-stage__muted">
            These entries remain on disk. Unassigned entries are not attributed
            to this project: {page.unassignedEntries}.
          </p>
          <ul>
            {page.issues.map((issue, index) => (
              <li key={index}>
                {issue.runId ? `${issue.runId}: ` : ""}
                {issue.message}
              </li>
            ))}
          </ul>
          {page.additionalIssueCount > 0 ? (
            <p>
              {page.additionalIssueCount} additional issues were omitted from
              this page.
            </p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

/** Name the specific pending operation without estimated progress or a financial-success claim. */
function historyStatus(phase: SavedRunHistoryProps["phase"]) {
  if (phase === "restoring") return "Restoring this project's saved selection…";
  if (phase === "opening")
    return "Verifying the selected run and its saved inputs…";
  return "Reading recorded runs…";
}
