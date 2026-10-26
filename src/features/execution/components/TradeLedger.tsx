import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  ExecutionRunResult,
  ExecutionTrade,
} from "@/lib/execution-contract";
import { formatMetric, formatUtc } from "../lib/results";

/** Show actual closed trades with stable sorting, pagination and an exact execution detail row. */
export function TradeLedger({
  result,
  selectedTradeId,
}: {
  result: ExecutionRunResult | null;
  selectedTradeId?: string;
}) {
  const [sort, setSort] = useState<"time" | "profit">("time");
  const [ascending, setAscending] = useState(true);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!selectedTradeId || !result) return;
    const sorted = [...result.trades].sort(
      (left, right) => compareTrades(left, right, sort) * (ascending ? 1 : -1),
    );
    const index = sorted.findIndex((trade) => trade.id === selectedTradeId);
    if (index < 0) return;
    setSelected(selectedTradeId);
    setPage(Math.floor(index / 20));
  }, [selectedTradeId, result, sort, ascending]);
  useEffect(() => {
    if (selectedTradeId && selected === selectedTradeId)
      selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedTradeId, selected, page]);
  if (!result?.success || !result.trades.length)
    return (
      <p className="execution-tab-empty">
        {result?.success
          ? "No closed trades reported for this run."
          : "Run a backtest to see its trades."}
      </p>
    );
  const sorted = [...result.trades].sort(
    (left, right) => compareTrades(left, right, sort) * (ascending ? 1 : -1),
  );
  const totalPages = Math.ceil(sorted.length / 20);
  const currentPage = Math.min(page, totalPages - 1);
  const rows = sorted.slice(currentPage * 20, (currentPage + 1) * 20);
  const selectedTrade = result.trades.find((trade) => trade.id === selected);

  /** Reset the visible page when changing ordering; never mutate run evidence. */
  function changeSort(next: "time" | "profit") {
    setAscending(next === sort ? !ascending : true);
    setSort(next);
    setPage(0);
  }

  return (
    <div className="execution-ledger">
      <div className="execution-table-wrap">
        <table className="execution-table">
          <caption className="sr-only">
            Closed trades for run {result.runId}. Times are UTC; volumes are
            units.
          </caption>
          <thead>
            <tr>
              <th>Trade</th>
              <th aria-sort={sortState(sort === "time", ascending)}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => changeSort("time")}
                >
                  Entry (UTC)
                  {sort === "time" && <SortIcon ascending={ascending} />}
                </Button>
              </th>
              <th>Exit (UTC)</th>
              <th>Side</th>
              <th>Entry price</th>
              <th>Exit price</th>
              <th>Volume (units)</th>
              <th aria-sort={sortState(sort === "profit", ascending)}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => changeSort("profit")}
                >
                  Net P&amp;L
                  {sort === "profit" && <SortIcon ascending={ascending} />}
                </Button>
              </th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((trade) => (
              <tr
                key={trade.id}
                data-selected={selected === trade.id}
                ref={selected === trade.id ? selectedRow : undefined}
              >
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Inspect trade ${trade.id}`}
                    aria-pressed={selected === trade.id}
                    onClick={() =>
                      setSelected(selected === trade.id ? null : trade.id)
                    }
                  >
                    {trade.id}
                  </Button>
                </td>
                <td>{formatUtc(trade.entryTimeUtc)}</td>
                <td>{formatUtc(trade.closeTimeUtc)}</td>
                <td
                  className={
                    trade.side.toLowerCase() === "buy"
                      ? "execution-positive"
                      : "execution-negative"
                  }
                >
                  {trade.side}
                </td>
                <td>{formatMetric(trade.entryPrice)}</td>
                <td>{formatMetric(trade.closePrice)}</td>
                <td>{formatMetric(trade.volumeInUnits)}</td>
                <td className={profitClass(trade.netProfit)}>
                  {formatMetric(trade.netProfit)}
                </td>
                <td className={profitClass(trade.netProfit)}>
                  {profitLabel(trade.netProfit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectedTrade && (
        <div className="execution-trade-detail" role="status">
          <strong>
            Trade {selectedTrade.id} · {selectedTrade.symbol}
          </strong>
          <p>
            {selectedTrade.side} entry {formatUtc(selectedTrade.entryTimeUtc)}{" "}
            UTC at {formatMetric(selectedTrade.entryPrice)} · exit{" "}
            {formatUtc(selectedTrade.closeTimeUtc)} UTC at{" "}
            {formatMetric(selectedTrade.closePrice)} ·{" "}
            {selectedTrade.closeReason}
          </p>
          <p>
            Commission {formatMetric(selectedTrade.commissions)} · swap{" "}
            {formatMetric(selectedTrade.swaps)} · net{" "}
            {formatMetric(selectedTrade.netProfit)} {result.account?.currency}
          </p>
        </div>
      )}
      <footer className="execution-pagination">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Previous trade page"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span>
          Page {currentPage + 1} of {totalPages}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Next trade page"
          disabled={currentPage + 1 === totalPages}
          onClick={() => setPage(currentPage + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <span>
          {currentPage * 20 + 1}–
          {Math.min((currentPage + 1) * 20, sorted.length)} of {sorted.length}{" "}
          trades · 20 / page
        </span>
      </footer>
    </div>
  );
}

/** Compare genuine numeric or ISO-UTC evidence without locale-dependent date parsing. */
function compareTrades(
  left: ExecutionTrade,
  right: ExecutionTrade,
  sort: "time" | "profit",
): number {
  if (sort === "profit") return left.netProfit - right.netProfit;
  return left.entryTimeUtc.localeCompare(right.entryTimeUtc);
}

/** Preserve native table sorting semantics for keyboard and screen-reader users. */
function sortState(
  active: boolean,
  ascending: boolean,
): "none" | "ascending" | "descending" {
  if (!active) return "none";
  return ascending ? "ascending" : "descending";
}

/** Use the bundled icon set for sorting direction. */
function SortIcon({ ascending }: { ascending: boolean }) {
  return ascending ? (
    <ArrowUp aria-hidden="true" />
  ) : (
    <ArrowDown aria-hidden="true" />
  );
}

/** Distinguish a break-even trade from a win or loss. */
function profitLabel(value: number): string {
  if (value > 0) return "Win";
  if (value < 0) return "Loss";
  return "Break-even";
}

/** Apply shared semantic colors without cell badges or extra surface containers. */
function profitClass(value: number): string {
  if (value > 0) return "execution-positive";
  if (value < 0) return "execution-negative";
  return "";
}
