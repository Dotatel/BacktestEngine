import { useEffect, useState } from "react";
import type { SavedRunInputs } from "@/lib/saved-runs-contract";
import { Download } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  ExecutionRunRequest,
  ExecutionRunResult,
} from "@/lib/execution-contract";
import {
  chartSamples,
  exportTrades,
  formatMetric,
  formatUtc,
  sampledDrawdown,
} from "../lib/results";
import { TradeLedger } from "./TradeLedger";

/** Keep reported headline metrics in the small chart-centred group used by the design. */
export function RunMetrics({
  result,
  previous = false,
}: {
  result: ExecutionRunResult | null;
  previous?: boolean;
}) {
  const source = result?.success ? result : null;
  return (
    <dl className="execution-run-metrics" aria-label="Run metrics">
      {source && previous && (
        <div>
          <dt>Previous run metrics</dt>
          <dd>{source.runId}</dd>
        </div>
      )}
      <div>
        <dt>Net return</dt>
        <dd>
          {formatMetric(source?.account?.markedToMarketReturnPercent, "%")}
        </dd>
      </div>
      <div>
        <dt>Profit factor</dt>
        <dd>{formatMetric(source?.tradeStatistics?.profitFactor)}</dd>
      </div>
      <div>
        <dt>Max equity DD</dt>
        <dd>
          {formatMetric(
            source?.fullReplayDrawdown?.maxEquityDrawdownPercent ??
              source?.nativeReportDrawdown?.maxEquityDrawdownPercent,
            "%",
          )}
        </dd>
      </div>
      <div>
        <dt>Trades</dt>
        <dd>{formatMetric(source?.tradeStatistics?.totalTrades)}</dd>
      </div>
    </dl>
  );
}

/** Display reported provenance and the frozen launch inputs separately from the current draft. */
export function RunIdentity({
  result,
  request,
  savedInputs,
  previous,
  activeRequest,
}: {
  result: ExecutionRunResult | null;
  request: ExecutionRunRequest | null;
  savedInputs?: SavedRunInputs | null;
  previous: boolean;
  activeRequest: ExecutionRunRequest | null;
}) {
  return (
    <div className="execution-run-identity" aria-live="polite">
      {result ? (
        <>
          <p>
            <strong>{previous ? "Previous run" : "Completed run"}</strong> ·{" "}
            {result.runId} · {result.strategy} · {result.datasetId}
          </p>
          <details>
            <summary>Run inputs and provenance</summary>
            <p>
              Completed {formatUtc(result.completedAt)} UTC · build{" "}
              {result.buildRevision || "revision unavailable"}
            </p>
            {savedInputs ? <HistoricalInputs inputs={savedInputs} /> : null}
            {request ? (
              <FrozenInputs request={request} />
            ) : (
              !savedInputs && (
                <p>Original launch inputs are unavailable in this session.</p>
              )
            )}
          </details>
        </>
      ) : (
        <p>
          No backtest result yet. Configure a strategy and historical data, then
          run it.
        </p>
      )}
      {activeRequest && (
        <details open>
          <summary>Current backtest · frozen inputs</summary>
          <FrozenInputs request={activeRequest} />
        </details>
      )}
    </div>
  );
}

