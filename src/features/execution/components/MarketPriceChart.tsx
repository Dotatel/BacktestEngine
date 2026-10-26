import {
  Bar,
  BarChart,
  CartesianGrid,
  ErrorBar,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  MarketCandle,
  MarketPreview,
} from "@/lib/market-preview-contract";
import type { MarketPreviewController } from "../hooks/useMarketPreview";
import { formatMetric, formatUtc } from "../lib/results";
import type { TradeMarker } from "../lib/trade-markers";

/** Draw only verified host-provided observations using the installed chart library's candle pattern. */
export function MarketPriceChart({
  controller,
  native,
  datasetSelected,
  disabled,
  markers = [],
  onSelectTrade,
  onAllHistory,
}: {
  controller: MarketPreviewController;
  native: boolean;
  datasetSelected: boolean;
  disabled: boolean;
  markers?: TradeMarker[];
  onSelectTrade?: (id: string) => void;
  onAllHistory?: () => void;
}) {
  const data = controller.data;
  if (controller.error)
    return (
      <div className="execution-chart-empty">
        <h2>Price preview could not be loaded</h2>
        <p className="execution-error" role="alert">
          {controller.error}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={controller.refresh}
          disabled={disabled}
        >
          Retry price preview
        </Button>
        {onAllHistory && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onAllHistory}
            disabled={disabled}
          >
            Use all history
          </Button>
        )}
        <span>Review the data settings or reimport the original history.</span>
      </div>
    );
  if (controller.loading)
    return (
      <div className="execution-chart-empty" role="status">
        <h2>Loading imported prices…</h2>
        <p>Checking the selected dataset and its recorded content hash.</p>
      </div>
    );
  if (!data)
    return (
      <div className="execution-chart-empty">
        <h2>
          {native && !datasetSelected
            ? "Import historical prices"
            : "Price chart unavailable"}
        </h2>
        <p>
          {native
            ? "Choose an imported dataset above or use Data settings to import a local CSV. No strategy build or economic profile is needed to inspect prices."
            : "Imported price preview is available in the desktop app."}
        </p>
        <span>No candles or volume have been generated for this view.</span>
      </div>
    );
  if (!data.candles.length)
    return (
      <div className="execution-chart-empty">
        <h2>No prices in the selected period</h2>
        <p>
          Choose dates within the imported coverage or clear the period to
          inspect all history.
        </p>
      </div>
    );
  const points = data.candles.map((candle) => ({
    ...candle,
    timestamp: Date.parse(candle.timeUtc),
  }));
  return (
    <div className="execution-candles-body">
      <div className="execution-price-description">
        <span>
          {priceLabel(data)} ·{" "}
          {data.timeframe === "source"
            ? "Original source bars"
            : `${data.timeframe} UTC buckets`}
        </span>
        {data.kind === "ticks" && (
          <Select
            value={controller.tickPrice}
            onValueChange={controller.setTickPrice}
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-label="Candle price basis">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bid">Bid prices</SelectItem>
              <SelectItem value="mid">Midpoint prices</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      <div
        className="execution-candle-chart"
        role="group"
        aria-label={`Imported OHLC candles, ${priceLabel(data)}`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={points}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            accessibilityLayer
          >
            <CartesianGrid stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={axisTime}
              minTickGap={64}
              stroke="var(--muted-foreground)"
              padding={{ left: 8, right: 8 }}
            />
            <YAxis
              orientation="right"
              width={80}
              domain={["dataMin", "dataMax"]}
              stroke="var(--muted-foreground)"
              tickFormatter={(value: number) => formatMetric(value)}
            />
            <Bar
              dataKey={candleBody}
              shape={CandleBody}
              isAnimationActive={false}
              maxBarSize={12}
            >
              <ErrorBar
                dataKey={candleWick}
                width={0}
                stroke="var(--muted-foreground)"
              />
            </Bar>
            {markers.map((marker) => (
              <ReferenceDot
                key={`${marker.tradeId}-${marker.entry}`}
                x={marker.timestamp}
                y={marker.price}
                ifOverflow="extendDomain"
                shape={(props) => (
                  <FillTriangle
                    cx={props.cx}
                    cy={props.cy}
                    marker={marker}
                    onSelectTrade={onSelectTrade}
                  />
                )}
              />
            ))}
            <Tooltip
              content={CandleTooltip}
              cursor={{ stroke: "var(--control-border)", fill: "transparent" }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {markers.length > 0 && (
        <p className="execution-note">
          Green entry and red exit triangles show actual fills from the selected
          run. Select a triangle to inspect its ledger row. Up to 200 fills are
          drawn; every trade remains in the ledger.
        </p>
      )}
      {data.volumeBasis ? (
        <>
          <p className="execution-note">
            {data.volumeBasis === "tickVolume"
              ? "Recorded tick volume"
              : "Recorded source volume"}
          </p>
          <div
            className="execution-volume-chart"
            role="img"
            aria-label="Imported recorded volume"
          >
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={points}>
                <XAxis dataKey="timestamp" hide />
                <YAxis hide />
                <Bar
                  dataKey="volume"
                  fill="var(--muted-foreground)"
                  isAnimationActive={false}
                  maxBarSize={12}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      ) : (
        <p className="execution-note">
          Volume is not present in the imported source.
        </p>
      )}
      <p className="execution-note">
        {data.candles.length} of {data.totalCandles} candles ·{" "}
        {data.selectedRowCount.toLocaleString()} selected source rows
        {data.truncated
          ? " · latest candles shown; earlier history remains outside this preview"
          : ""}
        . No gaps are filled. Boundary buckets may contain a partial period.
      </p>
      <details className="execution-candle-values">
        <summary>Exact OHLC values and data provenance</summary>
        <p className="execution-note">
          Dataset {data.datasetId} · SHA-256 {data.sha256} · source observations{" "}
          {formatUtc(data.coverage.firstTimeUtc)} through{" "}
          {formatUtc(data.coverage.lastTimeUtc)} UTC
        </p>
        <div
          className="execution-table-wrap"
          tabIndex={0}
          aria-label="Exact candle values"
        >
          <table className="execution-table">
            <caption className="sr-only">
              Exact imported candle values, times in UTC
            </caption>
            <thead>
              <tr>
                <th>UTC</th>
                <th>Open</th>
                <th>High</th>
                <th>Low</th>
                <th>Close</th>
                <th>Volume</th>
              </tr>
            </thead>
            <tbody>
              {data.candles.map((candle) => (
                <tr key={candle.timeUtc}>
                  <td>{formatUtc(candle.timeUtc)}</td>
                  <td>{formatMetric(candle.open)}</td>
                  <td>{formatMetric(candle.high)}</td>
                  <td>{formatMetric(candle.low)}</td>
                  <td>{formatMetric(candle.close)}</td>
                  <td>{formatMetric(candle.volume)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Name the exact source price policy; midpoint is never presented as an executable quote. */
function priceLabel(data: MarketPreview): string {
  if (data.priceBasis === "sourceOhlc") return "Imported OHLC";
  if (data.priceBasis === "mid") return "Bid/ask midpoint";
  return "Recorded bid";
}

/** Use UTC labels rather than the local machine timezone. */
function axisTime(value: number): string {
  return new Date(value).toISOString().slice(5, 16).replace("T", " ");
}

/** Range bars map the actual open/close body to Recharts' public numerical range API. */
function candleBody(candle: MarketCandle): [number, number] {
  return [
    Math.min(candle.open, candle.close),
    Math.max(candle.open, candle.close),
  ];
}

/** Recharts error bars are relative to the high end of a ranged bar. */
function candleWick(candle: MarketCandle): [number, number] {
  const top = Math.max(candle.open, candle.close);
  return [top - candle.low, candle.high - top];
}

/** Paint one real candle body, keeping doji visible as a one-pixel mark. */
function CandleBody(props: BarShapeProps) {
  const candle = props.payload as MarketCandle;
  return (
    <path
      className="execution-candle-body"
      d={`M${props.x},${props.y}h${props.width}v${Math.max(props.height, 1)}h${-props.width}Z`}
      fill={
        candle.close >= candle.open
          ? "var(--execution-profit)"
          : "var(--destructive)"
      }
    />
  );
}

/** Expose the exact source values for pointer and chart keyboard inspection. */
function CandleTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: MarketCandle }>;
}) {
  if (!active || !payload?.length) return null;
  const candle = payload[0].payload as MarketCandle;
  if (!candle) return null;
  return (
    <div className="execution-candle-tooltip">
      <p>{formatUtc(candle.timeUtc)} UTC</p>
      <p>
        O {formatMetric(candle.open)} · H {formatMetric(candle.high)} · L{" "}
        {formatMetric(candle.low)} · C {formatMetric(candle.close)}
      </p>
      <p>Volume {formatMetric(candle.volume)}</p>
    </div>
  );
}

/** Keep fill markers simple, keyboard accessible and linked to exact ledger evidence. */
function FillTriangle({
  cx = 0,
  cy = 0,
  marker,
  onSelectTrade,
}: {
  cx?: number;
  cy?: number;
  marker: TradeMarker;
  onSelectTrade?: (id: string) => void;
}) {
  const path = marker.entry
    ? `M${cx},${cy - 6}l-5,10h10Z`
    : `M${cx},${cy + 6}l-5,-10h10Z`;
  const label = `${marker.action}, ${formatUtc(marker.timeUtc)} UTC at ${formatMetric(marker.price)}, trade ${marker.tradeId}`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      className="execution-fill-marker"
      onClick={() => onSelectTrade?.(marker.tradeId)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelectTrade?.(marker.tradeId);
      }}
    >
      <title>{label}</title>
      <path
        d={path}
        fill={marker.entry ? "var(--execution-profit)" : "var(--destructive)"}
      />
    </g>
  );
}
