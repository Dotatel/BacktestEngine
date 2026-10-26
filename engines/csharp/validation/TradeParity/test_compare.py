import copy
import json
import unittest
from compare import compare


def fixture(count=100):
    native={'history':{'items':[]}, 'positions':{'items':[]}, 'equity':{'maxEquityDrawdownPercent':1}}
    local={'trades':[], 'open_positions':[], 'parameter_unknown':[], 'drawdown':{'max_equity_drawdown_percent':1}}
    for i in range(count):
        native['history']['items'].append(dict(direction='buy',symbol='XAUUSD',entryTime=1000+i*10000,
            closeTime=5000+i*10000,entryPrice=2000,closePrice=2001,volume=1,gross=1,net=.87,commissions=-.10,swaps=-.03,id=i))
        # Numeric milliseconds are accepted for both reports; real engine ISO timestamps are tested below.
        local['trades'].append(dict(side='Buy',symbol='XAUUSD',entry_time_utc=1000+i*10000,
            close_time_utc=5000+i*10000,entry_price=2000,close_price=2001,volume_in_units=1,gross_profit=1,
            net_profit=.87,commissions=-.10,swaps=-.03,id=i))
    return local,native


class ComparisonTests(unittest.TestCase):
    def test_exact(self):
        a,b=fixture();self.assertTrue(compare(a,b,.01)['passed'])
    def test_empty_never_passes(self):
        a,b=fixture(0);self.assertFalse(compare(a,b,.01)['passed'])
    def test_unmatched_trades_remain_in_denominator(self):
        a,b=fixture();a['trades']=a['trades'][:-3]
        r=compare(a,b,.01);self.assertEqual(r['denominator'],100);self.assertEqual(r['per_field_agreement']['net'],.97)
        self.assertFalse(r['passed'])
    def test_fee_errors_cannot_hide_in_large_prices_or_capital(self):
        a,b=fixture()
        for t in a['trades']: t['commissions']=-.05;t['net_profit']=.92
        r=compare(a,b,.01);self.assertEqual(r['per_field_agreement']['commission'],0)
        self.assertFalse(r['aggregate']['commission']['passed'])
    def test_entry_alignment_does_not_require_matching_exit(self):
        a,b=fixture();a['trades'][0]['close_time_utc']+=1
        r=compare(a,b,.01);self.assertEqual(r['aligned_trades'],100);self.assertEqual(r['per_field_agreement']['exit'],.99)
    def test_combined_trade_gate_not_only_per_field(self):
        a,b=fixture();a['trades'][0]['close_price']+=.1;a['trades'][1]['volume_in_units']=2;a['trades'][2]['close_time_utc']+=1
        r=compare(a,b,.01);self.assertTrue(r['gates']['every_trade_field']);self.assertFalse(r['gates']['complete_trade_agreement'])
    def test_report_order_independent_and_iso_times(self):
        a,b=fixture();b['history']['items'].reverse();a['trades'][0]['entry_time_utc']='1970-01-01T00:00:01Z'
        self.assertTrue(compare(a,b,.01)['passed'])
    def test_wrong_direction_unmatched(self):
        a,b=fixture();a['trades'][0]['side']='Sell'
        self.assertEqual(compare(a,b,.01)['aligned_trades'],99)
    def test_zero_reference_cost_requires_cent_absolute_tolerance(self):
        a,b=fixture()
        for t in b['history']['items']:t['swaps']=0
        for t in a['trades']:t['swaps']=.01
        self.assertFalse(compare(a,b,.01)['aggregate']['swap']['passed'])
    def test_open_positions_block_incomplete_comparison(self):
        a,b=fixture();a['open_positions']=[{}];self.assertFalse(compare(a,b,.01)['passed'])

    def test_all_native_execution_quotes_are_compared(self):
        a,b=fixture();events=quote_fixture(a,b)
        r=compare(a,b,.01,quote_events=events)
        self.assertTrue(r['passed'])
        self.assertEqual(r['per_field_agreement']['close_spread'],1)
        for t in a['trades'][:3]:t['entry_ask']+=.02;t['entry_spread']+=.02
        r=compare(a,b,.01,quote_events=events)
        self.assertFalse(r['passed'])
        self.assertEqual(r['per_field_agreement']['entry_spread'],.97)

    def test_missing_native_quotes_are_failures_not_dropped(self):
        a,b=fixture();events=quote_fixture(a,b)[6:]
        r=compare(a,b,.01,quote_events=events)
        self.assertFalse(r['passed'])
        self.assertEqual(r['per_field_agreement']['close_spread'],.97)
        json.dumps(r,allow_nan=False)

    def test_missing_local_quotes_are_failures_not_implicit_zero(self):
        a,b=fixture();events=quote_fixture(a,b)
        for t in a['trades']:del t['entry_spread']
        r=compare(a,b,.01,quote_events=events)
        self.assertFalse(r['passed']);self.assertEqual(r['per_field_agreement']['entry_spread'],0)
        json.dumps(r,allow_nan=False)

    def test_fixed_spread_requires_native_minute_mode(self):
        a,b=fixture();quote_fixture(a,b)
        b['main']={'data':{'type':'m1BarsFromServer'},'spread':{'type':'fixed','value':1}}
        b['usedSymbols']=[{'symbol':'XAUUSD','pipPosition':1}]
        self.assertTrue(compare(a,b,.01,native_fixed_spread=True)['passed'])
        b['main']['data']['type']='ticksFromServer'
        with self.assertRaises(ValueError):compare(a,b,.01,native_fixed_spread=True)


def quote_fixture(local,native):
    events=[]
    for a,b in zip(local['trades'],native['history']['items']):
        for prefix,kind,time,price in [('entry','opened',b['entryTime'],b['entryPrice']),
                                       ('close','closed',b['closeTime'],b['closePrice'])]:
            bid,ask=price,price+.1
            a.update({prefix+'_bid':bid,prefix+'_ask':ask,prefix+'_spread':ask-bid})
            events.append(dict(event_type=kind,position_id=b['id'],symbol=b['symbol'],side=b['direction'],
                entry_time_utc=b['entryTime'],entry_price=b['entryPrice'],volume_in_units=b['volume'],
                quote_time_utc=time,quote_status='known',bid=bid,ask=ask))
    return events

if __name__=='__main__':unittest.main()
