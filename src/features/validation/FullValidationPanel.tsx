import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ExecutionBridge } from "@/lib/execution-contract";
import type { SelectedReport } from "@/lib/reports-contract";
import type { FullValidationBridge } from "@/lib/full-validation";
import { useFullValidation } from "./useFullValidation";
import "./validation.css";

const fields = [
  {
    name: "spreadMultipliers",
    label: "Spread multipliers",
    hint: "1–8 values, 0.1–10",
  },
  {
    name: "commissionMultipliers",
    label: "Commission rate multipliers",
    hint: "1–8 values, 0.1–10",
  },
  {
    name: "latencyTicks",
    label: "Latency ticks",
    hint: "1–8 whole values, 1–1000",
  },
  { name: "trainDays", label: "Train days", hint: "1–3650" },
  { name: "validationDays", label: "Validation days", hint: "1–3650" },
  { name: "testDays", label: "Test days", hint: "1–3650" },
  { name: "embargoDays", label: "Embargo days", hint: "0–365" },
  {
    name: "monteCarloRuns",
    label: "Scenario Monte Carlo runs",
    hint: "1–10000",
  },
  { name: "seed", label: "Scenario random seed", hint: "0–2147483647" },
] as const;

/** Full engine controls share the reviewed saved report and existing validation visual system. */
export interface FullValidationPanelProps {
  bridge: FullValidationBridge;
  executions: ExecutionBridge;
  source: SelectedReport | null;
  reportBusy: boolean;
  onBusyChange?(busy: boolean): void;
}

/** Expose real stress reruns without conflating process completion with a positive trading verdict. */
export function FullValidationPanel({
  bridge,
  executions,
  source,
  reportBusy,
  onBusyChange,
}: FullValidationPanelProps) {
  const controller = useFullValidation(bridge, executions, source);
  const busy = controller.phase !== "idle";
  const running =
    controller.phase === "running" || controller.phase === "cancelling";
  const unavailable = !bridge.native || !executions.native;
  const { result } = controller;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  return (
    <section
      className="validation-stage__section"
      aria-labelledby="full-validation-heading"
      aria-busy={busy}
    >
      <h3 id="full-validation-heading">Engine scenarios</h3>
      <p className="validation-stage__muted">
        Rerun cost and latency scenarios from the frozen baseline. Walk-forward
        runs test fixed parameters on held-out date windows; it does not train
        or optimize them. Commission multipliers change the rate, while profile
        minimums and fees still apply.
      </p>
      <p className="validation-stage__muted">
        Requires a successful tick replay with an explicit start and end date, a
        frozen replay receipt and its available authority inputs. The native
        planner allows at most 64 scenarios and checks the saved inputs before
        running.
      </p>
      {!controller.baseline?.replayReceiptSha256 ? (
        <p className="validation-stage__muted">
          {unavailable
            ? "Engine scenarios require the desktop app."
            : "Select a verified saved baseline with a replay receipt before running scenarios."}
        </p>
      ) : null}
      {controller.error ? (
        <p role="alert" className="validation-stage__error">
          {controller.error}
        </p>
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void controller.run();
        }}
      >
        <div className="validation-stage__fields">
          {fields.map((field) => (
            <div key={field.name} className="validation-stage__field">
              <Label htmlFor={`full-${field.name}`}>{field.label}</Label>
              <Input
                id={`full-${field.name}`}
                value={controller.form[field.name]}
                disabled={busy || reportBusy || unavailable}
                aria-describedby={`full-${field.name}-hint`}
                onChange={(event) =>
                  controller.setForm((current) => ({
                    ...current,
                    [field.name]: event.target.value,
                  }))
                }
              />
              <span
                id={`full-${field.name}-hint`}
                className="validation-stage__muted"
              >
                {field.hint}
              </span>
            </div>
          ))}
        </div>
        <div className="validation-stage__actions full-validation-actions">
          <Button
            size="sm"
            type="submit"
            disabled={
              busy ||
              reportBusy ||
              unavailable ||
              !controller.baseline?.replayReceiptSha256
            }
          >
            Run engine scenarios
          </Button>
          {running ? (
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={controller.phase === "cancelling"}
              onClick={() => void controller.cancel()}
            >
              Cancel engine scenarios
            </Button>
          ) : null}
        </div>
      </form>
      {busy ? (
        <p role="status">
          {running
            ? "Waiting for the owned engine workflow to finish. Cancellation remains pending until its processes stop."
            : "Reading saved baseline evidence…"}
        </p>
      ) : null}
      {result ? (
        <div className="validation-stage__section">
          <h4>Engine scenario evidence</h4>
          <dl className="validation-stage__evidence">
            <dt>Process</dt>
            <dd>{result.status}</dd>
            <dt>Engine verdict</dt>
            <dd>{result.verdict}</dd>
            <dt>Planned scenarios</dt>
            <dd>{result.plannedScenarios}</dd>
            <dt>Walk-forward windows</dt>
            <dd>
              {result.generatedWalkForwardWindows} generated ·{" "}
              {result.excludedWalkForwardWindows} excluded
            </dd>
            <dt>Validation run</dt>
            <dd>{result.validationRunId}</dd>
            <dt>Saved evidence</dt>
            <dd>{result.validationDirectory}</dd>
            <dt>Replay receipt SHA-256</dt>
            <dd className="validation-stage__hash">
              {result.replayReceiptSha256}
            </dd>
          </dl>
          <p className="validation-stage__muted">
            These are the original workflow results for this saved baseline. A
            completed process alone does not establish trading validity or
            native platform parity.
          </p>
          {result.errors.length ? (
            <ul role="alert" className="validation-stage__error">
              {result.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          ) : null}
          {result.evidence?.missingEvidence.length ? (
            <p>
              Missing evidence: {result.evidence.missingEvidence.join(", ")}
            </p>
          ) : null}
          {result.output ? (
            <details>
              <summary>Engine workflow output</summary>
              <pre className="validation-stage__output">{result.output}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
