/**
 * createVariableCollection
 *
 * Creates a new Figma variable collection with the specified name and modes.
 * If `modeNames` has more than one entry, the first mode is renamed from
 * Figma's default "Mode 1" to the first name, and additional modes are added.
 *
 * @param {string} name - The display name of the collection (e.g. "Color", "Spacing").
 * @param {string[]} modeNames - Ordered list of mode names (e.g. ["Light", "Dark"] or ["Value"]).
 * @returns {Promise<{
 *   collection: VariableCollection,
 *   modeIds: Record<string, string>
 * }>}
 *   `modeIds` maps each mode name to its modeId string.
 */
async function createVariableCollection(name, modeNames) {
  if (!modeNames || modeNames.length === 0) {
    throw new Error('createVariableCollection: modeNames must have at least one entry.')
  }

  // Create the collection — Figma always creates it with one mode named "Mode 1".
  const existing = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === name)
  const collection = existing || figma.variables.createVariableCollection(name)

  // modeIds accumulator
  const modeIds = {}

  // Rename the default first mode
  const defaultMode = collection.modes[0]
  collection.renameMode(defaultMode.modeId, modeNames[0])
  modeIds[modeNames[0]] = defaultMode.modeId

  // Add additional modes
  for (let i = 1; i < modeNames.length; i++) {
    const newModeId = collection.addMode(modeNames[i])
    modeIds[modeNames[i]] = newModeId
  }

  return { collection, modeIds }
}
/**
 * createSemanticTokens
 *
 * Creates a batch of Figma variables in the given collection, one per entry in
 * `tokenMap`. Supports raw values, variable alias references, code syntax, and
 * scopes. Returns a map of token name → Variable for use in subsequent steps.
 *
 * @param {VariableCollection} collection - The target variable collection.
 * @param {Record<string, string>} modeIds - Map of {modeName: modeId} from createVariableCollection.
 * @param {Array<{
 *   name: string,
 *   type: 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'TIMING' | 'EASING',
 *   values: Record<string, string | number | boolean | MotionEasing | {type: 'VARIABLE_ALIAS', id: string}>,
 *   scopes?: VariableScope[],
 *   codeSyntax?: {WEB?: string, ANDROID?: string, iOS?: string}
 * }>} tokenMap - Ordered list of token definitions.
 *   - `name`: Variable name using slash hierarchy (e.g. "color/bg/primary").
 *   - `type`: Figma variable type.
 *   - `values`: Map of {modeName: value}. Values can be raw (hex string for COLOR,
 *     number for FLOAT) or alias objects {type: 'VARIABLE_ALIAS', id: variableId}.
 *     For COLOR, raw values are accepted as hex strings ("#rrggbb" or "#rrggbbaa")
 *     and converted to {r, g, b, a} automatically.
 *   - `scopes`: Array of VariableScope strings. Omit to use [] (hidden/primitive).
 *   - `codeSyntax`: Platform code syntax strings. Omit to skip.
 * @returns {Promise<{variables: Record<string, Variable>}>}
 *   `variables` maps each token name to its created Variable object.
 */
async function createSemanticTokens(collection, modeIds, tokenMap) {
  const variables = {}

  for (const token of tokenMap) {
    // Create the variable
    const variable = figma.variables.createVariable(token.name, collection, token.type)

    // Set values for each mode
    for (const [modeName, rawValue] of Object.entries(token.values)) {
      const modeId = modeIds[modeName]
      if (!modeId) {
        throw new Error(
          `createSemanticTokens: mode "${modeName}" not found in modeIds for token "${token.name}". ` +
            `Available modes: ${Object.keys(modeIds).join(', ')}`,
        )
      }

      let value = rawValue

      // Convert hex strings to Figma RGBA for COLOR type
      if (token.type === 'COLOR' && typeof rawValue === 'string' && rawValue.startsWith('#')) {
        value = hexToFigmaColor(rawValue)
      }

      variable.setValueForMode(modeId, value)
    }

    // Set scopes (default: empty array = hidden from property pickers / primitives)
    variable.scopes = token.scopes || []

    // Set code syntax per platform
    if (token.codeSyntax) {
      if (token.codeSyntax.WEB) {
        variable.setVariableCodeSyntax('WEB', token.codeSyntax.WEB)
      }
      if (token.codeSyntax.ANDROID) {
        variable.setVariableCodeSyntax('ANDROID', token.codeSyntax.ANDROID)
      }
      if (token.codeSyntax.iOS) {
        variable.setVariableCodeSyntax('iOS', token.codeSyntax.iOS)
      }
    }

    variables[token.name] = variable
  }

  return { variables }
}

