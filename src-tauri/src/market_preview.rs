//! Bounded chart inspection of verified app-owned history, independent of economic execution.

use crate::market_data::{self, ImportedDataset, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS};
use chrono::{DateTime, Datelike, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

const MAX_CANDLES: usize = 500;
const MAX_LINE_BYTES: usize = 64 * 1024;

/// Source OHLC or one of the supported fixed UTC aggregation intervals.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub enum PreviewTimeframe {
    #[serde(rename = "source")]
    Source,
    M1,
    M5,
    M15,
    M30,
    H1,
    H4,
    D1,
}

impl PreviewTimeframe {
    /// Fixed UTC bucket duration; original source bars have no assumed duration.
    fn seconds(self) -> Option<i64> {
        match self {
            Self::Source => None,
            Self::M1 => Some(60),
            Self::M5 => Some(300),
            Self::M15 => Some(900),
            Self::M30 => Some(1800),
            Self::H1 => Some(3600),
            Self::H4 => Some(14400),
            Self::D1 => Some(86400),
        }
    }
}

/// Explicit tick-to-candle price convention; midpoint is not an executable quote.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TickPrice {
    Bid,
    Mid,
}

/// One bounded renderer request for an approved imported dataset.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketPreviewRequest {
    pub dataset_id: String,
    pub timeframe: PreviewTimeframe,
    pub tick_price: TickPrice,
    pub source_timeframe: Option<PreviewTimeframe>,
    pub start_utc: Option<String>,
    pub end_utc: Option<String>,
    pub maximum_candles: usize,
}

/// Genuine source OHLC or an aggregation of actual observed rows; never gap-filled.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCandle {
    pub time_utc: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: Option<f64>,
}

/// Actual first and last observed source timestamps, not an inferred bar-completion interval.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCoverage {
    pub first_time_utc: String,
    pub last_time_utc: String,
}

/// Exact inclusive/exclusive selected period used to filter source observations.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSelection {
    pub start_utc: String,
    pub end_utc_exclusive: String,
}

/// Dataset identity, source semantics and latest bounded candles returned to the renderer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPreview {
    pub dataset_id: String,
    pub sha256: String,
    pub kind: String,
    pub source_row_count: usize,
    pub selected_row_count: usize,
    pub coverage: SourceCoverage,
    pub selection: PreviewSelection,
    pub timeframe: PreviewTimeframe,
    pub source_timeframe: Option<PreviewTimeframe>,
    pub price_basis: &'static str,
    pub volume_basis: Option<&'static str>,
    pub total_candles: usize,
    pub truncated: bool,
    pub candles: Vec<MarketCandle>,
}

/// One parsed row, before its contribution is filtered into the requested period.
struct SourceRow {
    time: DateTime<Utc>,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: Option<f64>,
}

/// Known source volume location and its explicit recorded meaning.
#[derive(Clone, Copy, Debug)]
struct VolumeColumn {
    index: usize,
    basis: &'static str,
}

/// Bounded streaming aggregation state; no full file, full candle series or full row vector is retained.
struct PreviewScan {
    first: Option<DateTime<Utc>>,
    last: Option<DateTime<Utc>>,
    rows: usize,
    selected_rows: usize,
    total_candles: usize,
    current: Option<(DateTime<Utc>, MarketCandle)>,
    candles: VecDeque<MarketCandle>,
}

/// Verify imported ownership/receipt, then independently hash the exact bytes parsed for display.
pub fn preview_market_data(
    directory: &Path,
    request: MarketPreviewRequest,
) -> Result<MarketPreview, String> {
    validate_request(&request)?;
    let (path, receipt) = market_data::load_dataset(directory, &request.dataset_id)?;
    validate_source_timeframe(&request, &receipt.kind)?;
    let file = File::open(&path)
        .map_err(|error| format!("Imported history could not be opened ({error})."))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes_read = 0;
    let header = read_hashed_line(&mut reader, &mut hasher, &mut bytes_read)?
        .ok_or("Imported history has no header.")?;
    let volume = volume_column(&header)?;
    if volume.is_some_and(|column| column.index < if receipt.kind == "ticks" { 3 } else { 5 }) {
        return Err("Recorded volume must follow the timestamp and required price columns.".into());
    }
    let start = request.start_utc.as_deref().map(parse_utc).transpose()?;
    let end = request.end_utc.as_deref().map(parse_utc).transpose()?;
    let mut scan = PreviewScan {
        first: None,
        last: None,
        rows: 0,
        selected_rows: 0,
        total_candles: 0,
        current: None,
        candles: VecDeque::new(),
    };
    while let Some(line) = read_hashed_line(&mut reader, &mut hasher, &mut bytes_read)? {
        if line.trim().is_empty() {
            continue;
        }
        let row = parse_row(&line, &receipt.kind, request.tick_price, volume)
            .map_err(|error| format!("Price preview row {}: {error}", scan.rows + 2))?;
        scan.observe(row, &request, &receipt.kind, start, end)?;
    }
    scan.finish_current(request.maximum_candles);
    verify_scanned_receipt(&receipt, bytes_read, scan.rows, hasher)?;
    scan.into_preview(receipt, request, start, end, volume)
}

