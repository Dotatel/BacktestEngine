import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { MarketPreview } from "@/lib/market-preview-contract";
import type { BacktestController } from "../hooks/useBacktest";

const dayMs = 86_400_000;

/** Synchronize exact inclusive/exclusive UTC date alternatives with real source-bound handles. */
export function PreviewPeriod({
  controller,
  coverage,
}: {
  controller: BacktestController;
  coverage: MarketPreview["coverage"] | null;
}) {
  const minimum = coverage
    ? Math.floor(Date.parse(coverage.firstTimeUtc) / dayMs)
    : 0;
  const maximum = coverage
    ? Math.floor(Date.parse(coverage.lastTimeUtc) / dayMs) + 1
    : 1;
  const start =
    controller.economics.startDate || (coverage ? dayText(minimum) : "");
  const end =
    controller.economics.endDate || (coverage ? dayText(maximum) : "");
  const selectedStart = Date.parse(start) / dayMs;
  const selectedEnd = Date.parse(end) / dayMs;
  const valid =
    Number.isFinite(selectedStart) &&
    Number.isFinite(selectedEnd) &&
    selectedStart >= minimum &&
    selectedEnd <= maximum &&
    selectedStart < selectedEnd;
  const [handles, setHandles] = useState([minimum, maximum]);
  const busy = controller.phase !== "idle";
  useEffect(() => {
    setHandles(valid ? [selectedStart, selectedEnd] : [minimum, maximum]);
  }, [minimum, maximum, selectedStart, selectedEnd, valid]);

  /** Commit both dates together after pointer or keyboard adjustment, with an exclusive end. */
  function commit(values: number[]) {
    controller.updateEconomics({
      startDate: dayText(values[0]),
      endDate: dayText(values[1]),
    });
  }

  return (
    <div
      className="execution-period-row"
      role="group"
      aria-label="UTC test period"
    >
      <div className="execution-market-field">
        <Label htmlFor="execution-start">Start UTC</Label>
        <Input
          id="execution-start"
          type="date"
          min={coverage ? dayText(minimum) : undefined}
          max={coverage ? dayText(maximum - 1) : undefined}
          value={controller.economics.startDate}
          disabled={busy}
          aria-invalid={Boolean(coverage && !valid)}
          onChange={(event) =>
            controller.updateEconomics({ startDate: event.target.value })
          }
        />
      </div>
      {coverage ? (
        <div
          className="execution-period-slider"
          role="group"
          aria-label="UTC day range; minimum is start and maximum is exclusive end"
        >
          <Slider
            min={minimum}
            max={maximum}
            step={1}
            minStepsBetweenThumbs={1}
            value={handles}
            onValueChange={setHandles}
            onValueCommit={commit}
            disabled={busy || !valid || maximum - minimum <= 1}
          />
        </div>
      ) : (
        <span className="execution-period-divider" aria-hidden="true" />
      )}
      <div className="execution-market-field">
        <Label htmlFor="execution-end">End UTC (exclusive)</Label>
        <Input
          id="execution-end"
          type="date"
          min={coverage ? dayText(minimum + 1) : undefined}
          max={coverage ? dayText(maximum) : undefined}
          value={controller.economics.endDate}
          disabled={busy}
          aria-invalid={Boolean(coverage && !valid)}
          onChange={(event) =>
            controller.updateEconomics({ endDate: event.target.value })
          }
        />
      </div>
      {coverage && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            controller.updateEconomics({ startDate: "", endDate: "" })
          }
        >
          All history
        </Button>
      )}
    </div>
  );
}

/** Map UTC day indexes into unambiguous calendar dates for text and slider controls. */
function dayText(day: number): string {
  return new Date(day * dayMs).toISOString().slice(0, 10);
}
