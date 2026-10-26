
const F={"createdNodeIds":["3:2","3:93","3:94"],"mutatedNodeIds":["0:1"],"pages":{"Backtest":"0:1","Components":"3:2"},"wrappers":{"Dark":"3:93","Light":"3:94"},"collections":{"primitives":"VariableCollectionId:3:3","light":"VariableCollectionId:3:4","dark":"VariableCollectionId:3:5","dimensions":"VariableCollectionId:3:73"},"themeVars":{"Light":{"app":"VariableID:3:35","panel":"VariableID:3:36","sidebar":"VariableID:3:37","input":"VariableID:3:38","foreground":"VariableID:3:39","muted":"VariableID:3:40","border":"VariableID:3:41","grid":"VariableID:3:42","primary":"VariableID:3:43","onPrimary":"VariableID:3:44","positive":"VariableID:3:45","negative":"VariableID:3:46","link":"VariableID:3:47","selected":"VariableID:3:48","selectedText":"VariableID:3:49","hover":"VariableID:3:50","volumeUp":"VariableID:3:51","volumeDown":"VariableID:3:52","warning":"VariableID:3:53"},"Dark":{"app":"VariableID:3:54","panel":"VariableID:3:55","sidebar":"VariableID:3:56","input":"VariableID:3:57","foreground":"VariableID:3:58","muted":"VariableID:3:59","border":"VariableID:3:60","grid":"VariableID:3:61","primary":"VariableID:3:62","onPrimary":"VariableID:3:63","positive":"VariableID:3:64","negative":"VariableID:3:65","link":"VariableID:3:66","selected":"VariableID:3:67","selectedText":"VariableID:3:68","hover":"VariableID:3:69","volumeUp":"VariableID:3:70","volumeDown":"VariableID:3:71","warning":"VariableID:3:72"}},"dimensionVars":{"space/2":"VariableID:3:74","space/4":"VariableID:3:75","space/6":"VariableID:3:76","space/8":"VariableID:3:77","space/12":"VariableID:3:78","space/16":"VariableID:3:79","space/20":"VariableID:3:80","space/24":"VariableID:3:81","space/32":"VariableID:3:82","radius/4":"VariableID:3:83","radius/6":"VariableID:3:84","radius/8":"VariableID:3:85","radius/12":"VariableID:3:86"},"styles":{"Caption":"S:6cf61337f67ba4249cd56c8cc52e88e143db4d7f,","Body":"S:00074cc43f2f99fd4003b4711dbccfa7b1ee3f40,","Control":"S:73ecabb95fb4c497f348c2e8044d72beab79245b,","Text":"S:477a9ad9ab2b26a1da5cccc17a5433658a079f7d,","Title":"S:09521cf616ceb3e22905e013f997301dec7ed12b,","Button":"S:64d687f0f63676155e9b209f8ea90d2a9e62cfab,"},"variableCount":80,"font":"Manrope","modeStrategy":"Separate single-mode Light and Dark collections for Starter plan"};
await Promise.all(["Regular","Medium","SemiBold","Bold"].map(style=>figma.loadFontAsync({family:"Manrope",style})));
const V={},D={};
await Promise.all(Object.entries(F.themeVars.Dark).map(async([k,id])=>{V[k]=await figma.variables.getVariableByIdAsync(id);}));
await Promise.all(Object.entries(F.dimensionVars).map(async([k,id])=>{D[k]=await figma.variables.getVariableByIdAsync(id);}));
function paint(role,opacity=1){return figma.variables.setBoundVariableForPaint({type:"SOLID",color:{r:0,g:0,b:0},opacity},"color",V[role]);}
function fills(n,role,opacity=1){n.fills=role?[paint(role,opacity)]:[];}
function stroke(n,role){n.strokes=role?[paint(role)]:[];if(role)n.strokeWeight=1;}
function radius(n,size=6){for(const k of ["topLeftRadius","topRightRadius","bottomLeftRadius","bottomRightRadius"])n.setBoundVariable(k,D["radius/"+size]);}
function gap(n,v=8){n.setBoundVariable("itemSpacing",D["space/"+v]);}
function padding(n,l=12,r=12,t=8,b=8){for(const [k,v]of Object.entries({paddingLeft:l,paddingRight:r,paddingTop:t,paddingBottom:b}))n.setBoundVariable(k,D["space/"+v]);}
function auto(parent,name,dir,w,h){const n=figma.createAutoLayout(dir);parent.appendChild(n);n.name=name;n.resize(w,h);n.primaryAxisSizingMode="FIXED";n.counterAxisSizingMode="FIXED";n.itemSpacing=0;fills(n,null);return n;}
function txt(parent,value,style="Body",role="foreground",width){const n=figma.createText();n.fontName={family:"Manrope",style:"Regular"};n.textStyleId=F.styles[style];n.characters=value;n.name=value.slice(0,50)||"Text";n.fills=[paint(role)];parent.appendChild(n);if(width!==undefined){n.textAutoResize="HEIGHT";n.resize(width,n.height);n.layoutSizingHorizontal="FIXED";}return n;}
function recolorIcon(node,role){for(const n of [node,...node.findAll(()=>true)]){if(n.type==="FRAME"){n.fills=[];continue;}for(const field of ["fills","strokes"]){if(field in n && Array.isArray(n[field]) && n[field].some(p=>p.type==="SOLID"))n[field]=n[field].map(p=>p.type==="SOLID"?{...p,...paint(role,p.opacity??1),visible:p.visible??true}:p);}}}

