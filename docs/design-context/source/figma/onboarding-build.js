// Native reconstruction of approved onboarding-v3. No full-screen raster UI fills.
// Discovery: no Code Connect files; existing Button, wordmark, Manrope styles,
// brand and semantic variables resolved from the Backtest/Components pages.
const page = await figma.getNodeByIdAsync('49:7445');
await figma.setCurrentPageAsync(page);
if (page.children.some(n=>n.name.startsWith('P01 ·'))) throw new Error('Onboarding already populated; inspect before retry.');
for (const style of ['Regular','Medium','SemiBold','Bold']) await figma.loadFontAsync({family:'Manrope',style});
const vars = new Map((await figma.variables.getLocalVariablesAsync()).map(v=>[v.name,v]));
const buttonMaster = await figma.getNodeByIdAsync('4:135');
const logoMaster = await figma.getNodeByIdAsync('4:325');
const targets=[]; const screens=[]; const created=[];
const rgb=h=>({r:parseInt(h.slice(1,3),16)/255,g:parseInt(h.slice(3,5),16)/255,b:parseInt(h.slice(5,7),16)/255});
function paint(hex,token,opacity=1){let p={type:'SOLID',color:rgb(hex),opacity};if(token&&vars.has(token))p=figma.variables.setBoundVariableForPaint(p,'color',vars.get(token));return p;}
function track(n,parent,name){parent.appendChild(n);n.name=name;created.push(n.id);return n;}
function frame(parent,name,x,y,w,h,auto){const n=track(auto?figma.createAutoLayout(auto):figma.createFrame(),parent,name);n.fills=[];n.clipsContent=false;n.resize(w,h);n.x=x;n.y=y;if(auto){n.primaryAxisSizingMode='FIXED';n.counterAxisSizingMode='FIXED';n.counterAxisAlignItems='CENTER';}return n;}
function rect(parent,name,x,y,w,h,hex,radius=0,token,opacity=1){const n=track(figma.createRectangle(),parent,name);n.resize(w,h);n.x=x;n.y=y;n.cornerRadius=radius;n.fills=[paint(hex,token,opacity)];return n;}
function ellipse(parent,name,x,y,w,h,hex,opacity=1){const n=track(figma.createEllipse(),parent,name);n.resize(w,h);n.x=x;n.y=y;n.fills=hex?[paint(hex,null,opacity)]:[];return n;}
function line(parent,name,x,y,w,h,hex='#294432',opacity=.4){return rect(parent,name,x,y,Math.max(1,w),Math.max(1,h),hex,0,'brand/grid',opacity);}
async function text(parent,name,content,x,y,w,size=20,weight='Regular',color='#F4F6EE',align='CENTER',lh){const n=track(figma.createText(),parent,name);await n.setTextStyleIdAsync(size>=30?'S:96d4c8d5eb2bf56a9e45d41cf4e8af8640cc010b,':'S:477a9ad9ab2b26a1da5cccc17a5433658a079f7d,');n.fontName={family:'Manrope',style:weight};n.fontSize=size;n.characters=content;n.lineHeight={unit:'PIXELS',value:lh||Math.round(size*1.35)};n.textAlignHorizontal=align;n.textAlignVertical='CENTER';n.textAutoResize='HEIGHT';n.resize(w,lh||Math.round(size*1.35));n.x=x;n.y=y;n.fills=[paint(color,color==='#F4F6EE'?'brand/paper':color==='#080D0A'?'brand/ink':null)];return n;}
function background(parent,kind){const b=frame(parent,'Background · native grid and green glow',0,0,1672,941);b.clipsContent=true;
 const base=rect(b,'Ink / Forest',0,0,1672,941,'#080D0A',0,'brand/ink');
 if(kind==='approved'){
  const glow1=ellipse(b,'Top-left forest glow',-250,-350,1020,900,'#104823',.55);glow1.effects=[{type:'LAYER_BLUR',radius:180,visible:true}];
  const glow2=ellipse(b,'Bottom-right forest glow',1180,515,780,900,'#0F4D25',.74);glow2.effects=[{type:'LAYER_BLUR',radius:180,visible:true}];
  for(let x=106;x<1672;x+=146)line(b,'Grid vertical',x,0,1,941,'#294432',.29);
  for(let y=52;y<941;y+=139.5)line(b,'Grid horizontal',0,y,1672,1,'#294432',.29);
  for(let x=106;x<1672;x+=146)for(let y=52;y<941;y+=139.5){line(b,'Grid cross',x-5,y,11,1,'#294432',.48);line(b,'Grid cross',x,y-5,1,11,'#294432',.48);}
 } else {
  base.fills=[{type:'GRADIENT_LINEAR',gradientTransform:[[.8,.2,0],[-.2,.8,.2]],gradientStops:[{position:0,color:{...rgb('#080D0A'),a:1}},{position:.55,color:{...rgb('#0A1610'),a:1}},{position:1,color:{...rgb('#102417'),a:1}}]}];
  const glow=ellipse(b,'Central forest glow',300,80,1100,760,'#173522',.30);glow.effects=[{type:'LAYER_BLUR',radius:160,visible:true}];
  for(let x=0;x<1672;x+=88)line(b,'Grid vertical',x,0,1,941,'#294432',.29);
  for(let y=0;y<941;y+=88)line(b,'Grid horizontal',0,y,1672,1,'#294432',.29);
  for(let x=0;x<1672;x+=88)for(let y=0;y<941;y+=88){line(b,'Grid corner',x,y,8,1,'#294432',.38);line(b,'Grid corner',x,y,1,8,'#294432',.38);}
 }b.locked=true;return b;}