/// Reject excessive output, unknown source modes and non-positive or malformed UTC windows.
fn validate_request(request: &MarketPreviewRequest) -> Result<(), String> {
    if request.maximum_candles == 0 || request.maximum_candles > MAX_CANDLES {
        return Err(format!(
            "Price preview must request between 1 and {MAX_CANDLES} candles."
        ));
    }
    if request.source_timeframe == Some(PreviewTimeframe::Source) {
        return Err("Source bar timeframe must be a fixed supported interval.".into());
    }
    let start = request.start_utc.as_deref().map(parse_utc).transpose()?;
    let end = request.end_utc.as_deref().map(parse_utc).transpose()?;
    if start.zip(end).is_some_and(|(start, end)| start >= end) {
        return Err("Preview start must be before its exclusive end.".into());
    }
    Ok(())
}

/// Preserve original OHLC by default; require a real source interval before aggregating bars.
fn validate_source_timeframe(request: &MarketPreviewRequest, kind: &str) -> Result<(), String> {
    if kind == "ticks" && request.timeframe == PreviewTimeframe::Source {
        return Err("Tick preview requires a fixed chart timeframe.".into());
    }
    if kind != "bars" || request.timeframe == PreviewTimeframe::Source {
        return Ok(());
    }
    let source = request
        .source_timeframe
        .and_then(PreviewTimeframe::seconds)
        .ok_or("Select a source bar timeframe in Data settings before aggregating OHLC bars.")?;
    let target = request
        .timeframe
        .seconds()
        .ok_or("Chart timeframe must be fixed.")?;
    if target < source || target % source != 0 {
        return Err(
            "Chart timeframe cannot upsample source bars; choose the same or a coarser interval."
                .into(),
        );
    }
    Ok(())
}

/// Parse the importer's supported UTC forms, preserving fractional timestamps and explicit offsets.
fn parse_utc(value: &str) -> Result<DateTime<Utc>, String> {
    let value = value.trim();
    let parsed = DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|time| time.and_utc())
        })
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|time| time.and_utc())
        })
        .ok_or("History contains an invalid UTC timestamp.")?;
    if !(1..=9998).contains(&parsed.year()) {
        return Err("Preview dates must be between years 0001 and 9998.".into());
    }
    Ok(parsed)
}

/// Read at most one 64 KiB line while hashing original bytes, including BOM and line endings.
fn read_hashed_line(
    reader: &mut impl BufRead,
    hasher: &mut Sha256,
    bytes_read: &mut u64,
) -> Result<Option<String>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Imported history could not be read ({error})."))?;
        if available.is_empty() {
            break;
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len() + take > MAX_LINE_BYTES {
            return Err("A history row exceeds the 64 KiB preview line limit.".into());
        }
        *bytes_read += take as u64;
        if *bytes_read > MAX_IMPORT_BYTES {
            return Err("History exceeds the 64 MiB import limit.".into());
        }
        let newline = available[take - 1] == b'\n';
        hasher.update(&available[..take]);
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline {
            break;
        }
    }
    if line.is_empty() {
        return Ok(None);
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| "Imported history is not valid UTF-8.".into())
}

/// Only named volume columns establish a volume series; row count is never treated as volume.
fn volume_column(header: &str) -> Result<Option<VolumeColumn>, String> {
    let columns: Vec<_> = header
        .trim_start_matches('\u{feff}')
        .trim()
        .split(',')
        .collect();
    let matches: Vec<_> = columns
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            let name = name.trim().to_ascii_lowercase().replace(['_', ' '], "");
            match name.as_str() {
                "volume" => Some(VolumeColumn {
                    index,
                    basis: "volume",
                }),
                "tickvolume" => Some(VolumeColumn {
                    index,
                    basis: "tickVolume",
                }),
                _ => None,
            }
        })
        .collect();
    if matches.len() > 1 {
        return Err("History has ambiguous volume columns; import one explicit volume or tick-volume column.".into());
    }
    Ok(matches.first().copied())
}

