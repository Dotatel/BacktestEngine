use super::*;
use std::{fs, io::Cursor, path::PathBuf};
use tempfile::TempDir;

/// Import an explicit numerical fixture through the real host-owned import path.
fn imported(csv: &str, kind: &str) -> (TempDir, PathBuf, ImportedDataset) {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("source.csv");
    let storage = root.path().join("imported");
    fs::write(&original, csv).unwrap();
    let receipt =
        market_data::import_market_data(&storage, original.to_str().unwrap(), kind).unwrap();
    (root, storage, receipt)
}

/// Select bounded real-source observations with no strategy or symbol profile requirement.
fn request(receipt: &ImportedDataset, timeframe: PreviewTimeframe) -> MarketPreviewRequest {
    MarketPreviewRequest {
        dataset_id: receipt.id.clone(),
        timeframe,
        tick_price: TickPrice::Bid,
        source_timeframe: None,
        start_utc: None,
        end_utc: None,
        maximum_candles: 500,
    }
}

#[test]
fn source_ohlc_is_unchanged_and_missing_volume_stays_absent() {
    let (_root, storage, receipt) = imported("time,open,high,low,close\n2026-01-01T00:00:00Z,10,13,9,12\n2026-01-01T00:02:00Z,12,14,11,13\n", "bars");
    let preview =
        preview_market_data(&storage, request(&receipt, PreviewTimeframe::Source)).unwrap();
    assert_eq!(preview.dataset_id, receipt.id);
    assert_eq!(preview.sha256, receipt.sha256);
    assert_eq!(preview.price_basis, "sourceOhlc");
    assert_eq!(preview.volume_basis, None);
    assert_eq!(preview.candles.len(), 2);
    assert_eq!(
        (
            preview.candles[0].open,
            preview.candles[0].high,
            preview.candles[0].low,
            preview.candles[0].close
        ),
        (10.0, 13.0, 9.0, 12.0)
    );
    assert!(preview.candles.iter().all(|candle| candle.volume.is_none()));
    assert_eq!(preview.coverage.first_time_utc, "2026-01-01T00:00:00Z");
    assert_eq!(preview.coverage.last_time_utc, "2026-01-01T00:02:00Z");
    assert_eq!(
        preview.selection.end_utc_exclusive,
        "2026-01-01T00:02:00.001Z"
    );
}

#[test]
fn bars_aggregate_real_extremes_and_recorded_volume_in_utc_buckets() {
    let (_root, storage, receipt) = imported("time,open,high,low,close,volume\n2026-01-01T00:00:00Z,10,13,9,12,5\n2026-01-01T00:01:00Z,12,15,11,14,7\n2026-01-01T00:04:00Z,14,16,8,9,3\n2026-01-01T00:05:00Z,9,10,7,8,9\n", "bars");
    let mut input = request(&receipt, PreviewTimeframe::M5);
    input.source_timeframe = Some(PreviewTimeframe::M1);
    let preview = preview_market_data(&storage, input).unwrap();
    assert_eq!(preview.candles.len(), 2);
    assert_eq!(preview.total_candles, 2);
    assert_eq!(preview.volume_basis, Some("volume"));
    let first = &preview.candles[0];
    assert_eq!(
        (first.open, first.high, first.low, first.close, first.volume),
        (10.0, 16.0, 8.0, 9.0, Some(15.0))
    );
    assert_eq!(preview.candles[1].time_utc, "2026-01-01T00:05:00Z");
}