/**
 * Converts a hex color string to a Figma RGBA object.
 * Supports "#rgb", "#rrggbb", and "#rrggbbaa".
 *
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
function hexToFigmaColor(hex) {
  let h = hex.replace('#', '')

  // Expand shorthand #rgb → #rrggbb
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }

  const r = parseInt(h.substring(0, 2), 16) / 255
  const g = parseInt(h.substring(2, 4), 16) / 255
  const b = parseInt(h.substring(4, 6), 16) / 255
  const a = h.length === 8 ? parseInt(h.substring(6, 8), 16) / 255 : 1

  return { r, g, b, a }
}

const page=await figma.getNodeByIdAsync("0:1");await figma.setCurrentPageAsync(page);page.name="Backtest";
let components=figma.root.children.find(p=>p.name==="Components");if(!components){components=figma.createPage();components.name="Components";}
const prim=await createVariableCollection("Dotatel Primitives",["Value"]);
const light=await createVariableCollection("Dotatel Color Light",["Value"]),dark=await createVariableCollection("Dotatel Color Dark",["Value"]);
const raw={ink:"#080D0A",forest:"#102417",paper:"#F4F6EE",phosphor:"#C7FF1A",steel:"#5E6961",mist:"#DDE2D8",grid:"#294432",white:"#FFFFFF",darkPanel:"#0C1811",darkInput:"#0D1D14",darkMuted:"#A4B5A9",darkGrid:"#182E21",darkPositive:"#00D5AA",lightPositive:"#087D47",darkNegative:"#F05A67",lightNegative:"#C33B47",darkLink:"#8DCDFF",lightLink:"#245F98",darkSelected:"#193322",lightSelected:"#E7EFDC",lightSidebar:"#F0F4EB",lightGrid:"#E8EDE4",darkHover:"#18301F",lightHover:"#EDF3E8",volumeUpDark:"#1C7D61",volumeUpLight:"#A3D7BD",volumeDownDark:"#833C43",volumeDownLight:"#E9A7AD",warning:"#F6B73C"};
const {variables:pv}=await createSemanticTokens(prim.collection,prim.modeIds,Object.entries(raw).map(([name,value])=>({name:"brand/"+name,type:"COLOR",values:{Value:value},scopes:[],codeSyntax:{WEB:"var(--brand-"+name.replace(/[A-Z]/g,m=>"-"+m.toLowerCase())+")"}})));
const roleMap={app:["paper","ink"],panel:["white","darkPanel"],sidebar:["lightSidebar","forest"],input:["white","darkInput"],foreground:["ink","paper"],muted:["steel","darkMuted"],border:["mist","grid"],grid:["lightGrid","darkGrid"],primary:["phosphor","phosphor"],onPrimary:["ink","ink"],positive:["lightPositive","darkPositive"],negative:["lightNegative","darkNegative"],link:["lightLink","darkLink"],selected:["lightSelected","darkSelected"],selectedText:["forest","phosphor"],hover:["lightHover","darkHover"],volumeUp:["volumeUpLight","volumeUpDark"],volumeDown:["volumeDownLight","volumeDownDark"],warning:["warning","warning"]};
const themeVars={};
for(const [theme,index,col] of [["Light",0,light],["Dark",1,dark]]){
const {variables:vars}=await createSemanticTokens(col.collection,col.modeIds,Object.entries(roleMap).map(([name,pair])=>({name:"color/"+name,type:"COLOR",values:{Value:{type:"VARIABLE_ALIAS",id:pv["brand/"+pair[index]].id}},scopes:["FRAME_FILL","SHAPE_FILL","TEXT_FILL","STROKE_COLOR"],codeSyntax:{WEB:"var(--color-"+name.replace(/[A-Z]/g,m=>"-"+m.toLowerCase())+")"}})));
themeVars[theme]=Object.fromEntries(Object.entries(vars).map(([n,v])=>[n.split("/")[1],v.id]));
}
const dims=await createVariableCollection("Dotatel Dimensions",["Value"]);
const numTokens=[2,4,6,8,12,16,20,24,32].map(n=>({name:"space/"+n,type:"FLOAT",values:{Value:n},scopes:["GAP"],codeSyntax:{WEB:"var(--space-"+n+")"}})).concat([4,6,8,12].map(n=>({name:"radius/"+n,type:"FLOAT",values:{Value:n},scopes:["CORNER_RADIUS"],codeSyntax:{WEB:"var(--radius-"+n+")"}})));
const {variables:dv}=await createSemanticTokens(dims.collection,dims.modeIds,numTokens);
await Promise.all(["Regular","Medium","SemiBold","Bold"].map(style=>figma.loadFontAsync({family:"Manrope",style})));
const styles={};
for(const [name,size,line,style] of [["Caption",11,16,"Regular"],["Body",12,18,"Regular"],["Control",13,20,"Medium"],["Text",14,22,"Regular"],["Title",16,24,"SemiBold"],["Button",13,20,"SemiBold"]]){
const s=figma.createTextStyle();s.name="Dotatel/"+name;s.fontName={family:"Manrope",style};s.fontSize=size;s.lineHeight={unit:"PIXELS",value:line};styles[name]=s.id;
}
const wrappers={};
for(const [theme,x] of [["Dark",200],["Light",1960]]){
const f=figma.createAutoLayout("VERTICAL");page.appendChild(f);f.name="Backtest / "+theme;f.resize(1600,960);f.primaryAxisSizingMode="FIXED";f.counterAxisSizingMode="FIXED";f.x=x;f.y=160;f.itemSpacing=0;const v=await figma.variables.getVariableByIdAsync(themeVars[theme].app);f.fills=[figma.variables.setBoundVariableForPaint({type:"SOLID",color:{r:0,g:0,b:0}},"color",v)];f.clipsContent=true;wrappers[theme]=f.id;
}
return {createdNodeIds:[components.id,...Object.values(wrappers)],mutatedNodeIds:[page.id],pages:{Backtest:page.id,Components:components.id},wrappers,collections:{primitives:prim.collection.id,light:light.collection.id,dark:dark.collection.id,dimensions:dims.collection.id},themeVars,dimensionVars:Object.fromEntries(Object.entries(dv).map(([n,v])=>[n,v.id])),styles,variableCount:Object.keys(pv).length+38+Object.keys(dv).length,font:"Manrope",modeStrategy:"Separate single-mode Light and Dark collections for Starter plan"};
