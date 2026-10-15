#!/usr/bin/env python3
"""Compare native cTrader JSON to an engine report without hiding unmatched trades."""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path


def json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def milliseconds(value):
    if isinstance(value, (float, int)):
        return round(value)
    return round(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def trades(report, native):
    if native:
        return [dict(side=t['direction'].lower(), symbol=t['symbol'],
                     entry=milliseconds(t['entryTime']), exit=milliseconds(t['closeTime']),
                     entry_price=t['entryPrice'], exit_price=t['closePrice'],
                     volume=t['volume'], gross=t['gross'], net=t['net'],
                     commission=t['commissions'], swap=t['swaps'], id=t['id'])
                for t in report['history']['items']]
    return [dict(side=t['side'].lower(), symbol=t['symbol'],
                 entry=milliseconds(t['entry_time_utc']), exit=milliseconds(t['close_time_utc']),
                 entry_price=t['entry_price'], exit_price=t['close_price'],
                 volume=t['volume_in_units'], gross=t['gross_profit'], net=t['net_profit'],
                 commission=t['commissions'], swap=t['swaps'], id=t['id'],
                 **{field: t.get(field, math.nan) for field in
                    ['entry_bid', 'entry_ask', 'entry_spread', 'close_bid', 'close_ask', 'close_spread']})
            for t in report['trades']]


def attach_quotes(native_trades, events):
    grouped = collections.defaultdict(list)
    closed = {}
    for event in events:
        if event.get('event_type') == 'opened':
            grouped[(event['symbol'], event['side'].lower(), milliseconds(event['entry_time_utc']))].append(event)
        elif event.get('event_type') == 'closed':
            if event['position_id'] in closed:
                raise ValueError('Duplicate native closing quote event')
            closed[event['position_id']] = event
    for values in grouped.values():
        values.sort(key=lambda event: event['position_id'])
    for trade in native_trades:
        candidates = grouped[(trade['symbol'], trade['side'], trade['entry'])]
        opened = candidates.pop(0) if candidates else None
        ended = closed.get(opened['position_id']) if opened else None
        for prefix, event, timestamp in [('entry', opened, trade['entry']), ('close', ended, trade['exit'])]:
            known = (event and event.get('quote_status') == 'known'
                     and milliseconds(event['quote_time_utc']) == timestamp
                     and abs(event['volume_in_units'] - trade['volume']) < 1e-8
                     and abs(event['entry_price'] - trade['entry_price']) < 1e-9)
            for side in ['bid', 'ask']:
                trade[prefix + '_' + side] = event[side] if known else math.nan
            trade[prefix + '_spread'] = trade[prefix + '_ask'] - trade[prefix + '_bid']


def load_verified_quote_events(validation_path, native_path):
    validation = json.loads(validation_path.read_text())
    def digest(path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if not (validation.get('completed') and validation.get('source_marker_verified')
            and validation.get('stop_marker_verified') and validation.get('runtime_errors') == 0
            and validation.get('plain_ledger_identity', {}).get('passed')):
        raise ValueError('Native quote capture lacks completed, error-free strategy/ledger identity verification')
    if digest(native_path) != validation['plain_native_report_sha256']:
        raise ValueError('Native reference report differs from the quote validation reference')
    for key, hash_key in [('quotes_path', 'quotes_sha256'), ('report_path', 'report_sha256'),
                          ('build_manifest_path', 'build_manifest_sha256'), ('scenario_path', 'scenario_sha256')]:
        if digest(validation[key]) != validation[hash_key]:
            raise ValueError('Native quote evidence changed: ' + key)
    return [json.loads(line) for line in Path(validation['quotes_path']).read_text().splitlines() if line.strip()]


def compare(local, native, tick_size, minimum_trades=100, time_tolerance_ms=0, threshold=.98,
            quote_events=None, native_fixed_spread=False):
    a = sorted(trades(local, False), key=lambda t: (t['entry'], t['id']))
    b = sorted(trades(native, True), key=lambda t: (t['entry'], t['id']))
    if quote_events is not None and native_fixed_spread:
        raise ValueError('Choose native tick quote evidence or a native M1 fixed-spread contract')
    quote_fields = []
    if quote_events is not None:
        attach_quotes(b, quote_events)
        quote_fields = ['entry_bid', 'entry_ask', 'entry_spread', 'close_bid', 'close_ask', 'close_spread']
    elif native_fixed_spread:
        settings = native['main']
        if settings['data']['type'] != 'm1BarsFromServer' or settings['spread']['type'] != 'fixed':
            raise ValueError('Fixed-spread evidence is only supported for native server M1 with fixed spread')
        pip_sizes = {s['symbol']: 10 ** -s['pipPosition'] for s in native['usedSymbols']}
        spread_pips = settings['spread']['value']
        if not math.isfinite(spread_pips) or spread_pips < 0:
            raise ValueError('Invalid native fixed spread')
        for trade in b:
            trade['entry_spread'] = trade['close_spread'] = spread_pips * pip_sizes[trade['symbol']]
        quote_fields = ['entry_spread', 'close_spread']
    # Entry only is the alignment key. Never align on exits, prices, fees or
    # profit, which would preferentially select the very fields being tested.
    remaining = set(range(len(a)))
    matched = []
    unmatched_native = []
    for target in b:
        choices = [i for i in remaining if a[i]['side'] == target['side']
                   and a[i]['symbol'] == target['symbol']
                   and abs(a[i]['entry'] - target['entry']) <= time_tolerance_ms]
        if not choices:
            unmatched_native.append(target)
            continue
        i = min(choices, key=lambda j: (abs(a[j]['entry'] - target['entry']), j))
        remaining.remove(i)
        matched.append((a[i], target))
    denominator = max(len(a), len(b), 1)
    tolerances = dict(entry=time_tolerance_ms, exit=time_tolerance_ms,
                      entry_price=tick_size * .5, exit_price=tick_size * .5,
                      volume=1e-8, gross=.01000001, net=.01000001,
                      commission=.01000001, swap=.01000001)
    tolerances.update({field: tick_size * .5 for field in quote_fields})
    counts = collections.Counter()
    differences = []
    complete = 0
    for ours, reference in matched:
        bad = {}
        for field, tolerance in tolerances.items():
            error = abs(ours[field] - reference[field])
            if math.isfinite(error) and error <= tolerance:
                counts[field] += 1
            else:
                bad[field] = dict(local=ours[field], native=reference[field], delta=ours[field]-reference[field])
        if bad:
            differences.append(dict(local_id=ours['id'], native_id=reference['id'], entry_ms=ours['entry'], differences=bad))
        else:
            complete += 1
    field_rates = {field: counts[field] / denominator for field in tolerances}
    aggregate = {}
    for field in ['gross', 'net', 'commission', 'swap']:
        av, bv = sum(t[field] for t in a), sum(t[field] for t in b)
        error = abs(av-bv)
        limit = max(.01, abs(bv) * (1-threshold))
        aggregate[field] = dict(local=av, native=bv, absolute_error=error, tolerance=limit, passed=error <= limit+1e-9)
    ours_open = len(local.get('open_positions', []))
    native_open = len(native.get('positions', {}).get('items', []))
    dd_local = (local.get('native_report_drawdown') or local['drawdown'])['max_equity_drawdown_percent']
    dd_native = native['equity']['maxEquityDrawdownPercent']
    aggregate['max_equity_dd_percent'] = dict(local=dd_local, native=dd_native,
        absolute_error=abs(dd_local-dd_native), tolerance=max(.01, abs(dd_native)*(1-threshold)),
        passed=abs(dd_local-dd_native) <= max(.01, abs(dd_native)*(1-threshold))+1e-9)
    gates = dict(sample_size=min(len(a), len(b)) >= minimum_trades,
                 trade_count=abs(len(a)-len(b))/denominator <= 1-threshold+1e-9,
                 aligned_entries=len(matched)/denominator >= threshold,
                 complete_trade_agreement=complete/denominator >= threshold,
                 every_trade_field=all(v >= threshold for v in field_rates.values()),
                 aggregate_economics=all(v['passed'] for v in aggregate.values()),
                 no_uncompared_open_positions=ours_open == native_open == 0,
                 no_unknown_parameters=not local.get('parameter_unknown', []))
    return json_safe(dict(passed=all(gates.values()), gates=gates, threshold=threshold,
                minimum_trades=minimum_trades, denominator=denominator,
                local_trades=len(a), native_trades=len(b), aligned_trades=len(matched),
                complete_trade_agreement=complete/denominator, per_field_agreement=field_rates,
                tolerances=tolerances, aggregate=aggregate,
                coverage=dict(native_nonzero_commission=sum(t['commission'] != 0 for t in b),
                              native_nonzero_swap=sum(t['swap'] != 0 for t in b),
                              native_buys=sum(t['side']=='buy' for t in b),
                              native_sells=sum(t['side']=='sell' for t in b)),
                unmatched_local=[a[i] for i in sorted(remaining)], unmatched_native=unmatched_native,
                matched_differences=differences,
                quote_evidence=('native execution quote capture' if quote_events is not None else
                                'native report fixed M1 spread contract' if native_fixed_spread else 'not supplied'),
                limitation=('Report comparison does not prove source/input/warmup equality; those require the case manifest.'
                            if quote_fields else 'Report comparison does not prove input, warmup or spread equality; those require the case manifest and quote evidence.')))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', type=Path, required=True)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tick-size', type=float, required=True)
    parser.add_argument('--minimum-trades', type=int, default=100)
    parser.add_argument('--time-tolerance-ms', type=int, default=0)
    quotes = parser.add_mutually_exclusive_group()
    quotes.add_argument('--native-quote-validation', type=Path)
    quotes.add_argument('--native-fixed-spread', action='store_true')
    args=parser.parse_args()
    events = load_verified_quote_events(args.native_quote_validation, args.native) if args.native_quote_validation else None
    result=compare(json.loads(args.local.read_text()), json.loads(args.native.read_text()),
                   args.tick_size, args.minimum_trades, args.time_tolerance_ms,
                   quote_events=events, native_fixed_spread=args.native_fixed_spread)
    result['reports']={k:dict(path=str(v.resolve()), sha256=hashlib.sha256(v.read_bytes()).hexdigest())
                       for k,v in [('local',args.local),('native',args.native)]}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    print(json.dumps({k:result[k] for k in ['passed','gates','local_trades','native_trades','complete_trade_agreement','per_field_agreement']}))
    return 0 if result['passed'] else 2

if __name__=='__main__':
    raise SystemExit(main())