/** Show receipt-captured historical controls without constructing a new executable request or changing drafts. */
function HistoricalInputs({ inputs }: { inputs: SavedRunInputs }) {
  const settings = inputs.settings;
  return (
    <div className="execution-frozen-inputs">
      <p>Saved run selected. Current controls are unchanged.</p>
      <p>
        {settings.strategy} · {inputs.dataset.id} · capital{" "}
        {formatMetric(settings.startingBalance)} · commission{" "}
        {settings.commissionUsdPerMillion < 0
          ? "profile default"
          : `${formatMetric(settings.commissionUsdPerMillion)} USD / million`}{" "}
        (effective {formatMetric(settings.effectiveCommissionUsdPerMillion)} USD
        / million) · slippage {formatMetric(settings.slippagePips)} pips
      </p>
      <p>
        Start {settings.startUtc || "first imported record"} (inclusive) · End{" "}
        {settings.endUtc || "last imported record"} (exclusive when set)
      </p>
      <p>
        Timeframe {settings.timeframe} · source bars{" "}
        {settings.barTimeframe || "n/a"} · price mode{" "}
        {settings.barPriceMode || "n/a"} · spread{" "}
        {settings.spreadPips === null || settings.spreadPips < 0
          ? "recorded bid / ask"
          : settings.spreadPips}
      </p>
      <p>
        Parameters:{" "}
        {Object.entries(settings.parameterOverrides)
          .map(([name, value]) => `${name} = ${value}`)
          .join(" · ") || "compiled defaults"}
      </p>
      <p>
        Dataset SHA-256 {inputs.dataset.sha256} · profile SHA-256{" "}
        {inputs.profile.sha256}
      </p>
    </div>
  );
}

/** Show exact financial and date inputs that were submitted, without referring to live controls. */
function FrozenInputs({ request }: { request: ExecutionRunRequest }) {
  return (
    <div className="execution-frozen-inputs">
      <p>
        {request.strategy} · {request.datasetId} · capital{" "}
        {formatMetric(request.startingBalance)} · commission{" "}
        {formatMetric(request.commissionUsdPerMillion)} USD / million · slippage{" "}
        {formatMetric(request.slippagePips)} pips · spread{" "}
        {request.spreadPips !== undefined && request.spreadPips >= 0
          ? `${request.spreadPips} pips fixed`
          : "recorded bid / ask"}
      </p>
      <p>
        Start {request.startUtc || "first imported record"} (inclusive) · End{" "}
        {request.endUtc || "last imported record"} (exclusive when set)
      </p>
      <p>
        Parameters:{" "}
        {Object.entries(request.parameterOverrides ?? {})
          .map(([name, value]) => `${name} = ${value}`)
          .join(" · ") || "compiled defaults"}
      </p>
    </div>
  );
}