/// Read finite prices and an optional explicit nonnegative recorded volume field.
fn parse_row(
    line: &str,
    kind: &str,
    tick_price: TickPrice,
    volume: Option<VolumeColumn>,
) -> Result<SourceRow, String> {
    let fields: Vec<_> = line.trim_end_matches(['\r', '\n']).split(',').collect();
    let time = parse_utc(fields.first().copied().unwrap_or_default())?;
    let recorded_volume = volume
        .map(|column| number(&fields, column.index))
        .transpose()?;
    if recorded_volume.is_some_and(|value| value < 0.0) {
        return Err("Recorded volume cannot be negative.".into());
    }
    if kind == "ticks" {
        let bid = number(&fields, 1)?;
        let ask = number(&fields, 2)?;
        if bid < 0.0 || ask < bid {
            return Err("Tick bid/ask values are invalid.".into());
        }
        let price = if tick_price == TickPrice::Bid {
            bid
        } else {
            bid + (ask - bid) / 2.0
        };
        return Ok(SourceRow {
            time,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: recorded_volume,
        });
    }
    let (open, high, low, close) = (
        number(&fields, 1)?,
        number(&fields, 2)?,
        number(&fields, 3)?,
        number(&fields, 4)?,
    );
    if high < low || high < open || high < close || low > open || low > close {
        return Err("Source OHLC values are inconsistent.".into());
    }
    if time.timestamp_subsec_nanos() % 1_000_000 != 0 {
        return Err("Source bar timestamps exceed the preview's millisecond precision.".into());
    }
    Ok(SourceRow {
        time,
        open,
        high,
        low,
        close,
        volume: recorded_volume,
    })
}

/// Refuse missing/non-finite values rather than silently manufacturing zero prices or volume.
fn number(fields: &[&str], index: usize) -> Result<f64, String> {
    let value = fields
        .get(index)
        .ok_or("History is missing a required value.")?
        .trim()
        .parse::<f64>()
        .map_err(|_| "History contains an invalid number.")?;
    if !value.is_finite() {
        return Err("History contains a non-finite number.".into());
    }
    Ok(value)
}

impl PreviewScan {
    /// Validate the full source order and coverage, then aggregate only selected observations.
    fn observe(
        &mut self,
        row: SourceRow,
        request: &MarketPreviewRequest,
        kind: &str,
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
    ) -> Result<(), String> {
        validate_order(self.last, &row, request, kind)?;
        self.first.get_or_insert(row.time);
        self.last = Some(row.time);
        self.rows += 1;
        if self.rows > MAX_IMPORT_ROWS {
            return Err("History exceeds the 5 million row import limit.".into());
        }
        if start.is_some_and(|time| row.time < time) || end.is_some_and(|time| row.time >= time) {
            return Ok(());
        }
        self.selected_rows += 1;
        let bucket = bucket_time(row.time, request.timeframe)?;
        if self
            .current
            .as_ref()
            .is_some_and(|(time, _)| *time == bucket)
        {
            return merge_candle(
                &mut self.current.as_mut().expect("current bucket exists").1,
                &row,
            );
        }
        self.finish_current(request.maximum_candles);
        self.current = Some((
            bucket,
            MarketCandle {
                time_utc: utc_text(bucket),
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
            },
        ));
        Ok(())
    }

    /// Retain only the latest requested candles while counting the entire selected series.
    fn finish_current(&mut self, maximum: usize) {
        let Some((_, candle)) = self.current.take() else {
            return;
        };
        self.total_candles += 1;
        self.candles.push_back(candle);
        if self.candles.len() > maximum {
            self.candles.pop_front();
        }
    }

