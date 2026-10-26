import { RotateCcw } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { WorkspaceParametersController } from "@/features/workspace/hooks/useWorkspaceParameters";
import type { StrategyParameter } from "@/lib/workspace-contract";
import {
  parameterKind,
  parameterText,
  parseParameterText,
  parameterHint,
  validateParameterValue,
} from "@/features/workspace/lib/parameters";

/** Render only compiled strategy selection and parameters in the approved left panel. */
export function StrategyControls({
  parameters,
  disabled,
  onBuild,
}: {
  parameters: WorkspaceParametersController;
  disabled: boolean;
  onBuild?: () => void;
}) {
  return (
    <aside className="execution-strategy" aria-label="Strategy parameters">
      <h2>Strategy parameters</h2>
      <div className="execution-field">
        <Label htmlFor="backtest-strategy">Strategy</Label>
        <div className="execution-inline">
          <Select
            value={parameters.activeStrategy?.strategy ?? ""}
            onValueChange={parameters.selectStrategy}
            disabled={disabled || !parameters.strategies.length}
          >
            <SelectTrigger id="backtest-strategy" size="sm">
              <SelectValue placeholder="Build a strategy" />
            </SelectTrigger>
            <SelectContent>
              {parameters.strategies.map((strategy) => (
                <SelectItem key={strategy.strategy} value={strategy.strategy}>
                  {strategy.strategy}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Dialog>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || !parameters.activeStrategy}
              >
                Rules
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Strategy rules</DialogTitle>
                <DialogDescription>
                  Entry and exit rules are defined in your strategy source.
                  Review them in Build.
                </DialogDescription>
              </DialogHeader>
              <p>{parameters.activeStrategy?.strategy}</p>
              <dl className="execution-statistics">
                {parameters.activeStrategy?.parameters.map((parameter) => (
                  <div key={parameter.name}>
                    <dt>{parameter.displayName || parameter.name}</dt>
                    <dd>{parameterHint(parameter)}</dd>
                  </div>
                ))}
              </dl>
              {onBuild && (
                <Button size="sm" variant="outline" onClick={onBuild}>
                  Open strategy source
                </Button>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>
      <div className="execution-parameter-list">
        {parameters.activeStrategy?.parameters.map((parameter) => (
          <ParameterControl
            key={parameter.name}
            parameter={parameter}
            value={parameters.values[parameter.name]}
            disabled={disabled}
            onChange={(value) => parameters.setValue(parameter.name, value)}
          />
        ))}
        {!parameters.activeStrategy && (
          <p className="execution-note">
            Build the project to load its strategy and parameters.
          </p>
        )}
        {parameters.activeStrategy?.parameters.length === 0 && (
          <p className="execution-note">
            This strategy has no adjustable parameters.
          </p>
        )}
      </div>
      {parameters.message && (
        <p className="execution-note" role="status">
          {parameters.message}
        </p>
      )}
      <div className="execution-parameter-reset">
        <Button
          size="sm"
          variant="outline"
          onClick={parameters.resetDefaults}
          disabled={disabled || !parameters.activeStrategy}
        >
          <RotateCcw aria-hidden="true" />
          Reset parameters
        </Button>
      </div>
    </aside>
  );
}

/** Reuse compiled-schema parsing and validation for one editable value. */
function ParameterControl({
  parameter,
  value,
  disabled,
  onChange,
}: {
  parameter: StrategyParameter;
  value: unknown;
  disabled: boolean;
  onChange(value: unknown): void;
}) {
  const id = `backtest-param-${parameter.name}`;
  const kind = parameterKind(parameter);
  const error = validateParameterValue(parameter, value);
  const choices = kind === "boolean" ? ["true", "false"] : parameter.options;

  /** Preserve invalid text for correction rather than silently replacing a value. */
  function change(text: string) {
    const parsed = parseParameterText(parameter, text);
    onChange(parsed.error ? text : parsed.value);
  }

  return (
    <div className="execution-parameter">
      <Label htmlFor={id}>{parameter.displayName || parameter.name}</Label>
      {choices?.length ? (
        <Select
          value={parameterText(parameter, value)}
          onValueChange={change}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            size="sm"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          value={parameterText(parameter, value)}
          inputMode={kind === "number" ? "decimal" : "text"}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          title={parameterHint(parameter)}
          onChange={(event) => change(event.target.value)}
        />
      )}
      {error && (
        <p id={`${id}-error`} className="execution-error">
          {error}
        </p>
      )}
    </div>
  );
}
