import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReportsBridge, SelectedReport } from "@/lib/reports-contract";
import type {
  ValidationBridge,
  ValidationRunResult,
} from "@/lib/validation-contract";
import { validationFields } from "./validation-form";
import { useValidation } from "./useValidation";
import { FullValidationPanel } from "./FullValidationPanel";
import { fullValidation } from "@/lib/full-validation";
import { execution } from "@/lib/execution";
import "./validation.css";

/** Inject native services and selected identity; retained stages refresh when active becomes true. */
export interface ValidationStageProps {
  bridge: ValidationBridge;
  reportsBridge: ReportsBridge;
  projectRoot: string | null;
  active?: boolean;
  onBusyChange?(busy: boolean): void;
}

/** Show report-only validation settings, exact source provenance and honest engine evidence. */
export function ValidationStage({
  bridge,
  reportsBridge,
  projectRoot,
  active = true,
  onBusyChange,
}: ValidationStageProps) {
  const controller = useValidation(bridge, reportsBridge, projectRoot, active);
  const { source, result, lastGood, phase, error } = controller;
  const busy = phase !== "idle";
  const [fullBusy, setFullBusy] = useState(false);
  const running = phase === "running" || phase === "cancelling";
  const native = bridge.native && reportsBridge.native;
  useEffect(() => {
    onBusyChange?.(busy || fullBusy);
    return () => onBusyChange?.(false);
  }, [busy, fullBusy, onBusyChange]);

  /** Prevent browser form navigation; the controller validates settings before native work. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void controller.run();
  }

  return (
    <section
      className="validation-stage"
      aria-label="Validate stage"
      aria-busy={busy}
    >
      <header className="validation-stage__header">
        <h2>Validate</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || fullBusy || !projectRoot}
          onClick={() => void controller.refresh()}
        >
          Refresh saved evidence
        </Button>
      </header>
      <p className="validation-stage__muted">
        Validate the saved trade ledger with the preserved Python engine. Choose
        report-only checks or rerun engine scenarios from a frozen baseline
        below.
      </p>
      {!native ? (
        <p className="validation-stage__muted">
          Python validation requires the desktop app. Browser preview contains
          no validation evidence.
        </p>
      ) : null}
      {phase === "loading" ? (
        <p role="status">Reading frozen source and saved validation…</p>
      ) : null}
      {error ? (
        <p role="alert" className="validation-stage__error">
          {error}
        </p>
      ) : null}
      {!source && phase !== "loading" && !error ? (
        <p className="validation-stage__muted">
          Complete a successful backtest for this project before validating its
          saved report.
        </p>
      ) : null}
      {source ? (
        <>
          <ValidationSource source={source} />
          <form
            onSubmit={submit}
            noValidate
            className="validation-stage__section"
            aria-labelledby="validation-settings-heading"
          >
            <h3 id="validation-settings-heading">Report-only checks</h3>
            <div className="validation-stage__fields">
              {validationFields.map((field) => {
                const invalid = controller.invalidFields.includes(field.name);
                return (
                  <div className="validation-stage__field" key={field.name}>
                    <Label htmlFor={`validation-${field.name}`}>
                      {field.label}
                    </Label>
                    <Input
                      id={`validation-${field.name}`}
                      type="number"
                      value={controller.form[field.name]}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      disabled={busy || fullBusy || !native}
                      aria-invalid={invalid}
                      aria-describedby={
                        invalid ? `validation-${field.name}-error` : undefined
                      }
                      onChange={(event) =>
                        controller.setField(field.name, event.target.value)
                      }
                    />
                    {invalid ? (
                      <p
                        id={`validation-${field.name}-error`}
                        className="validation-stage__error"
                      >
                        Enter {field.min}–{field.max}
                        {field.step === 1 ? " as a whole number" : ""}.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <p className="validation-stage__muted">
              Monte Carlo uses the original starting capital. Retained
              perturbation assumptions: missed trades 5–20%, slippage 2 pips,
              and PnL noise 10%. Settings do not alter the saved backtest.
            </p>
            <div className="validation-stage__actions">
              <Button
                size="sm"
                type="submit"
                disabled={
                  busy ||
                  fullBusy ||
                  !native ||
                  controller.invalidFields.length > 0
                }
              >
                Run report-only validation
              </Button>
              {running ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={phase === "cancelling"}
                  onClick={() => void controller.cancel()}
                >
                  Cancel validation
                </Button>
              ) : null}
            </div>
            {running ? (
              <p role="status">
                {phase === "cancelling"
                  ? "Cancellation requested. Waiting for Python to stop…"
                  : "Python is validating this frozen report. Engine backtests are not being rerun."}
              </p>
            ) : null}
          </form>
          {result ? <ValidationEvidence result={result} /> : null}
          {lastGood && lastGood.validationRunId !== result?.validationRunId ? (
            <section
              className="validation-stage__section"
              aria-labelledby="validation-preserved-heading"
            >
              <h3 id="validation-preserved-heading">
                Previous completed evidence preserved
              </h3>
              <p className="validation-stage__muted">
                Validation {lastGood.validationRunId} · Engine verdict:{" "}
                {lastGood.verdict}
              </p>
              <p className="validation-stage__path">
                {lastGood.finalReportPath}
              </p>
            </section>
          ) : null}
        </>
      ) : null}
      <FullValidationPanel
        bridge={fullValidation}
        executions={execution}
        source={source}
        reportBusy={busy}
        onBusyChange={setFullBusy}
      />
    </section>
  );
}

/** Keep the reviewed run, build and immutable source hash visible before starting Python. */
function ValidationSource({ source }: { source: SelectedReport }) {
  return (
    <section
      className="validation-stage__section"
      aria-labelledby="validation-source-heading"
    >
      <h3 id="validation-source-heading">
        {source.strategy} · {source.symbol} · {source.timeframe}
      </h3>
      <dl className="validation-stage__evidence">
        <dt>Saved run</dt>
        <dd>{source.runId}</dd>
        <dt>Build revision</dt>
        <dd>{source.buildRevision}</dd>
        <dt>Dataset</dt>
        <dd>{source.datasetId}</dd>
        <dt>Source SHA-256</dt>
        <dd className="validation-stage__hash">{source.reportSha256}</dd>
      </dl>
    </section>
  );
}

/** Present lifecycle completion independently from the actual verdict and missing engine evidence. */
function ValidationEvidence({ result }: { result: ValidationRunResult }) {
  return (
    <section
      className="validation-stage__section"
      aria-labelledby="validation-evidence-heading"
    >
      <h3 id="validation-evidence-heading">Validation evidence</h3>
      <dl className="validation-stage__evidence">
        <dt>Process</dt>
        <dd>{result.status}</dd>
        <dt>Engine verdict</dt>
        <dd>{result.verdict}</dd>
        <dt>Mode</dt>
        <dd>Saved report only</dd>
        <dt>Validation run</dt>
        <dd>{result.validationRunId}</dd>
        <dt>Completed UTC</dt>
        <dd>{result.completedAt || "n/a"}</dd>
        <dt>{result.success ? "Saved report" : "Expected report path"}</dt>
        <dd>{result.finalReportPath}</dd>
        <dt>
          {result.success ? "Saved verdict JSON" : "Expected verdict path"}
        </dt>
        <dd>{result.finalVerdictPath}</dd>
      </dl>
      <p className="validation-stage__muted">
        Process completion does not establish full validation. Engine-level
        stress and walk-forward backtests remain unproven in this mode.
      </p>
      {result.missingEvidence.length ? (
        <div>
          <h4>Missing evidence</h4>
          <ul>
            {result.missingEvidence.map((item) => (
              <li key={item}>{evidenceLabel(item)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.errors.length ? (
        <div className="validation-stage__error" role="alert">
          <h4>Process diagnostics</h4>
          <ul>
            {result.errors.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.output ? (
        <details>
          <summary>Python output</summary>
          <pre className="validation-stage__output">{result.output}</pre>
        </details>
      ) : null}
    </section>
  );
}

/** Translate known retained evidence keys while preserving unknown source labels verbatim. */
function evidenceLabel(key: string): string {
  const labels: Record<string, string> = {
    engine_level_latency_stress: "Engine-level latency stress",
    walk_forward_embargo_backtests: "Walk-forward embargo backtests",
    trade_ledger_monte_carlo: "Trade-ledger Monte Carlo",
    backtest_engine_execution: "Engine scenario execution",
    backtest_reports: "Scenario backtest reports",
  };
  return labels[key] || key;
}