#[test]
fn ticks_retain_same_time_quote_order_and_have_explicit_bid_midpoint_policies() {
    let (_root, storage, receipt) = imported("time,bid,ask\n2026-01-01T00:00:00Z,1.2,1.4\n2026-01-01T00:00:01Z,1.1,1.3\n2026-01-01T00:00:01Z,1.4,1.6\n2026-01-01T00:00:59Z,1.3,1.5\n2026-01-01T00:01:00Z,2,2.2\n", "ticks");
    let bid = preview_market_data(&storage, request(&receipt, PreviewTimeframe::M1)).unwrap();
    assert_eq!(bid.price_basis, "bid");
    assert_eq!(
        (
            bid.candles[0].open,
            bid.candles[0].high,
            bid.candles[0].low,
            bid.candles[0].close
        ),
        (1.2, 1.4, 1.1, 1.3)
    );
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.tick_price = TickPrice::Mid;
    let mid = preview_market_data(&storage, input).unwrap();
    assert_eq!(mid.price_basis, "mid");
    assert!((mid.candles[0].open - 1.3).abs() < 1e-12);
    assert!((mid.candles[0].high - 1.5).abs() < 1e-12);
    assert!((mid.candles[0].low - 1.2).abs() < 1e-12);
    assert!((mid.candles[0].close - 1.4).abs() < 1e-12);
    assert!(mid.candles.iter().all(|candle| candle.volume.is_none()));
}

#[test]
fn start_is_inclusive_end_is_exclusive_and_coverage_remains_the_full_source() {
    let (_root, storage, receipt) = imported("time,bid,ask,tick_volume\n2026-01-01T00:00:00Z,1,2,10\n2026-01-01T00:01:00Z,2,3,20\n2026-01-01T00:02:00Z,3,4,30\n", "ticks");
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.start_utc = Some("2026-01-01T00:01:00Z".into());
    input.end_utc = Some("2026-01-01T00:02:00Z".into());
    let preview = preview_market_data(&storage, input).unwrap();
    assert_eq!(preview.source_row_count, 3);
    assert_eq!(preview.selected_row_count, 1);
    assert_eq!(preview.candles.len(), 1);
    assert_eq!(preview.candles[0].open, 2.0);
    assert_eq!(preview.candles[0].volume, Some(20.0));
    assert_eq!(preview.volume_basis, Some("tickVolume"));
    assert_eq!(preview.coverage.first_time_utc, "2026-01-01T00:00:00Z");
    assert_eq!(preview.coverage.last_time_utc, "2026-01-01T00:02:00Z");
}

#[test]
fn bounded_response_keeps_latest_candles_and_counts_the_full_selection_without_gap_fill() {
    let (_root, storage, receipt) = imported("time,bid,ask\n2026-01-01T00:00:00Z,1,2\n2026-01-01T00:02:00Z,2,3\n2026-01-01T00:07:00Z,3,4\n", "ticks");
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.maximum_candles = 2;
    let preview = preview_market_data(&storage, input).unwrap();
    assert_eq!(preview.total_candles, 3);
    assert_eq!(preview.candles.len(), 2);
    assert!(preview.truncated);
    assert_eq!(preview.candles[0].time_utc, "2026-01-01T00:02:00Z");
    assert_eq!(preview.candles[1].time_utc, "2026-01-01T00:07:00Z");
}

#[test]
fn duplicate_bars_and_out_of_order_source_are_refused() {
    let (_root, storage, receipt) = imported(
        "time,open,high,low,close\n2026-01-01T00:00:00Z,1,2,1,2\n2026-01-01T00:00:00Z,2,3,2,3\n",
        "bars",
    );
    assert!(
        preview_market_data(&storage, request(&receipt, PreviewTimeframe::Source))
            .unwrap_err()
            .contains("duplicate")
    );
    let (_root, storage, receipt) = imported(
        "time,bid,ask\n2026-01-01T00:01:00Z,1,2\n2026-01-01T00:00:00Z,2,3\n",
        "ticks",
    );
    assert!(
        preview_market_data(&storage, request(&receipt, PreviewTimeframe::M1))
            .unwrap_err()
            .contains("chronological")
    );
}

#[test]
fn bar_aggregation_requires_known_aligned_source_and_never_upsamples() {
    let (_root, storage, receipt) = imported(
        "time,open,high,low,close\n2026-01-01T00:01:00Z,1,2,1,2\n2026-01-01T00:02:00Z,2,3,2,3\n",
        "bars",
    );
    assert!(
        preview_market_data(&storage, request(&receipt, PreviewTimeframe::M5))
            .unwrap_err()
            .contains("source bar timeframe")
    );
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.source_timeframe = Some(PreviewTimeframe::M5);
    assert!(preview_market_data(&storage, input)
        .unwrap_err()
        .contains("upsample"));
    let mut input = request(&receipt, PreviewTimeframe::H1);
    input.source_timeframe = Some(PreviewTimeframe::M5);
    assert!(preview_market_data(&storage, input)
        .unwrap_err()
        .contains("align"));
}

