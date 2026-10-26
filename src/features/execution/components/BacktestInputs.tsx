import type { ReactNode } from "react";
import { Database, SlidersHorizontal } from "lucide-react";
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
import type { BacktestController } from "../hooks/useBacktest";
import type { MarketPreview } from "@/lib/market-preview-contract";
import { previewTimeframes } from "@/lib/market-preview-contract";
import { PreviewPeriod } from "./PreviewPeriod";

/** Arrange market, capital and cost inputs above the chart using standard control geometry. */
export function BacktestInputs({
  controller,
  native,
  children,
  coverage,
}: {
  controller: BacktestController;
  native: boolean;
  children: ReactNode;
  coverage?: MarketPreview["coverage"] | null;
}) {
  const busy = controller.phase !== "idle";
  return (
    <section
      className="execution-inputs"
      aria-label="Market and run configuration"
    >
      <div className="execution-market-row">
        <div className="execution-market-field">
          <Label htmlFor="execution-symbol">Symbol profile</Label>
          <Select
            value={controller.selectedSymbolSpecId ?? ""}
            onValueChange={controller.selectSymbolSpec}
            disabled={busy}
          >
            <SelectTrigger id="execution-symbol" size="sm">
              <SelectValue placeholder="Import profile" />
            </SelectTrigger>
            <SelectContent>
              {controller.symbolSpecs.map((spec) => (
                <SelectItem key={spec.id} value={spec.id}>
                  {fileName(spec.originalPath)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="execution-market-field">
          <Label htmlFor="execution-timeframe">TF</Label>
          <div className="execution-timeframe">
            <Select
              value={controller.economics.timeframe || "__default"}
              disabled={busy}
              onValueChange={(value) =>
                controller.updateEconomics({
                  timeframe: value === "__default" ? "" : value,
                })
              }
            >
              <SelectTrigger id="execution-timeframe" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default">Strategy default</SelectItem>
                {previewTimeframes
                  .filter((value) => value !== "source")
                  .map((value) => (
                    <SelectItem value={value} key={value}>
                      {value}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="execution-market-field execution-data-field">
          <Label htmlFor="execution-dataset">Data</Label>
          <Select
            value={controller.selectedDatasetId ?? ""}
            onValueChange={controller.selectDataset}
            disabled={busy}
          >
            <SelectTrigger id="execution-dataset" size="sm">
              <SelectValue placeholder="Import data" />
            </SelectTrigger>
            <SelectContent>
              {controller.datasets.map((dataset) => (
                <SelectItem key={dataset.id} value={dataset.id}>
                  {fileName(dataset.originalPath)} · {dataset.kind}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="execution-market-field">
          <Label htmlFor="execution-capital">Capital</Label>
          <div className="execution-capital">
            <Input
              id="execution-capital"
              type="number"
              min="0"
              value={numberValue(controller.economics.initialBalance)}
              disabled={busy}
              onChange={(event) =>
                controller.updateEconomics({
                  initialBalance: numberInput(event.target.value),
                })
              }
            />
          </div>
        </div>
        <Costs controller={controller} />
        <DataSettings controller={controller} native={native} />
        <div className="execution-run-action">{children}</div>
      </div>
      <PreviewPeriod controller={controller} coverage={coverage ?? null} />
      <p className="execution-period-note">
        Start includes 00:00 UTC. End excludes 00:00 UTC on the selected date;
        the preceding date is the last full included day. Leave blank for all
        imported history.
      </p>
    </section>
  );
}

/** Preserve missing numeric input as invalid instead of silently setting zero. */
function numberInput(value: string): number {
  return value.trim() ? Number(value) : Number.NaN;
}

/** Show invalid numeric drafts as empty, avoiding a non-finite DOM input value. */
function numberValue(value: number): number | string {
  return Number.isFinite(value) ? value : "";
}

/** Show the user's file name rather than an opaque storage identifier in selectors. */
function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) || path;
}

/** Expose explicit cost units and the quoted-versus-fixed spread choice without double counting. */
function Costs({ controller }: { controller: BacktestController }) {
  const busy = controller.phase !== "idle";
  const economics = controller.economics;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <SlidersHorizontal aria-hidden="true" />
          Costs
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trading costs</DialogTitle>
          <DialogDescription>
            Applied to the next run. Completed results keep their original
            costs.
          </DialogDescription>
        </DialogHeader>
        <div className="execution-field">
          <Label htmlFor="execution-spread-mode">Spread source</Label>
          <Select
            value={economics.spreadPips < 0 ? "quoted" : "fixed"}
            onValueChange={(value) =>
              controller.updateEconomics({
                spreadPips: value === "quoted" ? -1 : 0,
              })
            }
            disabled={busy}
          >
            <SelectTrigger id="execution-spread-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quoted">Recorded bid / ask spread</SelectItem>
              <SelectItem value="fixed">Fixed modeled spread</SelectItem>
            </SelectContent>
          </Select>
          <p className="execution-note">
            Recorded spread uses the imported quotes. Fixed spread replaces it;
            it is not added on top.
          </p>
        </div>
        {economics.spreadPips >= 0 && (
          <div className="execution-field">
            <Label htmlFor="execution-spread">Fixed spread (pips)</Label>
            <Input
              id="execution-spread"
              type="number"
              min="0"
              step="any"
              disabled={busy}
              value={numberValue(economics.spreadPips)}
              onChange={(event) =>
                controller.updateEconomics({
                  spreadPips: numberInput(event.target.value),
                })
              }
            />
          </div>
        )}
        <div className="execution-field">
          <Label htmlFor="execution-commission">
            Commission (USD per million units)
          </Label>
          <Input
            id="execution-commission"
            type="number"
            step="any"
            disabled={busy}
            value={numberValue(economics.commission)}
            onChange={(event) =>
              controller.updateEconomics({
                commission: numberInput(event.target.value),
              })
            }
          />
          <p className="execution-note">
            Use -1 for the imported symbol profile's commission.
          </p>
        </div>
        <div className="execution-field">
          <Label htmlFor="execution-slippage">Slippage (pips per fill)</Label>
          <Input
            id="execution-slippage"
            type="number"
            min="0"
            step="any"
            disabled={busy}
            value={numberValue(economics.slippage)}
            onChange={(event) =>
              controller.updateEconomics({
                slippage: numberInput(event.target.value),
              })
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Keep validated local import and replay details accessible without occupying the strategy panel. */
function DataSettings({
  controller,
  native,
}: {
  controller: BacktestController;
  native: boolean;
}) {
  const busy = controller.phase !== "idle";
  const selected = controller.datasets.find(
    (dataset) => dataset.id === controller.selectedDatasetId,
  );
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Database aria-hidden="true" />
          Data settings
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Historical data</DialogTitle>
          <DialogDescription>
            Import local history and a symbol profile. The profile defines
            symbol and account economics.
          </DialogDescription>
        </DialogHeader>
        <div className="execution-field">
          <Label htmlFor="execution-kind">Import format</Label>
          <Select
            value={controller.importKind}
            onValueChange={controller.setImportKind}
            disabled={busy}
          >
            <SelectTrigger id="execution-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bars">Bars</SelectItem>
              <SelectItem value="ticks">Ticks</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="execution-inline">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void controller.importDataset()}
            disabled={busy || !native}
          >
            Import historical CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void controller.importSymbolSpec()}
            disabled={busy || !native}
          >
            Import symbol profile
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void controller.refreshCatalog()}
            disabled={busy || !native}
          >
            Refresh
          </Button>
        </div>
        {selected && (
          <p className="execution-note">
            {fileName(selected.originalPath)} ·{" "}
            {selected.rowCount.toLocaleString()} rows · {selected.kind}
          </p>
        )}
        {selected?.kind === "bars" && (
          <>
            <div className="execution-field">
              <Label htmlFor="execution-bar-timeframe">
                Source bar timeframe
              </Label>
              <Input
                id="execution-bar-timeframe"
                placeholder="e.g. M1"
                disabled={busy}
                value={controller.economics.barTimeframe}
                onChange={(event) =>
                  controller.updateEconomics({
                    barTimeframe: event.target.value,
                  })
                }
              />
            </div>
            <div className="execution-field">
              <Label htmlFor="execution-price-mode">Bar price path</Label>
              <Select
                value={controller.economics.barPriceMode}
                onValueChange={(value) =>
                  controller.updateEconomics({ barPriceMode: value })
                }
                disabled={busy}
              >
                <SelectTrigger id="execution-price-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ohlc">OHLC path</SelectItem>
                  <SelectItem value="open">Bar open only</SelectItem>
                  <SelectItem value="native-m1">One-minute source</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="execution-note">
              Bar history models intrabar prices. It does not contain the
              original tick sequence.
            </p>
          </>
        )}
        <p className="execution-note">
          Imported coverage comes from actual source timestamps. Exact UTC dates
          and range handles select the next run period.
        </p>
        {controller.error && (
          <p className="execution-error" role="alert">
            {controller.error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
