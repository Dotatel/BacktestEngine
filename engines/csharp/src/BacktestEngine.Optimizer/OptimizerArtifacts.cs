using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

namespace BacktestEngine.Optimizer;

internal static class CbotSetArtifactWriter
{
    public static void Write(
        string outputPath,
        string baseParameterPath,
        string symbol,
        string timeframe,
        IReadOnlyDictionary<string, ParameterValue> overrides)
    {
        Dictionary<string, object> chart = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        Dictionary<string, object> parameters = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(baseParameterPath))
        {
            if (!File.Exists(baseParameterPath))
                throw new FileNotFoundException("Base cBot parameter file was not found.", baseParameterPath);

            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(baseParameterPath));
            JsonElement root = document.RootElement;
            if (root.TryGetProperty("Chart", out JsonElement baseChart) && baseChart.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty property in baseChart.EnumerateObject())
                    chart[property.Name] = property.Value.Clone();
            }
            if (root.TryGetProperty("Parameters", out JsonElement baseParameters) && baseParameters.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty property in baseParameters.EnumerateObject())
                    parameters[property.Name] = property.Value.Clone();
            }
        }

        if (!string.IsNullOrWhiteSpace(symbol))
            chart["Symbol"] = symbol;
        if (!string.IsNullOrWhiteSpace(timeframe))
            chart["Period"] = timeframe;
        foreach (KeyValuePair<string, ParameterValue> parameter in overrides)
            parameters[parameter.Key] = parameter.Value.Value;

        var payload = new Dictionary<string, object>
        {
            ["Chart"] = chart,
            ["Parameters"] = parameters
        };
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath)) ?? ".");
        File.WriteAllText(outputPath, JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
    }
}

internal static class OptimizerArtifactWriter
{
    public static void WriteScenarioArtifacts(OutputConfig output, CandidateResult candidate, CandidateScenarioResult scenario)
    {
        if (output.WriteEventsJson)
        {
            scenario.EventsPath = Path.Combine(scenario.RunDir, "events.json");
            WriteEvents(scenario.EventsPath, candidate, scenario);
        }

        if (output.WriteHtmlReport)
        {
            scenario.HtmlReportPath = Path.Combine(scenario.RunDir, "report.html");
            WriteScenarioHtml(scenario.HtmlReportPath, candidate, scenario);
        }
    }

