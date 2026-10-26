import type {
  OptimizationCandidate,
  OptimizationRunResult,
} from "@/lib/optimization-contract";

/** Render only verified source metrics; failed and unproven candidates keep unavailable values. */
export function OptimizationEvidence({
  result,
}: {
  result: OptimizationRunResult;
}) {
  return (
    <section
      className="optimization-section"
      aria-label="Optimization evidence"
    >
      <h3>Candidate evidence</h3>
      <p>
        Process: {result.status} · Exit: {result.exitCode ?? "n/a"} ·{" "}
        {result.candidates.length} recorded candidates · Budget {result.budget}
      </p>
      <p className="optimization-muted">
        Results are from the original optimizer. A completed search does not
        establish out-of-sample performance or full validation.
      </p>
      <div
        className="optimization-table-scroll"
        tabIndex={0}
        aria-label="Candidate results"
      >
        <table>
          <caption>
            Actual candidate records; unavailable statistics appear as n/a.
          </caption>
          <thead>
            <tr>
              <th scope="col">Candidate / parameters</th>
              <th scope="col">State</th>
              <th scope="col">Net profit</th>
              <th scope="col">Profit factor</th>
              <th scope="col">Native equity DD %</th>
              <th scope="col">Full replay equity DD %</th>
              <th scope="col">Original fitness</th>
            </tr>
          </thead>
          <tbody>
            {result.candidates.map((candidate) => (
              <CandidateRow candidate={candidate} key={candidate.id} />
            ))}
          </tbody>
        </table>
      </div>
      {!result.candidates.length ? (
        <p>
          No candidate result was produced. Review the native diagnostics below.
        </p>
      ) : null}
      {result.errors.length ? (
        <ul role="alert" className="optimization-error">
          {result.errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>Frozen provenance and optimizer output</summary>
        <dl className="optimization-provenance">
          <dt>Run</dt>
          <dd>{result.runId}</dd>
          <dt>Build revision</dt>
          <dd>{result.buildRevision}</dd>
          <dt>Approved artifact SHA-256</dt>
          <dd>{result.approvedArtifactSha256}</dd>
          <dt>Dataset SHA-256</dt>
          <dd>{result.datasetSha256}</dd>
          <dt>Profile SHA-256</dt>
          <dd>{result.symbolSpecSha256}</dd>
          <dt>Config SHA-256</dt>
          <dd>{result.configSha256}</dd>
          <dt>Search</dt>
          <dd>
            {result.method} · seed {result.seed}
          </dd>
          <dt>Saved artifacts</dt>
          <dd>{result.runFolder}</dd>
        </dl>
        <pre>{result.output || "No process output captured."}</pre>
      </details>
    </section>
  );
}

/** Preserve original candidate status and distinguish source PF from optimizer scoring conventions. */
function CandidateRow({ candidate }: { candidate: OptimizationCandidate }) {
  const metrics = candidate.metrics;
  const currency = metrics?.currency ? ` ${metrics.currency}` : "";
  return (
    <tr>
      <th scope="row">
        {candidate.id}
        <details>
          <summary>Parameters and source</summary>
          <dl className="optimization-provenance">
            {Object.entries(candidate.parameters).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p>{candidate.reportJsonPath ?? "No verified report"}</p>
          <p>{candidate.reportSha256}</p>
          {metrics?.nativeDrawdownMethod ? (
            <p>Native drawdown method: {metrics.nativeDrawdownMethod}</p>
          ) : null}
          {metrics?.optimizerProfitFactor === 999 ? (
            <p>
              Original optimizer scoring PF: 999 (unbounded-profit convention).
              Source PF remains {metric(metrics.profitFactor)}.
            </p>
          ) : null}
        </details>
      </th>
      <td>
        {candidate.status}
        {candidate.error ? (
          <p className="optimization-error">{candidate.error}</p>
        ) : null}
      </td>
      <td>
        {metrics?.netProfit == null
          ? "n/a"
          : `${metric(metrics.netProfit)}${currency}`}
      </td>
      <td>{metric(metrics?.profitFactor)}</td>
      <td>{metric(metrics?.nativeDrawdownPercent)}</td>
      <td>{metric(metrics?.fullReplayDrawdownPercent)}</td>
      <td>{metric(metrics?.fitnessScore)}</td>
    </tr>
  );
}

/** Undefined and non-finite source statistics are unavailable, never silently displayed as zero. */
function metric(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "n/a"
    : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
