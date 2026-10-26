import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, PanelRightClose, RotateCcw, Save } from "lucide-react";
import type { StrategyParameter } from "@/lib/workspace-contract";
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
import {
  groupParameters,
  parameterHint,
  parameterKind,
  parameterText,
  parseParameterText,
  validateParameterValue,
  type ParameterGroup,
} from "../lib/parameters";
import type { WorkspaceParametersController } from "../hooks/useWorkspaceParameters";
import type { WorkspaceBuildController } from "../hooks/useWorkspaceBuild";

/** Inputs for reflected strategy values, validation and durable named presets. */
export interface ParameterInspectorProps {
  parameters: WorkspaceParametersController;
  build: WorkspaceBuildController;
  onCollapse(): void;
}

/** Render the schema-backed parameter form without inferring values from editor text. */
export function ParameterInspector({
  parameters,
  build,
  onCollapse,
}: ParameterInspectorProps) {
  const groups = useMemo(
    () =>
      parameters.activeStrategy
        ? groupParameters(parameters.activeStrategy)
        : [],
    [parameters.activeStrategy],
  );

  return (
    <aside
      className="workspace-panel inspector"
      aria-label="Strategy parameters"
    >
      <div className="panel-head">
        <h2 className="panel-title">Parameters</h2>
        {parameters.activeStrategy && (
          <span className="panel-badge">
            {parameters.activeStrategy.parameters.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Collapse parameters"
          onClick={onCollapse}
        >
          <PanelRightClose aria-hidden="true" />
        </Button>
      </div>
      {parameters.activeStrategy ? (
        <div className="inspector-scroll">
          <div className="inspector-content">
            {parameters.strategies.length > 1 && (
              <div className="param-field">
                <Label htmlFor="active-strategy">Strategy</Label>
                <Select
                  value={parameters.activeStrategy.strategy}
                  onValueChange={parameters.selectStrategy}
                >
                  <SelectTrigger id="active-strategy" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {parameters.strategies.map((strategy) => (
                      <SelectItem
                        key={strategy.strategy}
                        value={strategy.strategy}
                      >
                        {strategy.strategy}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="param-hint">
                  {parameters.activeStrategy.strategyType}
                </p>
              </div>
            )}
            {groups.map((group) => (
              <ParameterGroupFields
                key={group.name}
                group={group}
                values={parameters.values}
                onChange={parameters.setValue}
              />
            ))}
            <div className="inspector-actions">
              <Button
                variant="outline"
                size="sm"
                onClick={parameters.resetDefaults}
              >
                <RotateCcw aria-hidden="true" />
                Reset defaults
              </Button>
            </div>
            <PresetSection parameters={parameters} />
            {parameters.message && (
              <p
                className="param-message"
                data-tone={parameters.messageTone}
                role={parameters.messageTone === "error" ? "alert" : "status"}
              >
                {parameters.message}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="panel-empty">
          <p>No reflected parameters yet.</p>
          <p>{schemaHint(build)}</p>
        </div>
      )}
    </aside>
  );
}

/** Choose the honest reason the reflected schema is unavailable. */
function schemaHint(build: WorkspaceBuildController): string {
  if (build.phase === "building") return "Compiling saved source...";
  if (build.result && !build.result.success)
    return "The last build failed. Fix compiler problems, then build again.";
  if (build.result)
    return "The build compiled no parameterized robot strategies.";
  return "Build the project to read the schema from compiled C#.";
}

/** Props for one reflected parameter group. */
interface ParameterGroupFieldsProps {
  group: ParameterGroup;
  values: Record<string, unknown>;
  onChange(name: string, value: unknown): void;
}

/** Render one schema group in compiler order. */
function ParameterGroupFields({
  group,
  values,
  onChange,
}: ParameterGroupFieldsProps) {
  return (
    <fieldset className="param-group">
      <legend>{group.name}</legend>
      {group.parameters.map((parameter) => (
        <ParameterField
          key={parameter.name}
          parameter={parameter}
          value={values[parameter.name]}
          onChange={(value) => onChange(parameter.name, value)}
        />
      ))}
    </fieldset>
  );
}

/** Props for one labelled, validated parameter control. */
interface ParameterFieldProps {
  parameter: StrategyParameter;
  value: unknown;
  onChange(value: unknown): void;
}

/** Render the control appropriate to the schema type and report its validation state. */
function ParameterField({ parameter, value, onChange }: ParameterFieldProps) {
  const id = `param-${parameter.name.replaceAll(".", "-")}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const error = validateParameterValue(parameter, value);
  const hint = parameterHint(parameter);
  return (
    <div className="param-field">
      <Label htmlFor={id}>{parameter.displayName || parameter.name}</Label>
      <ParameterControl
        id={id}
        parameter={parameter}
        value={value}
        errorId={error ? errorId : undefined}
        hintId={error ? undefined : hintId}
        onChange={onChange}
      />
      {error ? (
        <p id={errorId} className="param-error" aria-live="polite">
          {error}
        </p>
      ) : (
        <p id={hintId} className="param-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Props for the concrete input matching a parameter kind. */
interface ParameterControlProps {
  id: string;
  parameter: StrategyParameter;
  value: unknown;
  errorId: string | undefined;
  hintId: string | undefined;
  onChange(value: unknown): void;
}

/** Render a select for reflected choices and a text input for free values. */
function ParameterControl({
  id,
  parameter,
  value,
  errorId,
  hintId,
  onChange,
}: ParameterControlProps) {
  const kind = parameterKind(parameter);
  const describedBy = errorId ?? hintId;
  if (kind === "options" && parameter.options) {
    return (
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={Boolean(errorId)}
          aria-describedby={describedBy}
        >
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {parameter.options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (kind === "boolean") {
    return (
      <Select
        value={value === true ? "true" : "false"}
        onValueChange={(next) => onChange(next === "true")}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={Boolean(errorId)}
          aria-describedby={describedBy}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <Input
      id={id}
      value={parameterText(parameter, value)}
      inputMode={kind === "number" ? "decimal" : "text"}
      autoComplete="off"
      spellCheck={false}
      aria-invalid={Boolean(errorId)}
      aria-describedby={describedBy}
      onChange={(event) =>
        onChange(nextParameterValue(parameter, event.target.value))
      }
    />
  );
}

/** Keep invalid numeric text visible so the field can explain the error instead of discarding it. */
function nextParameterValue(
  parameter: StrategyParameter,
  text: string,
): unknown {
  const parsed = parseParameterText(parameter, text);
  return parsed.error ? text : parsed.value;
}

/** Props for the durable preset controls of one strategy. */
interface PresetSectionProps {
  parameters: WorkspaceParametersController;
}

/** Save and load named presets scoped by project root and compiled strategy name. */
function PresetSection({ parameters }: PresetSectionProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (parameters.presets.some((preset) => preset.name === selected)) return;
    setSelected(parameters.presets[0]?.name ?? "");
  }, [parameters.presets, selected]);

  /** Persist the current values only after the host accepts the named preset. */
  async function submitPreset() {
    setError("");
    setSaving(true);
    const failure = await parameters.savePreset(name);
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    setName("");
  }

  return (
    <section className="preset-section" aria-label="Parameter presets">
      <h3 className="preset-title">Presets</h3>
      {parameters.presets.length ? (
        <div className="preset-row">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger
              id="saved-preset"
              className="w-full"
              aria-label="Saved preset"
            >
              <SelectValue placeholder="Choose a preset" />
            </SelectTrigger>
            <SelectContent>
              {parameters.presets.map((preset) => (
                <SelectItem key={preset.name} value={preset.name}>
                  {preset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            disabled={!selected}
            onClick={() => parameters.loadPreset(selected)}
          >
            Load
          </Button>
        </div>
      ) : (
        <p className="param-hint">No saved presets for this strategy.</p>
      )}
      <div className="preset-row">
        <Input
          id="preset-name"
          value={name}
          placeholder="Preset name"
          aria-label="New preset name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitPreset();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={saving || !name.trim()}
          onClick={() => void submitPreset()}
        >
          {saving ? (
            <LoaderCircle className="spinner" aria-hidden="true" />
          ) : (
            <Save aria-hidden="true" />
          )}
          Save preset
        </Button>
      </div>
      {error && (
        <p className="param-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
