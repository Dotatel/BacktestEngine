import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OptimizationBridge } from "@/lib/optimization-contract";
import type { ExecutionBridge } from "@/lib/execution-contract";
import type { WorkspaceBuild } from "@/lib/workspace-contract";
import type { WorkspaceParametersController } from "@/features/workspace/hooks/useWorkspaceParameters";
import {
  defaultOptimizationForm,
  optimizationRequest,
  type DimensionDraft,
  type OptimizationForm,
} from "./optimization-form";
import { useOptimization } from "./useOptimization";
import { OptimizationEvidence } from "./OptimizationEvidence";
import "./optimization.css";

/** Inject actual native services and the current build/parameter selection without exposing command paths. */
export interface OptimizeStageProps {
  bridge: OptimizationBridge;
  executionBridge: ExecutionBridge;
  projectRoot: string | null;
  build: WorkspaceBuild | null;
  stale: boolean;
  parameters: WorkspaceParametersController;
  active?: boolean;
  onBusyChange?(busy: boolean): void;
}

/** Configure a bounded search performed by the preserved C# optimizer and inspect its actual evidence. */
export function OptimizeStage({
  bridge,
  executionBridge,
  projectRoot,
  build,
  stale,
  parameters,
  active = true,
  onBusyChange,
}: OptimizeStageProps) {
  const strategy = parameters.activeStrategy;
  const identity = `${build?.artifactPath ?? ""}\n${strategy?.strategy ?? ""}\n${stale}`;
  const controller = useOptimization(
    bridge,
    executionBridge,
    projectRoot,
    identity,
    active,
  );
  const [form, setForm] = useState<OptimizationForm>({
    ...defaultOptimizationForm,
  });
  const [dimensions, setDimensions] = useState<DimensionDraft[]>([]);
  const [draftError, setDraftError] = useState("");
  const busy = controller.phase !== "idle";
  const running =
    controller.phase === "running" || controller.phase === "cancelling";
  const native = bridge.native && executionBridge.native;
  const dataset = controller.datasets.find(
    (item) => item.id === form.datasetId,
  );
  const ready =
    native && Boolean(projectRoot && build?.success && strategy) && !stale;

  useEffect(() => {
    setDimensions([]);
    setDraftError("");
  }, [strategy?.strategy, projectRoot]);
  useEffect(() => {
    onBusyChange?.(running);
    return () => onBusyChange?.(false);
  }, [onBusyChange, running]);

  /** Preserve incomplete user drafts until explicit submit validation. */
  function setField(name: keyof OptimizationForm, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
    setDraftError("");
  }

  /** Freeze the current base preset and search arrays before one guarded native launch. */
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDraftError("");
    if (!ready || !strategy || !dataset || busy) return;
    try {
      const request = optimizationRequest(
        form,
        dimensions,
        strategy,
        parameters.values,
        dataset.kind,
      );
      void controller.run(request);
    } catch (failure) {
      setDraftError(
        failure instanceof Error ? failure.message : String(failure),
      );
    }
  }

  return (
    <section
      className="optimization-stage"
      aria-label="Optimize stage"
      aria-busy={busy}
    >
      <header className="optimization-header">
        <h2>Optimize</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !native || !projectRoot}
          onClick={() => void controller.refresh()}
        >
          Refresh imported inputs
        </Button>
      </header>
      <p className="optimization-muted">
        Search explicit parameter values with the preserved C# optimizer. Every
        attempt uses a fresh source snapshot and the same native input checks as
        Backtest.
      </p>
      {!native ? (
        <p>
          Optimization requires the desktop app. Browser preview produces no
          candidates.
        </p>
      ) : null}
      {!build?.success || stale ? (
        <p>
          Build the current saved project successfully before starting a search.
        </p>
      ) : null}
      {controller.phase === "loading" ? (
        <p role="status">Loading imported inputs and native saved evidence…</p>
      ) : null}
      {draftError || controller.error ? (
        <p role="alert" className="optimization-error">
          {draftError || controller.error}
        </p>
      ) : null}
      <form onSubmit={submit} noValidate>
        <fieldset disabled={busy || !ready} className="optimization-section">
          <legend>Frozen run inputs</legend>
          <p>
            Strategy:{" "}
            <strong>
              {strategy?.strategy ?? "Build and select a strategy"}
            </strong>
            . Base values use the current strategy parameters; search dimensions
            override only their named values.
          </p>
          <div className="optimization-fields">
            <Choice
              name="datasetId"
              label="Imported history"
              value={form.datasetId}
              onChange={setField}
              options={controller.datasets.map((item) => ({
                value: item.id,
                label: `${fileName(item.originalPath)} · ${item.kind}`,
              }))}
            />
            <Choice
              name="symbolSpecId"
              label="Symbol profile"
              value={form.symbolSpecId}
              onChange={setField}
              options={controller.symbolSpecs.map((item) => ({
                value: item.id,
                label: fileName(item.originalPath),
              }))}
            />
            <DraftField
              name="timeframe"
              label="Chart timeframe"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="startingBalance"
              label="Starting balance (account currency)"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="commission"
              label="Commission (USD / million; -1 = profile)"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="spread"
              label="Fixed spread (pips; blank = recorded quotes)"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="slippage"
              label="Slippage (pips; optimizer supports zero only)"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="startUtc"
              label="Start UTC (inclusive, optional)"
              form={form}
              onChange={setField}
              placeholder="2026-01-01T00:00:00Z"
            />
            <DraftField
              name="endUtc"
              label="End UTC (exclusive, optional)"
              form={form}
              onChange={setField}
              placeholder="2026-02-01T00:00:00Z"
            />
            <DraftField
              name="maxRows"
              label="Replay row limit (0 = all history)"
              form={form}
              onChange={setField}
            />
            {dataset?.kind === "bars" ? (
              <>
                <DraftField
                  name="barTimeframe"
                  label="Source bar timeframe"
                  form={form}
                  onChange={setField}
                />
                <Choice
                  name="barPriceMode"
                  label="Bar price path"
                  value={form.barPriceMode}
                  onChange={setField}
                  options={[
                    { value: "ohlc", label: "OHLC path" },
                    { value: "open", label: "Bar open only" },
                    { value: "native-m1", label: "One-minute source" },
                  ]}
                />
              </>
            ) : null}
          </div>
          {!controller.datasets.length || !controller.symbolSpecs.length ? (
            <p className="optimization-muted">
              Import historical CSV and a validated symbol profile in Backtest,
              then refresh these inputs. No example data is substituted.
            </p>
          ) : null}
        </fieldset>
        <fieldset disabled={busy || !ready} className="optimization-section">
          <legend>Search budget</legend>
          <div className="optimization-fields">
            <Choice
              name="method"
              label="Search method"
              value={form.method}
              onChange={setField}
              options={[
                { value: "grid", label: "Grid" },
                { value: "random", label: "Seeded random" },
              ]}
            />
            <DraftField
              name="seed"
              label="Random seed"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="maxRuns"
              label="Maximum runs (1–100)"
              form={form}
              onChange={setField}
            />
            <DraftField
              name="maxWorkers"
              label="Parallel workers (1–2)"
              form={form}
              onChange={setField}
            />
          </div>
          <p className="optimization-muted">
            Each dimension accepts one to 32 exact JSON values, such as [10,20]
            or [true,false]. The original engine generates and scores
            candidates. Duplicate combinations may reduce the actual count.
          </p>
          {dimensions.map((dimension, index) => (
            <div className="optimization-dimension" key={index}>
              <Choice
                name={`dimension-${index}`}
                label={`Parameter ${index + 1}`}
                value={dimension.name}
                options={(strategy?.parameters ?? []).map((parameter) => ({
                  value: parameter.name,
                  label: parameter.displayName || parameter.name,
                }))}
                onChange={(_, name) =>
                  setDimensions((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name } : item,
                    ),
                  )
                }
              />
              <div>
                <Label htmlFor={`optimization-values-${index}`}>
                  Exact values (JSON array)
                </Label>
                <Input
                  id={`optimization-values-${index}`}
                  value={dimension.text}
                  onChange={(event) =>
                    setDimensions((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, text: event.target.value }
                          : item,
                      ),
                    )
                  }
                  placeholder="[10,20]"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove parameter ${index + 1}`}
                onClick={() =>
                  setDimensions((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={dimensions.length >= 8 || !strategy?.parameters.length}
            onClick={() =>
              setDimensions((current) => [...current, { name: "", text: "" }])
            }
          >
            Add search parameter
          </Button>
        </fieldset>
        <div className="optimization-actions">
          <Button
            size="sm"
            type="submit"
            disabled={busy || !ready || !dataset || !dimensions.length}
          >
            Run optimization
          </Button>
          {running ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={controller.phase === "cancelling"}
              onClick={() => void controller.cancel()}
            >
              Cancel optimization
            </Button>
          ) : null}
          {running ? (
            <p role="status">
              {controller.phase === "cancelling"
                ? "Stopping optimizer and child processes…"
                : "Original optimizer is running. Candidate results appear when the process stops."}
            </p>
          ) : null}
        </div>
      </form>
      {controller.result ? (
        <OptimizationEvidence result={controller.result} />
      ) : null}
      {controller.lastGood &&
      controller.lastGood.runId !== controller.result?.runId ? (
        <section className="optimization-section">
          <h3>Previous successful search preserved</h3>
          <OptimizationEvidence result={controller.lastGood} />
        </section>
      ) : null}
    </section>
  );
}

/** Standard compact controls share the public shadcn sizing API used by Build and Backtest. */
function Choice({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(name: string, value: string): void;
}) {
  return (
    <div>
      <Label htmlFor={`optimization-${name}`}>{label}</Label>
      <Select
        value={value}
        onValueChange={(selected) => onChange(name, selected)}
      >
        <SelectTrigger id={`optimization-${name}`} size="sm">
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem value={option.value} key={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Draft text inputs retain invalid numeric strings for clear submit-time diagnostics. */
function DraftField({
  name,
  label,
  form,
  onChange,
  placeholder,
}: {
  name: keyof OptimizationForm;
  label: string;
  form: OptimizationForm;
  onChange(name: keyof OptimizationForm, value: string): void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label htmlFor={`optimization-${name}`}>{label}</Label>
      <Input
        id={`optimization-${name}`}
        value={form[name]}
        placeholder={placeholder}
        onChange={(event) => onChange(name, event.target.value)}
      />
    </div>
  );
}

/** Show original user file names while preserving opaque catalog IDs as native request identities. */
function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) || path;
}
