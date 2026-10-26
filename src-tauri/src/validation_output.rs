//! Authenticate the app-owned strict transport without changing the retained engine's raw report or verdict.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) const PYTHON_BOOTSTRAP: &str = include_str!("../optimizer-host/ValidationOutput.py");
const MARKER: &str = "BACKTESTENGINE_VALIDATION_OUTPUT_SHA256 ";
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ANNOTATIONS: usize = 500_007;
const MAX_NODES: usize = 8_000_000;
const MAX_DEPTH: usize = 64;

/// A retained literal positive Infinity is unavailable as a JSON number, with exact pointer provenance.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NonFiniteAnnotation {
    pub pointer: String,
    pub token: String,
    pub meaning: String,
    pub origin: String,
}

/// Only the trusted wrapper's stdout digest authorizes these sidecar bytes and annotations.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u32,
    original_sha256: String,
    payload: Value,
    non_finite: Vec<NonFiniteAnnotation>,
}

/// Existing consumers retain the original numerical verdict; hashes and annotations describe its transport only.
pub(crate) struct VerifiedOutput {
    pub payload: Value,
    pub original_sha256: String,
    pub envelope_sha256: String,
    pub non_finite: Vec<NonFiniteAnnotation>,
}

/// Verify captured stdout, bounded strict sidecar, unchanged original bytes and every declared null annotation.
pub(crate) fn verify(
    original: &[u8],
    sidecar: &[u8],
    stdout: &str,
) -> Result<VerifiedOutput, String> {
    if original.is_empty()
        || sidecar.is_empty()
        || original.len() > MAX_BYTES
        || sidecar.len() > MAX_BYTES
    {
        return Err("Validation original/adapter output is empty or exceeds 64 MiB.".into());
    }
    let envelope_sha256 = digest(sidecar);
    if marker_digest(stdout)? != envelope_sha256 {
        return Err("Validation adapter output differs from the captured wrapper digest.".into());
    }
    let envelope: Envelope = serde_json::from_slice(sidecar)
        .map_err(|error| format!("Validation adapter output is malformed ({error})."))?;
    if envelope.version != 1 || envelope.original_sha256 != digest(original) {
        return Err("Validation original output differs from its adapter provenance.".into());
    }
    validate_payload(&envelope.payload)?;
    validate_annotations(&envelope)?;
    if let Ok(finite) = serde_json::from_slice::<Value>(original) {
        if finite != envelope.payload || !envelope.non_finite.is_empty() {
            return Err(
                "A finite original output cannot acquire changed values or non-finite annotations."
                    .into(),
            );
        }
    }
    Ok(VerifiedOutput {
        payload: envelope.payload,
        original_sha256: envelope.original_sha256,
        envelope_sha256,
        non_finite: envelope.non_finite,
    })
}

/// Missing, duplicate or malformed markers never authorize a sidecar left by another or interrupted process.
fn marker_digest(stdout: &str) -> Result<String, String> {
    let markers: Vec<_> = stdout
        .lines()
        .filter(|line| line.starts_with(MARKER.trim_end()))
        .collect();
    if markers.len() != 1 {
        return Err("Validation wrapper must announce exactly one output digest.".into());
    }
    let value = markers[0]
        .strip_prefix(MARKER)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("Validation wrapper output digest is malformed.")?;
    Ok(value.to_ascii_lowercase())
}

/// Validate structural bounds and only known statistical field types, leaving retained schema interpretation to consumers.
fn validate_payload(payload: &Value) -> Result<(), String> {
    if !payload.is_object() {
        return Err("Validation adapter payload must be an object.".into());
    }
    let mut pending = vec![(payload, String::new(), 0usize)];
    let mut nodes = 0usize;
    while let Some((value, pointer, depth)) = pending.pop() {
        nodes += 1;
        if depth > MAX_DEPTH || nodes > MAX_NODES {
            return Err("Validation adapter payload exceeds its structural bound.".into());
        }
        if statistic_pointer(payload, &pointer) && !value.is_null() && !value.is_number() {
            return Err("Validation profit factor has an unsupported type.".into());
        }
        queue_children(value, &pointer, depth, &mut pending);
    }
    Ok(())
}

/// Traverse decoded JSON iteratively with canonical escaped pointers, avoiding application recursion.
fn queue_children<'a>(
    value: &'a Value,
    pointer: &str,
    depth: usize,
    pending: &mut Vec<(&'a Value, String, usize)>,
) {
    match value {
        Value::Object(values) => pending.extend(values.iter().map(|(key, value)| {
            (
                value,
                format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1")),
                depth + 1,
            )
        })),
        Value::Array(values) => pending.extend(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| (value, format!("{pointer}/{index}"), depth + 1)),
        ),
        _ => (),
    }
}

/// Every annotation is unique, uses one evidenced token, addresses an allowed actual null and has bounded text.
fn validate_annotations(envelope: &Envelope) -> Result<(), String> {
    if envelope.non_finite.len() > MAX_ANNOTATIONS {
        return Err("Validation non-finite annotation count exceeds its bound.".into());
    }
    let mut seen = BTreeSet::new();
    for item in &envelope.non_finite {
        if item.token != "Infinity"
            || item.meaning != "positiveUnbounded"
            || item.origin != "retainedProfitFactor"
            || item.pointer.len() > 128
            || !seen.insert(&item.pointer)
            || !statistic_pointer(&envelope.payload, &item.pointer)
            || !envelope
                .payload
                .pointer(&item.pointer)
                .is_some_and(Value::is_null)
        {
            return Err("Validation non-finite annotation is unsupported, duplicated or does not address an actual allowed null.".into());
        }
    }
    Ok(())
}

/// Match exact retained PF locations, requiring actual array indices rather than lookalike object member names.
fn statistic_pointer(payload: &Value, pointer: &str) -> bool {
    let parts: Vec<_> = pointer.split('/').collect();
    match parts.as_slice() {
        ["", "combined_report" | "latency_report" | "walk_forward_report", "profit_factor"] => true,
        ["", "monte_carlo", "distributions", index, "pf"] => {
            actual_array_index(payload, "/monte_carlo/distributions", index)
        }
        ["", "monte_carlo", "concentration", "remove_best", index, "pf"] => {
            actual_array_index(payload, "/monte_carlo/concentration/remove_best", index)
        }
        _ => false,
    }
}

/// Canonical decimal indices must exist in a genuine list; signs and leading-zero aliases are rejected.
fn actual_array_index(payload: &Value, pointer: &str, index: &str) -> bool {
    let Ok(parsed) = index.parse::<usize>() else {
        return false;
    };
    parsed.to_string() == index
        && payload
            .pointer(pointer)
            .and_then(Value::as_array)
            .is_some_and(|items| items.get(parsed).is_some())
}

/// Hash actual bytes rather than a reserialized approximation of original numerical output.
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "validation_output_tests.rs"]
mod tests;