function logo(parent,x,y,w){const n=track(logoMaster.createInstance(),parent,'Dotatel · official wordmark');n.rescale(w/n.width);n.x=x;n.y=y;return n;}
function screen(name,x,y,kind){const s=frame(page,name,x,y,1672,941);s.clipsContent=true;s.fills=[paint('#080D0A','brand/ink')];background(s,kind);screens.push(s);return s;}
async function header(s,step,title,subtitle,big=false){const h=frame(s,'Heading and progress',286,big?157:137,1100,big?164:153,'VERTICAL');h.itemSpacing=28;
 await text(h,'Step',step,0,0,1100,20,'Medium','#B9C8CC','CENTER',28);
 const info=frame(h,'Title and description',0,0,1100,big?108:88,'VERTICAL');info.itemSpacing=6;
 await text(info,'Title',title,0,0,1100,big?52:38,'Bold','#F4F6EE','CENTER',big?68:50);
 await text(info,'Description',subtitle,0,0,1100,24,'Medium','#A9BDC2','CENTER',32);
 return h;}
function radio(parent,selected){const holder=frame(parent,selected?'Radio · selected':'Radio · unselected',0,0,34,34);const ring=ellipse(holder,'Radio ring',1,1,32,32,null);ring.strokes=[paint(selected?'#C7FF1A':'#6E7C80',selected?'brand/phosphor':null)];ring.strokeWeight=2.5;ring.strokeAlign='INSIDE';if(selected)ellipse(holder,'Selected center',8,8,18,18,'#C7FF1A').fills=[paint('#C7FF1A','brand/phosphor')];return holder;}
function art(parent,key,w,h,radius){const n=rect(parent,'Illustration · '+key,0,0,w,h,'#102417',radius);targets.push({key,id:n.id});return n;}
async function option(row,{key,label,desc,w,artw,arth,holderh,gap,selected,fs=20}){const opt=frame(row,'Option · '+label,0,0,w,holderh+gap+62+14+34,'VERTICAL');opt.itemSpacing=gap;
 const visual=frame(opt,'Preview',0,0,w,holderh,'HORIZONTAL');visual.primaryAxisAlignItems='CENTER';visual.counterAxisAlignItems='CENTER';art(visual,key,artw,arth,key==='codex'?12:key==='opencode'?0:key==='claude'?0:14);
 const lower=frame(opt,'Label, description, and radio',0,0,w,110,'VERTICAL');lower.itemSpacing=14;
 const meta=frame(lower,'Label and description',0,0,w,62,'VERTICAL');meta.itemSpacing=0;
 await text(meta,'Option name',label,0,0,w,22,'Bold','#F4F6EE','CENTER',32);
 await text(meta,'Option description',desc,0,0,w,fs,'Medium','#A9BDC2','CENTER',30);
 radio(lower,selected);return opt;}