    /// Bind the bounded drawing data to exact receipt identity, coverage and selected UTC period.
    fn into_preview(
        self,
        receipt: ImportedDataset,
        request: MarketPreviewRequest,
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
        volume: Option<VolumeColumn>,
    ) -> Result<MarketPreview, String> {
        let first = self
            .first
            .ok_or("Imported history contains no source observations.")?;
        let last = self
            .last
            .ok_or("Imported history contains no source observations.")?;
        let period_start = start.unwrap_or(first);
        let observed_end = Utc
            .timestamp_millis_opt(last.timestamp_millis() + 1)
            .single()
            .ok_or("Source coverage end exceeds the supported UTC range.")?;
        let period_end = end.unwrap_or(observed_end);
        validate_coverage_window(first, last, period_start, period_end)?;
        let price_basis = match (receipt.kind.as_str(), request.tick_price) {
            ("bars", _) => "sourceOhlc",
            (_, TickPrice::Bid) => "bid",
            (_, TickPrice::Mid) => "mid",
        };
        let source_timeframe = if receipt.kind == "bars" {
            request.source_timeframe
        } else {
            None
        };
        Ok(MarketPreview {
            dataset_id: receipt.id,
            sha256: receipt.sha256,
            kind: receipt.kind,
            source_row_count: self.rows,
            selected_row_count: self.selected_rows,
            coverage: SourceCoverage {
                first_time_utc: utc_text(first),
                last_time_utc: utc_text(last),
            },
            selection: PreviewSelection {
                start_utc: utc_text(period_start),
                end_utc_exclusive: utc_text(period_end),
            },
            timeframe: request.timeframe,
            source_timeframe,
            price_basis,
            volume_basis: volume.map(|column| column.basis),
            total_candles: self.total_candles,
            truncated: self.total_candles > self.candles.len(),
            candles: self.candles.into_iter().collect(),
        })
    }
}

/// Ensure ordered source rows; duplicate ticks retain file order, while duplicate/overlapping bars fail.
fn validate_order(
    previous: Option<DateTime<Utc>>,
    row: &SourceRow,
    request: &MarketPreviewRequest,
    kind: &str,
) -> Result<(), String> {
    if previous.is_some_and(|time| row.time < time) {
        return Err(
            "History is out of chronological order; reimport sorted source observations.".into(),
        );
    }
    if kind != "bars" {
        return Ok(());
    }
    if previous == Some(row.time) {
        return Err("Source bars contain duplicate timestamps.".into());
    }
    if request.timeframe == PreviewTimeframe::Source {
        return Ok(());
    }
    let seconds = request
        .source_timeframe
        .and_then(PreviewTimeframe::seconds)
        .ok_or("Source bar timeframe is required.")?;
    if row.time.timestamp().rem_euclid(seconds) != 0 || row.time.timestamp_subsec_nanos() != 0 {
        return Err(
            "Source bar timestamps do not align with the selected source timeframe.".into(),
        );
    }
    if previous.is_some_and(|time| (row.time - time).num_seconds() < seconds) {
        return Err("Source bars overlap the selected source timeframe.".into());
    }
    Ok(())
}

/// Align fixed buckets to UTC epoch boundaries; keep source-bar opening times unchanged.
fn bucket_time(time: DateTime<Utc>, timeframe: PreviewTimeframe) -> Result<DateTime<Utc>, String> {
    let Some(seconds) = timeframe.seconds() else {
        return Ok(time);
    };
    Utc.timestamp_opt(time.timestamp().div_euclid(seconds) * seconds, 0)
        .single()
        .ok_or("Candle bucket exceeds supported UTC dates.".into())
}

/// Preserve first open, maximum high, minimum low and last close; sum only recorded volume.
fn merge_candle(candle: &mut MarketCandle, row: &SourceRow) -> Result<(), String> {
    candle.high = candle.high.max(row.high);
    candle.low = candle.low.min(row.low);
    candle.close = row.close;
    candle.volume = candle
        .volume
        .zip(row.volume)
        .map(|(left, right)| left + right);
    if candle.volume.is_some_and(|value| !value.is_finite()) {
        return Err("Aggregated source volume exceeds the supported numeric range.".into());
    }
    Ok(())
}

/// Recheck the exact parsed bytes and row count to detect mutation after the initial receipt load.
fn verify_scanned_receipt(
    receipt: &ImportedDataset,
    bytes: u64,
    rows: usize,
    hasher: Sha256,
) -> Result<(), String> {
    if bytes != receipt.size_bytes
        || rows != receipt.row_count
        || format!("{:x}", hasher.finalize()) != receipt.sha256
    {
        return Err(
            "Imported history changed while previewing; reimport the original file.".into(),
        );
    }
    Ok(())
}

/// Bound exact period alternatives to full UTC calendar days containing actual observations.
fn validate_coverage_window(
    first: DateTime<Utc>,
    last: DateTime<Utc>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(), String> {
    let minimum = first
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .ok_or("Invalid source date.")?
        .and_utc();
    let maximum = last
        .date_naive()
        .succ_opt()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .ok_or("Invalid source end date.")?
        .and_utc();
    if start < minimum || end > maximum || start >= end {
        return Err("Selected UTC dates are outside imported coverage; choose All history or dates within the source extent.".into());
    }
    Ok(())
}

/// Emit UTC ISO-8601 while preserving meaningful source timestamp precision.
fn utc_text(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

#[cfg(test)]
#[path = "market_preview_tests.rs"]
mod tests;
