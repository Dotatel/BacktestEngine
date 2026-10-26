#!/usr/bin/env python3
"""Build an explicit replay contract from native symbol, schedule and fee captures."""
import argparse
import hashlib
import json
from pathlib import Path


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def build(source_path, report_path, fee_path, output, family):
    source_path,report_path,fee_path,output=map(lambda p:Path(p).resolve(),[source_path,report_path,fee_path,output])
    s=json.loads(source_path.read_text());r=json.loads(report_path.read_text());f=json.loads(fee_path.read_text())
    u=next(x for x in r['usedSymbols'] if x['symbol']==s['symbol'])
    if s['quote_asset'] != s['account_asset']:
        raise ValueError('This capture builder requires quote currency == account currency; a cross-currency conversion contract must be defined separately.')
    assert s['symbol']==f['symbol'] and s['commission']==f['commission_rate']
    assert f['held_out_passed'] if 'held_out_passed' in f else all(c['passed'] for c in f['cases'])
    output.parent.mkdir(parents=True,exist_ok=True)
    authority=output.with_suffix('.swap-authority.json')
    a=dict(schema_version='backtestengine.swap-authority/v1',authority_status='AUTHENTICATED',
        authority_kind='ctrader_generated_report_used_symbols',symbol=s['symbol'],account_currency=s['account_asset'],
        account_type=r['main']['accountType'],account_leverage=r['main']['accountLeverage'],report_utc_offset_hours=r['main']['utcOffset'],
        swap_time_utc=u['swapTime']+':00',swap_period_hours=u['swapPeriods'],swap_grace_periods=u['gracePeriods'],
        swap_weekend_charging=u['weekendSwaps'],swap_3_days_rollover=u['threeDaySwaps'].title(),
        swap_calculation_type=u['swapCalculationType'].title(),source_report_relative_path=str(report_path),source_report_sha256=sha(report_path))
    authority.write_text(json.dumps(a,indent=2)+'\n')
    d=dict(schema_version='backtestengine.economic-symbol/v2',specification_source='runtime-verified NativeParityProbe capture',
        specification_source_kind='ctrader_symbol_capture',specification_source_path=str(source_path),specification_source_sha256=sha(source_path),
        symbol=s['symbol'],asset_family=family,base_currency=s['base_asset'],quote_currency=s['quote_asset'],
        account_currency=s['account_asset'],account_currency_digits=s['account_digits'],digits=s['digits'],
        pip_size=s['pip_size'],tick_size=s['tick_size'],pip_value=s['pip_value'],pip_value_currency=s['account_asset'],
        tick_value=s['tick_value'],tick_value_currency=s['account_asset'],lot_size=s['lot_size'],contract_multiplier=s['lot_size'],
        volume_in_units_min=s['volume_in_units_min'],volume_in_units_max=s['volume_in_units_max'],volume_in_units_step=s['volume_in_units_step'],
        volume_units='base_or_contract_units',commission_model=s['commission_type'],commission_rate=s['commission'],
        commission_rate_currency='USD',commission_side_semantics='PerFill',minimum_commission=s['min_commission'],
        minimum_commission_currency=s['min_commission_asset'],commission_rounding_mode='CurrencyCent',
        quote_to_account_conversion_model='Identity',quote_to_account_conversion_rate=1,
        usd_notional_conversion_rule='fixed_base_to_usd',commission_base_to_usd_rate=f['fixed_base_to_usd_rate'],
        commission_conversion_authority_path=str(fee_path),commission_conversion_authority_sha256=sha(fee_path),
        native_commission_end_utc=f['requested_native_end_utc'],pnl_conversion_fee_rate=s['pnl_conversion_fee_rate'],
        swap_calculation_type=s['swap_calculation_type'],swap_long=s['swap_long'],swap_short=s['swap_short'],
        swap_time_utc=a['swap_time_utc'],swap_3_days_rollover=s['swap_3_days_rollover'],percentage_swap_day_count=365,
        swap_time_authority_status='Authenticated',swap_time_authority_kind=a['authority_kind'],
        swap_time_authority_path=str(authority),swap_time_authority_sha256=sha(authority),
        swap_period_hours=u['swapPeriods'],swap_grace_periods=u['gracePeriods'],swap_weekend_charging=u['weekendSwaps'])
    output.write_text(json.dumps(d,indent=2)+'\n')
    return output

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['source','report','fee','output']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--family',choices=['Fx','Metal','Index','Equity','Crypto'],required=True)
    a=p.parse_args();print(build(a.source,a.report,a.fee,a.output,a.family))