async function button(s,label,x,y,w,h,fs=22,low=false){const n=track(buttonMaster.createInstance(),s,'Primary action · '+label);n.setProperties({'Label#4:0':label+'   →','Show icon#4:34':false});n.resize(w,h);n.x=x;n.y=y;n.cornerRadius=14;n.primaryAxisSizingMode='FIXED';n.counterAxisSizingMode='FIXED';n.primaryAxisAlignItems='CENTER';n.counterAxisAlignItems='CENTER';n.fills=[paint('#C7FF1A','brand/phosphor')];n.effects=[];
 const labelNode=n.findOne(c=>c.type==='TEXT');for(const seg of labelNode.getStyledTextSegments(['fontName']))await figma.loadFontAsync(seg.fontName);labelNode.fontName={family:'Manrope',style:'Bold'};labelNode.fontSize=fs;labelNode.lineHeight={unit:'PIXELS',value:Math.round(fs*1.35)};labelNode.fills=[paint('#080D0A','brand/ink')];if(low){n.paddingTop=22;n.paddingBottom=0;}
 return n;}
async function back(s,x=98,y=833,fs=22){return text(s,'Back','Back',x,y,90,fs,'Medium','#A9BDC2','LEFT',32);}
// P01 — original compact window, exact approved dimensions.
const s1=screen('P01 · Welcome',0,0,'classic');
const win=frame(s1,'Compact welcome window',506,235,660,470);win.clipsContent=true;win.cornerRadius=22;win.fills=[paint('#0B1510')];win.strokes=[paint('#365140')];win.strokeWeight=1.2;win.effects=[{type:'DROP_SHADOW',color:{r:0,g:0,b:0,a:.45},offset:{x:0,y:18},radius:26,spread:0,visible:true,blendMode:'NORMAL'}];
rect(win,'Native titlebar',0,0,660,56,'#101B14');line(win,'Titlebar divider',0,56,660,1);
for(const [i,c]of ['#F05A67','#F6B73C','#22C55E'].entries())ellipse(win,'Window control',20+i*22,20,12,12,c);
await text(win,'Window title','BacktestEngine',0,16,660,14,'Medium','#AAB5AC','CENTER',22);
logo(win,220,120,220);await text(win,'Welcome title','Welcome to BacktestEngine',30,191,600,29,'SemiBold','#F4F6EE','CENTER',42);
await button(win,'Get Started',214,290,232,58,17,true);await text(win,'Step','01 / 05',0,418,660,13,'Medium','#75847A','CENTER',26);
// P02 — approved Simple / Advanced reference adaptation.
const s2=screen('P02 · Workspace style',1800,0,'approved');logo(s2,60,46,186);
await header(s2,'02 / 05','How would you like BacktestEngine to look?','Choose the layout that works for you.');
const r2=frame(s2,'Workspace layout options',487,353,699,303,'HORIZONTAL');r2.itemSpacing=93;r2.counterAxisAlignItems='MIN';
await option(r2,{key:'simple',label:'Simple',desc:'Same tools, simpler interface.',w:303,artw:302,arth:169,holderh:169,gap:24,selected:true,fs:18});
await option(r2,{key:'advanced',label:'Advanced',desc:'More controls and panels in view.',w:303,artw:303,arth:169,holderh:169,gap:24,selected:false,fs:18});
await button(s2,'Continue',622,709,428,64);await back(s2);
// P03 — exact approved preview art, names/descriptions/radios underneath.
const s3=screen('P03 · Appearance',3600,0,'approved');logo(s3,60,46,186);
await header(s3,'03 / 05','Choose your appearance','You can change this anytime in Settings.',true);
const r3=frame(s3,'Appearance options',350,399,970,300,'HORIZONTAL');r3.itemSpacing=35;r3.counterAxisAlignItems='MIN';
for(const o of [{key:'system',label:'System',desc:'Follow your system settings.',artw:251,selected:true},{key:'light',label:'Light',desc:'A lighter workspace.',artw:241,selected:false},{key:'dark',label:'Dark',desc:'A darker workspace.',artw:251,selected:false}])await option(r3,{...o,w:300,arth:156,holderh:156,gap:20,fs:20});
await button(s3,'Continue',622,737,428,64);await back(s3,114,822,24);
// P04 — small supplied brand marks.
const s4=screen('P04 · Connect AI agent',900,1100,'approved');logo(s4,60,46,186);
await header(s4,'04 / 05','Connect your AI agent','Bring an agent you already use.');
const r4=frame(s4,'AI agent options',400,392,872,220,'HORIZONTAL');r4.itemSpacing=16;r4.counterAxisAlignItems='MIN';
for(const o of [{key:'codex',label:'Codex',desc:'OpenAI coding agent',artw:50,arth:50,selected:true},{key:'claude',label:'Claude Code',desc:'Anthropic coding agent',artw:51,arth:52,selected:false},{key:'opencode',label:'OpenCode',desc:'Open-source coding agent',artw:42,arth:44,selected:false}])await option(r4,{...o,w:280,holderh:82,gap:28,fs:20});
await button(s4,'Connect agent',622,707,428,64);await text(s4,'Skip for now','Skip for now',622,788,428,20,'Medium','#A9BDC2','CENTER',32);await back(s4);
// P05 — existing approved setup summary.
const s5=screen('P05 · Finish',2700,1100,'classic');logo(s5,72,38,136);await text(s5,'Step','05 / 05',1458,35,120,14,'SemiBold','#9EAAA1','RIGHT',26);
const check=track(figma.createNodeFromSvg('<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><circle cx="18" cy="18" r="16" stroke="#C7FF1A" stroke-width="2" fill="none"/><path d="m10 18 6 6 11-13" stroke="#C7FF1A" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'),s5,'Complete');check.x=818;check.y=254;
await text(s5,'Title','You’re all set',436,304,800,36,'SemiBold','#F4F6EE','CENTER',48);await text(s5,'Description','Your setup is ready.',436,357,800,17,'Regular','#9EAAA1','CENTER',32);
const summary=frame(s5,'Selected configuration',565,443,542,213,'VERTICAL');summary.itemSpacing=0;
for(const [label,value]of [['Workspace style','Simple'],['Appearance','System'],['AI agent','Skipped for now']]){const row=frame(summary,'Summary · '+label,0,0,542,71,'VERTICAL');row.itemSpacing=0;line(row,'Row separator',0,0,542,1);const content=frame(row,'Label and value',0,0,542,70,'HORIZONTAL');content.paddingLeft=25;content.paddingRight=25;content.paddingTop=25;content.paddingBottom=15;content.primaryAxisAlignItems='SPACE_BETWEEN';content.counterAxisAlignItems='CENTER';await text(content,'Setting',label,0,0,250,16,'Medium','#9EAAA1','LEFT',30);await text(content,'Value',value,0,0,242,16,'SemiBold','#F4F6EE','RIGHT',30);}
await button(s5,'Open BacktestEngine',1290,824,300,58,17);await text(s5,'Back','‹  Back',64,852,120,16,'Medium','#B4BDB6','LEFT',32);
// All mutations and native descendants returned for provenance.
const allIds=[...new Set([page.id,...screens.flatMap(s=>[s.id,...s.findAll(()=>true).map(n=>n.id)])])];
return {createdNodeIds:allIds,mutatedNodeIds:[page.id],page:{id:page.id,name:page.name},screens:screens.map(s=>({id:s.id,name:s.name,width:s.width,height:s.height,textNodes:s.findAllWithCriteria({types:['TEXT']}).length})),imageTargets:targets,nodeCount:allIds.length};