#[test]
fn invalid_request_windows_output_limits_and_unknown_timeframes_are_rejected() {
    let (_root, storage, receipt) = imported("time,bid,ask\n2026-01-01T00:00:00Z,1,2\n", "ticks");
    for maximum in [0, 501] {
        let mut input = request(&receipt, PreviewTimeframe::M1);
        input.maximum_candles = maximum;
        assert!(preview_market_data(&storage, input)
            .unwrap_err()
            .contains("between 1 and 500"));
    }
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.start_utc = Some("2026-01-01T01:00:00Z".into());
    input.end_utc = input.start_utc.clone();
    assert!(preview_market_data(&storage, input)
        .unwrap_err()
        .contains("exclusive end"));
    let mut input = request(&receipt, PreviewTimeframe::M1);
    input.end_utc = Some("2027-01-01T00:00:00Z".into());
    assert!(preview_market_data(&storage, input)
        .unwrap_err()
        .contains("outside imported coverage"));
    assert!(serde_json::from_value::<MarketPreviewRequest>(serde_json::json!({ "datasetId": receipt.id, "timeframe": "M7", "tickPrice": "bid", "maximumCandles": 500 })).is_err());
}

#[test]
fn missing_negative_nonfinite_or_ambiguous_recorded_volume_is_not_invented() {
    for volume in ["", "-1", "NaN"] {
        let csv =
            format!("time,open,high,low,close,volume\n2026-01-01T00:00:00Z,1,2,1,2,{volume}\n");
        let (_root, storage, receipt) = imported(&csv, "bars");
        assert!(
            preview_market_data(&storage, request(&receipt, PreviewTimeframe::Source)).is_err()
        );
    }
    assert!(volume_column("time,open,high,low,close,volume,tick_volume")
        .unwrap_err()
        .contains("ambiguous"));
}

#[test]
fn integrity_tampering_and_second_scan_receipt_mismatch_are_rejected() {
    let csv = "time,bid,ask\n2026-01-01T00:00:00Z,1,2\n";
    let (_root, storage, receipt) = imported(csv, "ticks");
    fs::write(&receipt.stored_path, csv.replace(",1,2", ",2,3")).unwrap();
    assert!(
        preview_market_data(&storage, request(&receipt, PreviewTimeframe::M1))
            .unwrap_err()
            .contains("hash")
    );
    let hasher = Sha256::new_with_prefix(csv.replace(",1,2", ",2,3").as_bytes());
    assert!(
        verify_scanned_receipt(&receipt, receipt.size_bytes, receipt.row_count, hasher)
            .unwrap_err()
            .contains("changed while previewing")
    );
}

#[test]
fn line_and_total_byte_guards_bound_streaming_memory() {
    let mut reader = Cursor::new(vec![b'x'; MAX_LINE_BYTES + 1]);
    assert!(read_hashed_line(&mut reader, &mut Sha256::new(), &mut 0)
        .unwrap_err()
        .contains("64 KiB"));
    let mut reader = Cursor::new(b"x\n");
    let mut bytes = MAX_IMPORT_BYTES;
    assert!(
        read_hashed_line(&mut reader, &mut Sha256::new(), &mut bytes)
            .unwrap_err()
            .contains("64 MiB")
    );
}

#[test]
fn fractional_last_tick_at_utc_midnight_has_a_true_exclusive_millisecond_boundary() {
    let (_root, storage, receipt) = imported(
        "time,bid,ask\n2026-01-01T23:59:59.999999999Z,1,2\n",
        "ticks",
    );
    let preview = preview_market_data(&storage, request(&receipt, PreviewTimeframe::M1)).unwrap();
    assert_eq!(
        preview.coverage.last_time_utc,
        "2026-01-01T23:59:59.999999999Z"
    );
    assert_eq!(preview.selection.end_utc_exclusive, "2026-01-02T00:00:00Z");
}
