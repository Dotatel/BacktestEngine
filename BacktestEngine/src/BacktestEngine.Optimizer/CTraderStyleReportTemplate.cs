namespace BacktestEngine.Optimizer;

internal static class CTraderStyleReportTemplate
{
    public static string Render(string payloadJson)
    {
        return Html.Replace("{{REPORT_DATA}}", payloadJson, StringComparison.Ordinal);
    }

    private const string Html = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Historical Replay Report | BacktestEngine</title>
  <style>
    :root{--bg:#17191d;--panel:#202329;--panel2:#262a31;--line:#343941;--muted:#9299a6;--text:#eef1f5;--green:#49c887;--green2:#1d8d5c;--red:#ef6a70;--orange:#f0a45d;--blue:#5d9cec;--shadow:0 12px 28px #0003}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
    a{color:inherit;text-decoration:none}.shell{min-height:100vh}.topbar{height:58px;display:flex;align-items:center;gap:20px;padding:0 28px;background:#22252a;border-bottom:1px solid #30343b;position:sticky;top:0;z-index:20;box-shadow:0 4px 16px #0003}
    .brand{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;white-space:nowrap}.mark{width:27px;height:27px;border:2px solid var(--green);border-radius:7px;display:grid;place-items:center;color:var(--green);font-size:14px}.brand small{color:var(--muted);font-weight:500}
    .nav{display:flex;gap:2px;height:100%;overflow:auto}.nav a{display:flex;align-items:center;padding:0 14px;color:#aeb4be;border-bottom:2px solid transparent;white-space:nowrap}.nav a:hover,.nav a.active{color:white;border-color:var(--green)}
    .status{margin-left:auto;display:flex;align-items:center;gap:8px;color:#b6bdc7}.dot{width:8px;height:8px;background:var(--green);border-radius:50%;box-shadow:0 0 0 4px #49c8871c}
    main{max-width:1560px;margin:auto;padding:26px 30px 70px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:22px}.eyebrow{color:var(--green);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.hero h1{font-size:30px;line-height:1.15;margin:5px 0 7px}.sub{color:var(--muted)}.candidate{padding:11px 14px;border:1px solid var(--line);background:#1d2025;border-radius:7px;color:#b6bdc7;text-align:right}.candidate strong{display:block;color:white;font-size:13px}
    .alert{display:none;padding:12px 14px;margin-bottom:18px;background:#4a2024;border:1px solid #7c333b;color:#ffd9dc;border-radius:6px}.section{scroll-margin-top:76px;margin-top:24px}.section-head{display:flex;align-items:flex-end;justify-content:space-between;margin:0 0 12px}.section-head h2{font-size:17px;margin:0}.section-head p{margin:0;color:var(--muted);font-size:12px}
    .kpis{display:grid;grid-template-columns:repeat(6,minmax(135px,1fr));gap:10px}.kpi{background:var(--panel);border:1px solid #2c3037;border-radius:6px;padding:15px 16px;box-shadow:0 3px 10px #0001}.kpi .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em}.kpi .value{font-size:22px;font-weight:680;margin-top:5px}.kpi .foot{font-size:11px;color:#747c88;margin-top:3px}.positive{color:var(--green)!important}.negative{color:var(--red)!important}.neutral{color:var(--text)!important}
    .panel{background:var(--panel);border:1px solid #2d3138;border-radius:7px;box-shadow:var(--shadow);overflow:hidden}.panel-title{display:flex;justify-content:space-between;align-items:center;padding:15px 18px;border-bottom:1px solid var(--line)}.panel-title h3{font-size:14px;margin:0}.panel-title span{font-size:11px;color:var(--muted)}
    .chart-wrap{height:350px;padding:14px 16px 8px;position:relative}.chart-wrap canvas{width:100%;height:100%;display:block}.chart-tooltip{position:absolute;display:none;pointer-events:none;background:#101216eF;border:1px solid #414752;border-radius:5px;padding:8px 10px;font-size:11px;color:#d8dde5;box-shadow:0 6px 18px #0007}.chart-legend{display:flex;gap:18px;padding:0 18px 15px;color:var(--muted);font-size:12px}.legend-line{display:inline-block;width:20px;height:2px;background:var(--green);vertical-align:middle;margin-right:7px}
    .two-col{display:grid;grid-template-columns:1.55fr .85fr;gap:14px}.stats-grid{display:grid;grid-template-columns:repeat(3,1fr)}.stat-group{padding:6px 18px 15px;border-right:1px solid var(--line)}.stat-group:last-child{border-right:0}.stat-group h4{font-size:11px;color:#cbd0d8;text-transform:uppercase;letter-spacing:.08em;margin:12px 0 8px}.stat-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #2b2f35}.stat-row:last-child{border:0}.stat-row span:first-child{color:var(--muted)}
    .month-list{padding:10px 18px 16px}.month{display:grid;grid-template-columns:70px 1fr 74px;gap:10px;align-items:center;padding:6px 0}.bar{height:7px;background:#30353d;border-radius:5px;overflow:hidden}.bar i{display:block;height:100%;border-radius:5px;background:var(--green)}.month .loss{background:var(--red)}
    .toolbar{display:flex;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}input{background:#171a1f;border:1px solid #3a3f48;color:white;border-radius:5px;padding:8px 10px;outline:none;min-width:260px}input:focus{border-color:var(--green)}.pill{border:1px solid #3a3f48;border-radius:5px;padding:7px 10px;color:var(--muted)}
    .table-wrap{overflow:auto;max-height:560px}table{width:100%;border-collapse:collapse}th{position:sticky;top:0;background:#272b32;color:#aeb5bf;font-size:11px;text-transform:uppercase;letter-spacing:.04em;text-align:right;padding:10px 12px;border-bottom:1px solid #3b4048;white-space:nowrap;cursor:pointer}th:first-child,th:nth-child(2),th:nth-child(3),td:first-child,td:nth-child(2),td:nth-child(3){text-align:left}td{padding:9px 12px;border-bottom:1px solid #2c3036;text-align:right;white-space:nowrap;color:#d9dde3}tbody tr:hover{background:#282c33}.side-buy{color:#78b6ff}.side-sell{color:#f1a46b}.tag{display:inline-block;border:1px solid #3c424c;border-radius:4px;padding:2px 6px;color:#cbd1da;font-size:11px}
    .params{display:grid;grid-template-columns:repeat(3,1fr)}.param{display:flex;justify-content:space-between;gap:14px;padding:9px 13px;border-right:1px solid #2f333a;border-bottom:1px solid #2f333a}.param:nth-child(3n){border-right:0}.param span:first-child{color:var(--muted);overflow:hidden;text-overflow:ellipsis}.param strong{font-weight:550}.artifact-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:16px}.artifact{padding:12px 13px;background:#272b31;border:1px solid #393e47;border-radius:5px}.artifact:hover{border-color:var(--green);background:#2a3035}.artifact strong{display:block}.artifact small{color:var(--muted)}
    .footer{color:#707783;text-align:center;padding:26px}.empty{padding:30px;text-align:center;color:var(--muted)}
    @media(max-width:1120px){.kpis{grid-template-columns:repeat(3,1fr)}.two-col{grid-template-columns:1fr}.stats-grid{grid-template-columns:1fr}.stat-group{border-right:0;border-bottom:1px solid var(--line)}.params{grid-template-columns:repeat(2,1fr)}.param:nth-child(3n){border-right:1px solid #2f333a}.param:nth-child(2n){border-right:0}}
    @media(max-width:700px){.topbar{padding:0 14px}.nav{display:none}.status{display:none}main{padding:20px 12px 50px}.hero{align-items:flex-start;flex-direction:column}.candidate{text-align:left}.kpis{grid-template-columns:repeat(2,1fr)}.params{grid-template-columns:1fr}.param{border-right:0!important}.artifact-grid{grid-template-columns:repeat(2,1fr)}.chart-wrap{height:285px}}
    @media print{.topbar{position:static}.nav,.toolbar{display:none}body{background:white;color:#111}.panel,.kpi{box-shadow:none;break-inside:avoid}.table-wrap{max-height:none}}
  </style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand"><span class="mark">K</span> BacktestEngine <small>Replay Report</small></div>
    <nav class="nav"><a href="#summary" class="active">Summary</a><a href="#equity">Balance</a><a href="#statistics">Statistics</a><a href="#trades">Trades</a><a href="#parameters">Parameters</a><a href="#artifacts">Artifacts</a></nav>
    <div class="status"><span class="dot"></span><span id="statusText">Completed</span></div>
  </header>
  <main>
    <div class="hero">
      <div><div class="eyebrow">Historical replay</div><h1 id="title">ExampleStrategy · XAUUSD</h1><div class="sub" id="subtitle"></div></div>
      <div class="candidate"><strong id="candidateId"></strong><span id="candidateMeta"></span></div>
    </div>
    <div class="alert" id="errorBox"></div>

    <section class="section" id="summary">
      <div class="section-head"><h2>Performance summary</h2><p>Marked to market at replay end</p></div>
      <div class="kpis" id="kpis"></div>
    </section>

    <section class="section panel" id="equity">
      <div class="panel-title"><h3>Closed-trade balance curve</h3><span>Intratrade equity movement is summarized in drawdown metrics below</span></div>
      <div class="chart-wrap"><canvas id="balanceChart"></canvas><div class="chart-tooltip" id="chartTip"></div></div>
      <div class="chart-legend"><span><i class="legend-line"></i>Balance</span><span id="chartRange"></span></div>
    </section>

    <section class="section two-col" id="statistics">
      <div class="panel"><div class="panel-title"><h3>Trade and risk statistics</h3><span>All values include costs</span></div><div class="stats-grid" id="statsGrid"></div></div>
      <div class="panel"><div class="panel-title"><h3>Monthly closed P/L</h3><span id="monthCount"></span></div><div class="month-list" id="monthList"></div></div>
    </section>

    <section class="section panel" id="trades">
      <div class="panel-title"><h3>Trade history</h3><span id="tradeCount"></span></div>
      <div class="toolbar"><input id="tradeSearch" placeholder="Search trades, dates or close reasons"><span class="pill" id="tradeFilterLabel">All trades</span></div>
      <div class="table-wrap"><table id="tradeTable"><thead><tr><th data-key="id">ID</th><th data-key="side">Side</th><th data-key="entry_time_utc">Entry time</th><th data-key="close_time_utc">Close time</th><th data-key="volume_in_units">Volume</th><th data-key="entry_price">Entry</th><th data-key="close_price">Close</th><th data-key="pips">Pips</th><th data-key="gross_profit">Gross</th><th data-key="commissions">Commission</th><th data-key="swaps">Swap</th><th data-key="net_profit">Net</th><th data-key="close_reason">Reason</th></tr></thead><tbody></tbody></table></div>
    </section>

    <section class="section panel" id="parameters">
      <div class="panel-title"><h3>Candidate parameters</h3><span id="paramCount"></span></div>
      <div class="toolbar"><input id="paramSearch" placeholder="Filter parameters"></div><div class="params" id="paramGrid"></div>
    </section>

    <section class="section panel" id="artifacts">
      <div class="panel-title"><h3>Run artifacts</h3><span>Portable files saved with this report</span></div><div class="artifact-grid" id="artifactGrid"></div>
    </section>
    <div class="footer">Generated by BacktestEngine · self-contained report · no external services</div>
  </main>
</div>
<script>
const data={{REPORT_DATA}};
const r=data.report||{}, account=r.account||{}, stats=r.trade_statistics||{}, dd=r.native_report_drawdown||r.drawdown||{}, risk=r.risk_path||{}, life=r.lifecycle_statistics||{}, replay=r.replay||{}, open=r.open_risk||{};
let trades=[...(r.trades||[])];
const $=id=>document.getElementById(id);
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(n(v));
const number=(v,d=2)=>Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{maximumFractionDigits:d}):'—';
const pct=v=>number(v,2)+'%';
const dt=v=>v?new Date(v).toLocaleString('en-GB',{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'UTC'}).replace(',','')+' UTC':'—';
const dateOnly=v=>v?new Date(v).toLocaleDateString('en-GB',{year:'numeric',month:'short',day:'2-digit',timeZone:'UTC'}):'—';
const cls=v=>n(v)>0?'positive':n(v)<0?'negative':'neutral';
const duration=(a,b)=>{if(!a||!b)return'—';const h=(new Date(b)-new Date(a))/36e5;if(h<1)return Math.round(h*60)+'m';if(h<48)return number(h,1)+'h';return number(h/24,1)+'d'};
const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function initHeader(){
  $('title').textContent=(r.strategy||'ExampleStrategy')+' · '+(r.symbol||data.scenario.symbol||'');
  const from=replay.first_time_utc, to=replay.last_time_utc;
  const timeframe=String(data.scenario.timeframe||r.timeframe||'').toUpperCase();
  $('subtitle').textContent=[timeframe,from&&to?dateOnly(from)+' — '+dateOnly(to):'',replay.mode?replay.mode+' data':''].filter(Boolean).join('  ·  ');
  $('candidateId').textContent=data.candidate.id;
  $('candidateMeta').textContent='Hash '+data.candidate.hash+' · Fitness '+number(data.candidate.fitness_score,6);
  $('statusText').textContent=data.scenario.status;
  if(data.scenario.error){$('errorBox').style.display='block';$('errorBox').textContent=data.scenario.error}
}

function renderKpis(){
  const pf=stats.profit_factor==null?(n(stats.gross_profit)>0&&n(stats.gross_loss)===0?'∞':'—'):number(stats.profit_factor,3);
  const winRate=n(stats.total_trades)?100*n(stats.winning_trades)/n(stats.total_trades):0;
  const items=[
    ['Net profit',money(account.marked_to_market_net_profit),cls(account.marked_to_market_net_profit),'Closed '+money(account.closed_net_profit)],
    ['Return',pct(account.marked_to_market_return_percent),cls(account.marked_to_market_return_percent),'Starting '+money(account.starting_capital)],
    ['Ending equity',money(account.equity),cls(n(account.equity)-n(account.starting_capital)),'Balance '+money(account.balance)],
    ['Profit factor',pf,n(stats.gross_profit)>0?'positive':'neutral','Gross loss '+money(stats.gross_loss)],
    ['Max equity DD',pct(dd.max_equity_drawdown_percent),'negative',money(dd.max_equity_drawdown)],
    ['Trades',number(stats.total_trades,0),'neutral',number(stats.winning_trades,0)+' won · '+number(stats.losing_trades,0)+' lost'],
    ['Win rate',pct(winRate),winRate>=50?'positive':'negative','Average '+money(stats.average_net_profit)],
    ['Recovery',dd.max_equity_drawdown>0?number(n(account.marked_to_market_net_profit)/n(dd.max_equity_drawdown),2):'—','neutral','Fitness '+number(data.candidate.fitness_score,6)],
    ['Largest win',money(stats.largest_win),cls(stats.largest_win),'Largest loss '+money(n(stats.losing_trades)>0?stats.largest_loss:0)],
    ['Avg duration',number(life.average_closed_duration_hours,1)+'h','neutral','P95 '+number(life.p95_closed_duration_hours,1)+'h'],
    ['Open P/L',money(open.open_net_profit),cls(open.open_net_profit),number(open.position_count,0)+' position(s)'],
    ['Replay speed',number(replay.ticks_or_synthetic_ticks_per_second,0)+'/s','neutral',number(replay.input_count,0)+' events']
  ];
  $('kpis').innerHTML=items.map(x=>`<div class="kpi"><div class="label">${x[0]}</div><div class="value ${x[2]}">${x[1]}</div><div class="foot">${x[3]}</div></div>`).join('');
}

function statRows(title,items){return `<div class="stat-group"><h4>${title}</h4>${items.map(x=>`<div class="stat-row"><span>${x[0]}</span><strong class="${x[2]||''}">${x[1]}</strong></div>`).join('')}</div>`}
function renderStats(){
  const winRate=n(stats.total_trades)?100*n(stats.winning_trades)/n(stats.total_trades):0;
  $('statsGrid').innerHTML=
    statRows('Performance', [['Gross profit',money(stats.gross_profit),'positive'],['Gross loss',money(stats.gross_loss),'negative'],['Net profit',money(stats.net_profit),cls(stats.net_profit)],['Average trade',money(stats.average_net_profit),cls(stats.average_net_profit)],['Total pips',number(stats.total_pips,1),cls(stats.total_pips)]])+
    statRows('Trades', [['Total',number(stats.total_trades,0)],['Winning',number(stats.winning_trades,0),'positive'],['Losing',number(stats.losing_trades,0),'negative'],['Long / Short',number(stats.long_trades,0)+' / '+number(stats.short_trades,0)],['Win rate',pct(winRate),winRate>=50?'positive':'negative']])+
    statRows('Risk & lifecycle', [[r.native_report_drawdown?'Native report equity DD':'Max equity DD',money(dd.max_equity_drawdown),'negative'],['Full-path equity DD',pct((r.drawdown||{}).max_equity_drawdown_percent),'negative'],['Intraday DD',pct(risk.max_intraday_equity_drawdown_percent),'negative'],['Day-start loss',pct(risk.max_day_start_equity_loss_percent),'negative'],['Max duration',number(life.max_closed_duration_hours,1)+'h'],['Max open age',number(open.max_position_age_hours,1)+'h']]);
}

function balancePoints(){
  const ordered=[...trades].filter(t=>t.close_time_utc).sort((a,b)=>new Date(a.close_time_utc)-new Date(b.close_time_utc));
  let bal=n(account.starting_capital), first=replay.first_time_utc||(ordered[0]?.entry_time_utc)||new Date().toISOString();
  const out=[{time:new Date(first),value:bal,trade:null}];
  ordered.forEach(t=>{bal+=n(t.net_profit);out.push({time:new Date(t.close_time_utc),value:bal,trade:t})});
  if(replay.last_time_utc&&out.length&&new Date(replay.last_time_utc)>out[out.length-1].time)out.push({time:new Date(replay.last_time_utc),value:bal,trade:null});
  return out;
}

function renderChart(){
  const canvas=$('balanceChart'), wrap=canvas.parentElement, tip=$('chartTip'), points=balancePoints();
  $('chartRange').textContent=money(points[0]?.value)+' → '+money(points.at(-1)?.value);
  function draw(){
    const dpr=Math.min(devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight;canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,w,h);
    const pad={l:68,r:22,t:18,b:38},cw=w-pad.l-pad.r,ch=h-pad.t-pad.b;if(cw<=0||ch<=0||!points.length)return;
    const times=points.map(p=>p.time.getTime()), vals=points.map(p=>p.value),minT=Math.min(...times),maxT=Math.max(...times)||minT+1;let minV=Math.min(...vals),maxV=Math.max(...vals);const vr=Math.max(1,maxV-minV);minV-=vr*.12;maxV+=vr*.12;
    const x=t=>pad.l+(t-minT)/(maxT-minT||1)*cw,y=v=>pad.t+(maxV-v)/(maxV-minV)*ch;
    c.font='11px system-ui';c.textBaseline='middle';c.strokeStyle='#343941';c.fillStyle='#7f8793';c.lineWidth=1;
    for(let i=0;i<=5;i++){const yy=pad.t+ch*i/5;c.beginPath();c.moveTo(pad.l,yy);c.lineTo(w-pad.r,yy);c.stroke();const val=maxV-(maxV-minV)*i/5;c.textAlign='right';c.fillText(money(val),pad.l-10,yy)}
    for(let i=0;i<=4;i++){const xx=pad.l+cw*i/4;c.beginPath();c.moveTo(xx,pad.t);c.lineTo(xx,h-pad.b);c.stroke();const d=new Date(minT+(maxT-minT)*i/4);c.textAlign=i===0?'left':i===4?'right':'center';c.fillText(d.toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'}),xx,h-14)}
    c.beginPath();points.forEach((p,i)=>{const xx=x(p.time.getTime()),yy=y(p.value);i?c.lineTo(xx,yy):c.moveTo(xx,yy)});c.lineTo(x(points.at(-1).time.getTime()),h-pad.b);c.lineTo(x(points[0].time.getTime()),h-pad.b);c.closePath();const g=c.createLinearGradient(0,pad.t,0,h-pad.b);g.addColorStop(0,'rgba(73,200,135,.30)');g.addColorStop(1,'rgba(73,200,135,.015)');c.fillStyle=g;c.fill();
    c.beginPath();points.forEach((p,i)=>{const xx=x(p.time.getTime()),yy=y(p.value);i?c.lineTo(xx,yy):c.moveTo(xx,yy)});c.strokeStyle='#49c887';c.lineWidth=2;c.stroke();
    canvas._chart={points,x,y,pad,w,h};
  }
  canvas.addEventListener('mousemove',e=>{const q=canvas._chart;if(!q)return;const rect=canvas.getBoundingClientRect(),mx=e.clientX-rect.left;let best=q.points[0],dist=Infinity;q.points.forEach(p=>{const d=Math.abs(q.x(p.time.getTime())-mx);if(d<dist){dist=d;best=p}});tip.style.display='block';tip.style.left=Math.min(q.w-170,Math.max(10,q.x(best.time.getTime())+12))+'px';tip.style.top=Math.max(8,q.y(best.value)-52)+'px';tip.innerHTML=`<strong>${money(best.value)}</strong><br>${dt(best.time)}${best.trade?'<br>Trade #'+best.trade.id+' · '+money(best.trade.net_profit):''}`});
  canvas.addEventListener('mouseleave',()=>tip.style.display='none');new ResizeObserver(draw).observe(wrap);draw();
}

function renderMonths(){
  const months={};trades.forEach(t=>{if(!t.close_time_utc)return;const k=t.close_time_utc.slice(0,7);months[k]=(months[k]||0)+n(t.net_profit)});const list=Object.entries(months).sort();$('monthCount').textContent=list.length+' active month(s)';if(!list.length){$('monthList').innerHTML='<div class="empty">No closed trades</div>';return}const max=Math.max(1,...list.map(x=>Math.abs(x[1])));$('monthList').innerHTML=list.map(([k,v])=>`<div class="month"><span>${new Date(k+'-01T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'2-digit',timeZone:'UTC'})}</span><div class="bar"><i class="${v<0?'loss':''}" style="width:${Math.max(2,Math.abs(v)/max*100)}%"></i></div><strong class="${cls(v)}">${money(v)}</strong></div>`).join('')
}

let tradeSort={key:'close_time_utc',asc:true};
function renderTrades(){
  const q=$('tradeSearch').value.toLowerCase();const filtered=trades.filter(t=>JSON.stringify(t).toLowerCase().includes(q));filtered.sort((a,b)=>{const x=a[tradeSort.key],y=b[tradeSort.key];const cmp=(typeof x==='number'&&typeof y==='number')?x-y:String(x??'').localeCompare(String(y??''));return tradeSort.asc?cmp:-cmp});
  $('tradeCount').textContent=filtered.length+' of '+trades.length+' trades';$('tradeTable').tBodies[0].innerHTML=filtered.map(t=>`<tr><td>${number(t.id,0)}</td><td class="side-${String(t.side).toLowerCase()}">${escapeHtml(t.side)}</td><td>${dt(t.entry_time_utc)}</td><td>${dt(t.close_time_utc)}<br><small style="color:#777">${duration(t.entry_time_utc,t.close_time_utc)}</small></td><td>${number(t.volume_in_units,0)}</td><td>${number(t.entry_price,5)}</td><td>${number(t.close_price,5)}</td><td class="${cls(t.pips)}">${number(t.pips,1)}</td><td class="${cls(t.gross_profit)}">${money(t.gross_profit)}</td><td>${money(t.commissions)}</td><td>${money(t.swaps)}</td><td class="${cls(t.net_profit)}"><strong>${money(t.net_profit)}</strong></td><td><span class="tag">${escapeHtml(t.close_reason)}</span></td></tr>`).join('')||'<tr><td colspan="13" class="empty">No matching trades</td></tr>';
}

function formatParam(v){const s=String(v);if(/^(true|false)$/i.test(s))return s.toLowerCase();if(/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)&&Number.isFinite(Number(s)))return Number(s).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:8});return s}
function renderParams(){const q=$('paramSearch').value.toLowerCase(),entries=Object.entries(data.parameters||{}).filter(([k,v])=>(k+' '+v).toLowerCase().includes(q));$('paramCount').textContent=entries.length+' of '+Object.keys(data.parameters||{}).length; $('paramGrid').innerHTML=entries.map(([k,v])=>`<div class="param"><span title="${escapeHtml(k)}">${escapeHtml(k)}</span><strong title="${escapeHtml(v)}">${escapeHtml(formatParam(v))}</strong></div>`).join('')}
function renderArtifacts(){const labels={report_json:['JSON report','Raw replay metrics'],events_json:['Events','Structured lifecycle events'],trades_csv:['Trades CSV','Closed trade ledger'],open_positions_csv:['Open positions','End-of-run exposure'],parameters_cbotset:['Parameters','Scenario cBot set'],candidate_cbotset:['Candidate','Complete cBot set'],log:['Execution log','Runner output']};$('artifactGrid').innerHTML=Object.entries(data.artifacts||{}).map(([k,v])=>`<a class="artifact" href="${encodeURI(v)}"><strong>${labels[k]?.[0]||k}</strong><small>${labels[k]?.[1]||v}</small></a>`).join('')}

document.querySelectorAll('#tradeTable th').forEach(th=>th.addEventListener('click',()=>{const key=th.dataset.key;tradeSort={key,asc:tradeSort.key===key?!tradeSort.asc:true};renderTrades()}));
$('tradeSearch').addEventListener('input',renderTrades);$('paramSearch').addEventListener('input',renderParams);
initHeader();renderKpis();renderStats();renderChart();renderMonths();renderTrades();renderParams();renderArtifacts();
</script>
</body>
</html>
""";
}