const W={"Header":{"id":"6:12","width":1600,"height":64,"descendants":55},"Navigation":{"id":"6:86","width":72,"height":856,"descendants":43},"Strategy parameters":{"id":"6:142","width":252,"height":856,"descendants":45},"Backtest controls":{"id":"6:195","width":888,"height":80,"descendants":72},"Price chart":{"id":"6:277","width":888,"height":424,"descendants":516},"Trade results":{"id":"6:803","width":888,"height":336,"descendants":138},"Assistant":{"id":"6:971","width":348,"height":856,"descendants":56},"Status footer":{"id":"6:1059","width":1600,"height":24,"descendants":4}};
const page=await figma.getNodeByIdAsync(F.pages.Backtest);await figma.setCurrentPageAsync(page);
const masters={};await Promise.all(Object.entries(W).map(async([name,data])=>masters[name]=await figma.getNodeByIdAsync(data.id)));
const lightV={};await Promise.all(Object.entries(F.themeVars.Light).map(async([k,id])=>lightV[k]=await figma.variables.getVariableByIdAsync(id)));
const oldToRole=Object.fromEntries(Object.entries(F.themeVars.Dark).map(([k,id])=>[id,k]));
function applyLight(root){for(const n of [root,...root.findAll(()=>true)])for(const field of ["fills","strokes"]){if(!(field in n)||!Array.isArray(n[field]))continue;let changed=false;const paints=n[field].map(p=>{const role=oldToRole[p.boundVariables?.color?.id];if(p.type==="SOLID"&&role){changed=true;return figma.variables.setBoundVariableForPaint(p,"color",lightV[role]);}return p;});if(changed)n[field]=paints;}}
function place(parent,name){const n=masters[name].createInstance();parent.appendChild(n);n.name=name;return n;}
const screens={};
for(const theme of ["Light"]){
const root=await figma.getNodeByIdAsync(F.wrappers[theme]);if(root.children.length)throw new Error("Wrapper already populated: "+theme);
place(root,"Header");
const body=auto(root,"Workspace columns","HORIZONTAL",1600,872);padding(body,8,8,8,8);gap(body,8);
place(body,"Navigation");place(body,"Strategy parameters");
const center=auto(body,"Backtest research content","VERTICAL",888,856);gap(center,8);place(center,"Backtest controls");place(center,"Price chart");place(center,"Trade results");
place(body,"Assistant");place(root,"Status footer");
if(theme==="Light")applyLight(root);
const nodes=[root,...root.findAll(()=>true)];const counts={};for(const n of nodes)counts[n.type]=(counts[n.type]||0)+1;
const imageNodes=nodes.filter(n=>Array.isArray(n.fills)&&n.fills.some(p=>p.type==="IMAGE")).map(n=>({id:n.id,name:n.name,type:n.type,width:n.width,height:n.height}));
const fonts=[...new Set(nodes.filter(n=>n.type==="TEXT").flatMap(n=>n.getStyledTextSegments(["fontName"]).map(s=>s.fontName.family)))];
if(fonts.some(f=>f!=="Manrope"))throw new Error("Unexpected product font: "+fonts.join(","));
const layoutOverflows=nodes.filter(n=>n.parent&&"layoutMode"in n.parent&&n.parent.layoutMode!=="NONE"&&n.layoutPositioning!=="ABSOLUTE"&&(n.x<-1||n.y<-1||n.x+n.width>n.parent.width+1||n.y+n.height>n.parent.height+1)).map(n=>({id:n.id,name:n.name,parent:n.parent.name,x:n.x,y:n.y,w:n.width,h:n.height,parentW:n.parent.width,parentH:n.parent.height}));
screens[theme]={id:root.id,name:root.name,width:root.width,height:root.height,nodeCount:nodes.length,nodeTypes:counts,imageNodes,fonts,layoutOverflows};
}
return {createdNodeIds:[F.wrappers["Light"]].flatMap(id=>{const r=figma.currentPage.children.find(n=>n.id===id);return r.findAll(()=>true).map(n=>n.id);}),mutatedNodeIds:[F.wrappers["Light"]],screens};