/** Keep every result tab and export bound to a single selected run, including previous results. */
export function BacktestResults({
  result,
  attempt,
  previous,
  selectedTrade,
}: {
  result: ExecutionRunResult | null;
  attempt: ExecutionRunResult | null;
  previous: boolean;
  selectedTrade?: { id: string } | null;
}) {
  const [tab, setTab] = useState("trades");
  useEffect(() => {
    if (selectedTrade) setTab("trades");
  }, [selectedTrade]);
  const source = result ?? attempt;
  return (
    <section className="execution-results" aria-label="Backtest results">
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="execution-result-tabs"
      >
        <header className="execution-results-heading">
          <div className="execution-tabs-scroll">
            <TabsList variant="line" aria-label="Result views">
              <TabsTrigger value="trades">Trades</TabsTrigger>
              <TabsTrigger value="statistics">Statistics</TabsTrigger>
              <TabsTrigger value="equity">Equity curve</TabsTrigger>
              <TabsTrigger value="drawdown">Drawdown</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!source?.success}
            onClick={() => source && exportTrades(source)}
          >
            <Download aria-hidden="true" />
            Export trades
          </Button>
        </header>
        <p className="execution-result-label">
          {source
            ? `${previous ? "Previous run" : "Run"} ${source.runId} · ${source.datasetId}`
            : "No completed run selected"}
        </p>
        <TabsContent value="trades">
          <TradeLedger
            key={source?.runId ?? "empty"}
            result={source}
            selectedTradeId={selectedTrade?.id}
          />
        </TabsContent>
        <TabsContent value="statistics">
          <Statistics result={source} />
        </TabsContent>
        <TabsContent value="equity">
          <EquityChart result={source} drawdown={false} />
        </TabsContent>
        <TabsContent value="drawdown">
          <EquityChart result={source} drawdown />
        </TabsContent>
        <TabsContent value="logs">
          <div className="execution-log">
            {source ? (
              <>
                <p>
                  Run {source.runId} · {source.status} ·{" "}
                  {formatMetric(source.durationMs)} ms
                </p>
                {source.errors.length > 0 && (
                  <p className="execution-error">{source.errors.join("\n")}</p>
                )}
                <pre>
                  {source.output || "No log output was captured for this run."}
                </pre>
              </>
            ) : (
              <p>No run logs yet.</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

/** Render account and closed-trade statistics without converting missing values to zero. */
function Statistics({ result }: { result: ExecutionRunResult | null }) {
  if (!result?.success)
    return (
      <p className="execution-tab-empty">
        Run a backtest to see its statistics.
      </p>
    );
  const stats = result.tradeStatistics;
  const account = result.account;
  const metrics = [
    ["Starting capital", formatMetric(account?.startingCapital)],
    ["Final marked equity", formatMetric(account?.equity)],
    ["Final balance", formatMetric(account?.balance)],
    ["Account currency", account?.currency || "n/a"],
    ["Closed net profit", formatMetric(account?.closedNetProfit)],
    ["Open net profit", formatMetric(account?.openNetProfit)],
    ["Winning trades", formatMetric(stats?.winningTrades)],
    ["Losing trades", formatMetric(stats?.losingTrades)],
    ["Win rate", formatMetric(stats?.winRate, "%")],
    ["Average net profit", formatMetric(stats?.averageNetProfit)],
    ["Commissions", formatMetric(stats?.commissions)],
    ["Swaps", formatMetric(stats?.swaps)],
  ];
  return (
    <div className="execution-statistics-wrap">
      <dl className="execution-statistics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="execution-note">
        Marked equity includes open positions; balance reflects realized account
        changes. Maximum equity drawdown measures the largest peak-to-trough
        fall in marked equity.
      </p>
    </div>
  );
}

/** Plot genuine run samples; drawdown here is explicitly limited to the sampled equity path. */
function EquityChart({
  result,
  drawdown,
}: {
  result: ExecutionRunResult | null;
  drawdown: boolean;
}) {
  if (!result?.success || !result.equity.length)
    return (
      <p className="execution-tab-empty">
        No equity samples reported for this run.
      </p>
    );
  const points = chartSamples(sampledDrawdown(result.equity));
  return (
    <div className="execution-equity">
      <p className="execution-note">
        {drawdown ? "Sampled equity drawdown (%)" : "Marked equity and balance"}{" "}
        · {result.account?.currency || "account currency unavailable"} ·{" "}
        {points.length} of {result.equity.length} samples
      </p>
      <div
        className="execution-equity-chart"
        role="img"
        aria-label={drawdown ? "Sampled equity drawdown" : "Equity and balance"}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart
            data={points}
            margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            accessibilityLayer
          >
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="timeUtc"
              tickFormatter={(value: string) => value.slice(0, 10)}
              minTickGap={64}
              stroke="var(--muted-foreground)"
            />
            <YAxis
              width={72}
              domain={["auto", "auto"]}
              stroke="var(--muted-foreground)"
            />
            <Tooltip
              labelFormatter={(value) => `${formatUtc(String(value))} UTC`}
              contentStyle={{
                background: "var(--card)",
                borderColor: "var(--border)",
                color: "var(--foreground)",
              }}
            />
            {drawdown ? (
              <Line
                name="Drawdown %"
                type="linear"
                dataKey="drawdownPercent"
                stroke="var(--destructive)"
                dot={false}
                isAnimationActive={false}
              />
            ) : (
              <>
                <Line
                  name="Marked equity"
                  type="linear"
                  dataKey="equity"
                  stroke="var(--ring)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  name="Balance"
                  type="linear"
                  dataKey="balance"
                  stroke="var(--muted-foreground)"
                  dot={false}
                  isAnimationActive={false}
                />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="execution-note">
        Chart samples are reduced for display. Reported statistics use the run's
        full results. Sampled drawdown can miss intrabar extremes; see the
        reported maximum above.
      </p>
    </div>
  );
}