    public static void WriteResultsHtml(string path, IReadOnlyList<CandidateResult> results)
    {
        string baseDir = Path.GetDirectoryName(Path.GetFullPath(path)) ?? Directory.GetCurrentDirectory();
        StringBuilder rows = new StringBuilder();
        foreach (CandidateResult candidate in results)
        {
            BacktestMetrics metrics = candidate.Metrics ?? new BacktestMetrics();
            string reportPath = candidate.Scenarios.Select(item => item.HtmlReportPath).FirstOrDefault(item => !string.IsNullOrWhiteSpace(item)) ?? "";
            string reportLink = string.IsNullOrWhiteSpace(reportPath)
                ? ""
                : "<a href=\"" + Html(Path.GetRelativePath(baseDir, reportPath)) + "\">report</a>";
            string parameterLink = string.IsNullOrWhiteSpace(candidate.ParameterFilePath)
                ? ""
                : "<a href=\"" + Html(Path.GetRelativePath(baseDir, candidate.ParameterFilePath)) + "\">cbotset</a>";

            rows.Append("<tr>")
                .Append(Cell(candidate.Id))
                .Append(Cell(candidate.Status))
                .Append(NumberCell(candidate.FitnessScore))
                .Append(NumberCell(metrics.MarkedToMarketNetProfit))
                .Append(NullableNumberCell(metrics.ProfitFactor))
                .Append(NumberCell(metrics.MaxEquityDrawdownPercent))
                .Append(NumberCell(metrics.TotalTrades))
                .Append(NumberCell(metrics.WinRate))
                .Append(NumberCell(metrics.AverageEconomicResult))
                .Append(NumberCell(candidate.ElapsedMs))
                .Append("<td>").Append(parameterLink).Append("</td>")
                .Append("<td>").Append(reportLink).Append("</td>")
                .Append("</tr>");
        }

        string html = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Optimizer results</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;margin:24px;color:#172033;background:#f7f8fb}
    h1{margin:0 0 6px}.note{color:#5d6678;margin:0 0 18px}
    table{border-collapse:collapse;width:100%;background:white;box-shadow:0 1px 4px #0001}
    th,td{padding:9px 10px;border-bottom:1px solid #e6e9ef;text-align:right;white-space:nowrap}
    th{cursor:pointer;background:#202a44;color:white;position:sticky;top:0}th:first-child,th:nth-child(2),td:first-child,td:nth-child(2){text-align:left}
    tr:hover{background:#f0f4ff}a{color:#2457d6}.num{font-variant-numeric:tabular-nums}
  </style>
</head>
<body>
  <h1>Optimizer results</h1>
  <p class="note">All completed and failed runs are retained. Click a column heading to sort. No candidate is recommended or promoted automatically.</p>
  <table id="results">
    <thead><tr><th>Candidate</th><th>Status</th><th>Fitness</th><th>Net profit</th><th>PF</th><th>Max DD %</th><th>Trades</th><th>Win %</th><th>Avg result</th><th>Elapsed ms</th><th>Parameters</th><th>Report</th></tr></thead>
    <tbody>{{ROWS}}</tbody>
  </table>
  <script>
    document.querySelectorAll('#results th').forEach((th,i)=>th.addEventListener('click',()=>{
      const body=th.closest('table').tBodies[0], rows=[...body.rows], asc=th.dataset.asc!=='1';
      rows.sort((a,b)=>{const x=a.cells[i].dataset.value??a.cells[i].innerText, y=b.cells[i].dataset.value??b.cells[i].innerText;
        const nx=Number(x),ny=Number(y),cmp=Number.isFinite(nx)&&Number.isFinite(ny)?nx-ny:x.localeCompare(y); return asc?cmp:-cmp;});
      rows.forEach(r=>body.appendChild(r)); th.dataset.asc=asc?'1':'0';
    }));
  </script>
</body>
</html>
""".Replace("{{ROWS}}", rows.ToString(), StringComparison.Ordinal);
        File.WriteAllText(path, html);
    }

    private static void WriteEvents(string path, CandidateResult candidate, CandidateScenarioResult scenario)
    {
        List<object> events = new List<object>();
        if (File.Exists(scenario.ReportPath))
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(scenario.ReportPath));
            JsonElement root = document.RootElement;
            if (root.TryGetProperty("trades", out JsonElement trades) && trades.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement trade in trades.EnumerateArray())
                {
                    JsonElement payload = trade.Clone();
                    events.Add(new
                    {
                        event_type = "position_opened",
                        time_utc = PropertyText(trade, "entry_time_utc"),
                        payload
                    });
                    events.Add(new
                    {
                        event_type = "position_closed",
                        time_utc = PropertyText(trade, "close_time_utc"),
                        payload
                    });
                }
            }
            if (root.TryGetProperty("open_positions", out JsonElement openPositions) && openPositions.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement position in openPositions.EnumerateArray())
                {
                    events.Add(new
                    {
                        event_type = "position_open_at_end",
                        time_utc = PropertyText(position, "entry_time_utc"),
                        payload = position.Clone()
                    });
                }
            }
        }
        else
        {
            events.Add(new
            {
                event_type = "backtest_failed",
                time_utc = DateTime.UtcNow,
                error = scenario.Error
            });
        }

        var archive = new
        {
            generated_at_utc = DateTime.UtcNow,
            candidate_id = candidate.Id,
            candidate_hash = candidate.Hash,
            scenario = scenario.Name,
            symbol = scenario.Symbol,
            timeframe = scenario.Timeframe,
            status = scenario.Status,
            events
        };
        File.WriteAllText(path, JsonSerializer.Serialize(archive, Program.JsonOptions));
    }

    private static void WriteScenarioHtml(string path, CandidateResult candidate, CandidateScenarioResult scenario)
    {
        JsonElement report = JsonDocument.Parse("{}").RootElement.Clone();
        if (File.Exists(scenario.ReportPath))
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(scenario.ReportPath));
            report = document.RootElement.Clone();
        }

        var payload = new
        {
            candidate = new
            {
                id = candidate.Id,
                hash = candidate.Hash,
                fitness_score = candidate.FitnessScore,
                status = candidate.Status
            },
            scenario = new
            {
                name = scenario.Name,
                symbol = scenario.Symbol,
                timeframe = scenario.Timeframe,
                status = scenario.Status,
                error = scenario.Error,
                elapsed_ms = scenario.ElapsedMs
            },
            parameters = candidate.Parameters
                .OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(pair => pair.Key, pair => pair.Value.ToString(), StringComparer.OrdinalIgnoreCase),
            artifacts = new
            {
                report_json = "report.json",
                events_json = "events.json",
                trades_csv = "trades.csv",
                open_positions_csv = "open_positions.csv",
                parameters_cbotset = "parameters.cbotset",
                candidate_cbotset = "candidate.cbotset",
                log = "log.txt"
            },
            report
        };
        string payloadJson = JsonSerializer.Serialize(payload, Program.JsonOptions)
            .Replace("</", "<\\/", StringComparison.Ordinal);
        File.WriteAllText(path, CTraderStyleReportTemplate.Render(payloadJson));
    }

    private static string PropertyText(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) ? value.ToString() : "";
    }

    private static string MetricRow(string name, double? value)
    {
        return "<tr><td>" + Html(name) + "</td><td>" + Html(Format(value)) + "</td></tr>";
    }

    private static string MetricRow(string name, int value)
    {
        return MetricRow(name, (double)value);
    }

    private static string Cell(string value)
    {
        return "<td>" + Html(value) + "</td>";
    }

    private static string NumberCell(double value)
    {
        string formatted = Format(value);
        return "<td class=\"num\" data-value=\"" + Html(formatted) + "\">" + Html(formatted) + "</td>";
    }

    private static string NullableNumberCell(double? value)
    {
        return value == null ? "<td></td>" : NumberCell(value.Value);
    }

    private static string Format(double? value)
    {
        return value == null ? "" : value.Value.ToString("0.########", CultureInfo.InvariantCulture);
    }

    private static string Html(string value)
    {
        return WebUtility.HtmlEncode(value ?? "");
    }
}
