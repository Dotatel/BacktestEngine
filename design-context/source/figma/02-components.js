
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
/**
 * createComponentWithVariants
 *
 * Creates a component set by generating all combinations of `variantAxes`,
 * building one Figma component per combination, then calling
 * `figma.combineAsVariants` to produce the component set. After combining,
 * the variants are repositioned into a grid so they don't all stack at (0, 0).
 *
 * @param {{
 *   name: string,
 *   description?: string,
 *   variantAxes: Record<string, string[]>,
 *   baseProps: {
 *     width: number,
 *     height: number,
 *     fills?: Paint[],
 *     padding?: {top?: number, bottom?: number, left?: number, right?: number},
 *     radius?: number,
 *     layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE',
 *     itemSpacing?: number
 *   },
 *   page: PageNode
 * }} config
 *   - `name`: Component set name (e.g. "Button").
 *   - `description`: Optional human-readable purpose and usage guidance.
 *   - `variantAxes`: Each key is a variant property name; each value is an array of
 *     allowed values. All combinations are generated (Cartesian product).
 *     Example: { Size: ['Small', 'Medium', 'Large'], Style: ['Primary', 'Ghost'] }
 *     produces 6 variants.
 *   - `baseProps`: Visual properties applied to every variant.
 *   - `page`: The PageNode to create components on (must be set as current page by caller).
 * @returns {Promise<{
 *   componentSet: ComponentSetNode,
 *   variants: ComponentNode[]
 * }>}
 */
async function createComponentWithVariants(config) {
  const { name, variantAxes, baseProps, page } = config

  // Ensure we are on the correct page


  // Compute Cartesian product of variant axes
  const axisNames = Object.keys(variantAxes)
  const axisValues = axisNames.map((k) => variantAxes[k])
  const combinations = cartesianProduct(axisValues)

  // Build one component per combination
  const components = []
  for (const combo of combinations) {
    const comp = figma.createComponent()

    // Name: "Property=Value, Property=Value, ..."
    comp.name = axisNames.map((ax, i) => `${ax}=${combo[i]}`).join(', ')

    // Base geometry
    comp.resize(baseProps.width, baseProps.height)

    // Fills
    if (baseProps.fills !== undefined) {
      comp.fills = baseProps.fills
    } else {
      comp.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }]
    }

    // Corner radius
    if (baseProps.radius !== undefined) {
      comp.cornerRadius = baseProps.radius
    }

    // Auto-layout
    if (baseProps.layoutMode && baseProps.layoutMode !== 'NONE') {
      comp.layoutMode = baseProps.layoutMode
      comp.primaryAxisAlignItems = 'CENTER'
      comp.counterAxisAlignItems = 'CENTER'
      if (baseProps.itemSpacing !== undefined) {
        comp.itemSpacing = baseProps.itemSpacing
      }
    }

    // Padding
    if (baseProps.padding) {
      comp.paddingTop = baseProps.padding.top ?? 0
      comp.paddingBottom = baseProps.padding.bottom ?? 0
      comp.paddingLeft = baseProps.padding.left ?? 0
      comp.paddingRight = baseProps.padding.right ?? 0
    }

    page.appendChild(comp)
    components.push(comp)
  }

  // Combine into a component set
  const componentSet = figma.combineAsVariants(components, page)
  componentSet.name = name
  if (config.description) {
    componentSet.description = config.description
  }

  // Grid layout — variants stack at (0, 0) after combineAsVariants; reposition them.
  const GRID_GAP = 16
  const cols = Math.max(1, axisValues[axisValues.length - 1]?.length ?? 1)
  const variantWidth = baseProps.width
  const variantHeight = baseProps.height

  componentSet.children.forEach((variant, idx) => {
    const col = idx % cols
    const row = Math.floor(idx / cols)
    variant.x = col * (variantWidth + GRID_GAP)
    variant.y = row * (variantHeight + GRID_GAP)
  })

  // Resize component set to wrap its children with padding
  const totalCols = Math.min(cols, combinations.length)
  const totalRows = Math.ceil(combinations.length / cols)
  const PADDING = 40
  componentSet.resize(
    totalCols * variantWidth + (totalCols - 1) * GRID_GAP + PADDING * 2,
    totalRows * variantHeight + (totalRows - 1) * GRID_GAP + PADDING * 2,
  )

  // Position component set at a safe canvas location
  componentSet.x = 480
  componentSet.y = 80

  return { componentSet, variants: componentSet.children }
}

/**
 * Computes the Cartesian product of multiple arrays.
 * cartesianProduct([[A, B], [1, 2]]) → [[A,1], [A,2], [B,1], [B,2]]
 *
 * @param {Array<string[]>} arrays
 * @returns {string[][]}
 */
function cartesianProduct(arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((combo) => curr.map((val) => [...combo, val])),
    [[]],
  )
}

const page=await figma.getNodeByIdAsync(F.pages.Components);await figma.setCurrentPageAsync(page);page.backgrounds=[{type:"SOLID",color:{r:0.035,g:0.065,b:0.043}}];
if(page.children.length)throw new Error("Component page already contains content; inspect before retry");
const iconSVGs={"folder-open":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-folder-open\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\" />\n</svg>\n","chart-no-axes-combined":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-chart-no-axes-combined\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M12 16v5\" />\n  <path d=\"M16 14.639V21\" />\n  <path d=\"M20 10.656V21\" />\n  <path d=\"m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15\" />\n  <path d=\"M4 18.463V21\" />\n  <path d=\"M8 14.656V21\" />\n</svg>\n","database":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-database\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\" />\n  <path d=\"M3 5V19A9 3 0 0 0 21 19V5\" />\n  <path d=\"M3 12A9 3 0 0 0 21 12\" />\n</svg>\n","braces":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-braces\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1\" />\n  <path d=\"M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1\" />\n</svg>\n","puzzle":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-puzzle\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z\" />\n</svg>\n","settings-2":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-settings-2\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M14 17H5\" />\n  <path d=\"M19 7h-9\" />\n  <circle cx=\"17\" cy=\"17\" r=\"3\" />\n  <circle cx=\"7\" cy=\"7\" r=\"3\" />\n</svg>\n","chevron-down":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-chevron-down\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m6 9 6 6 6-6\" />\n</svg>\n","chevron-left":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-chevron-left\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m15 18-6-6 6-6\" />\n</svg>\n","chevron-right":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-chevron-right\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m9 18 6-6-6-6\" />\n</svg>\n","plus":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-plus\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M5 12h14\" />\n  <path d=\"M12 5v14\" />\n</svg>\n","save":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-save\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\" />\n  <path d=\"M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7\" />\n  <path d=\"M7 3v4a1 1 0 0 0 1 1h7\" />\n</svg>\n","play":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-play\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\" />\n</svg>\n","sun":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-sun\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <circle cx=\"12\" cy=\"12\" r=\"4\" />\n  <path d=\"M12 2v2\" />\n  <path d=\"M12 20v2\" />\n  <path d=\"m4.93 4.93 1.41 1.41\" />\n  <path d=\"m17.66 17.66 1.41 1.41\" />\n  <path d=\"M2 12h2\" />\n  <path d=\"M20 12h2\" />\n  <path d=\"m6.34 17.66-1.41 1.41\" />\n  <path d=\"m19.07 4.93-1.41 1.41\" />\n</svg>\n","moon":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-moon\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\" />\n</svg>\n","maximize":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-maximize\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M8 3H5a2 2 0 0 0-2 2v3\" />\n  <path d=\"M21 8V5a2 2 0 0 0-2-2h-3\" />\n  <path d=\"M3 16v3a2 2 0 0 0 2 2h3\" />\n  <path d=\"M16 21h3a2 2 0 0 0 2-2v-3\" />\n</svg>\n","minimize":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-minimize\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M8 3v3a2 2 0 0 1-2 2H3\" />\n  <path d=\"M21 8h-3a2 2 0 0 1-2-2V3\" />\n  <path d=\"M3 16h3a2 2 0 0 1 2 2v3\" />\n  <path d=\"M16 21v-3a2 2 0 0 1 2-2h3\" />\n</svg>\n","x":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-x\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M18 6 6 18\" />\n  <path d=\"m6 6 12 12\" />\n</svg>\n","paperclip":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-paperclip\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551\" />\n</svg>\n","arrow-up":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-arrow-up\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m5 12 7-7 7 7\" />\n  <path d=\"M12 19V5\" />\n</svg>\n","download":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-download\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M12 15V3\" />\n  <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" />\n  <path d=\"m7 10 5 5 5-5\" />\n</svg>\n","crosshair":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-crosshair\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <circle cx=\"12\" cy=\"12\" r=\"10\" />\n  <line x1=\"22\" x2=\"18\" y1=\"12\" y2=\"12\" />\n  <line x1=\"6\" x2=\"2\" y1=\"12\" y2=\"12\" />\n  <line x1=\"12\" x2=\"12\" y1=\"6\" y2=\"2\" />\n  <line x1=\"12\" x2=\"12\" y1=\"22\" y2=\"18\" />\n</svg>\n","search":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-search\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"m21 21-4.34-4.34\" />\n  <circle cx=\"11\" cy=\"11\" r=\"8\" />\n</svg>\n","rotate-ccw":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-rotate-ccw\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" />\n  <path d=\"M3 3v5h5\" />\n</svg>\n","calendar-days":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-calendar-days\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M8 2v3\" />\n  <path d=\"M16 2v3\" />\n  <rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" />\n  <path d=\"M3 9h18\" />\n  <path d=\"M8 13h.01\" />\n  <path d=\"M12 13h.01\" />\n  <path d=\"M16 13h.01\" />\n  <path d=\"M8 17h.01\" />\n  <path d=\"M12 17h.01\" />\n  <path d=\"M16 17h.01\" />\n</svg>\n","arrow-up-right":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-arrow-up-right\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M7 7h10v10\" />\n  <path d=\"M7 17 17 7\" />\n</svg>\n","file-text":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-file-text\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" />\n  <path d=\"M14 2v5a1 1 0 0 0 1 1h5\" />\n  <path d=\"M10 9H8\" />\n  <path d=\"M16 13H8\" />\n  <path d=\"M16 17H8\" />\n</svg>\n","check":"<!-- @license lucide-static v1.58.0 - ISC -->\n<svg\n  class=\"lucide lucide-check\"\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  viewBox=\"0 0 24 24\"\n  fill=\"none\"\n  stroke=\"currentColor\"\n  stroke-width=\"2\"\n  stroke-linecap=\"round\"\n  stroke-linejoin=\"round\"\n>\n  <path d=\"M20 6 9 17l-5-5\" />\n</svg>\n"};
const icons={};
for(const [index,[name,svg]]of Object.entries(iconSVGs).entries()){
const c=figma.createComponent();page.appendChild(c);c.name="Icon/"+name;c.resize(18,18);c.fills=[];c.x=200+(index%9)*80;c.y=80+Math.floor(index/9)*72;c.description="Lucide SVG source. Native vectors; use at 16px or 18px.";
const v=figma.createNodeFromSvg(svg.replaceAll("currentColor","#F4F6EE"));c.appendChild(v);v.resize(18,18);v.x=0;v.y=0;v.constraints={horizontal:"SCALE",vertical:"SCALE"};recolorIcon(v,"foreground");icons[name]=c;
}
function icon(parent,name="plus",size=16,role="foreground"){const n=icons[name].createInstance();parent.appendChild(n);n.resize(size,size);n.name="Icon/"+name;recolorIcon(n,role);return n;}
const sets={},props={},variantIds={};
async function family(name,axes,w,h,x,y,build){
const result=await createComponentWithVariants({name,description:"Local editable Dotatel adaptation of shadcn/ui patterns; not an imported official shadcn kit.",variantAxes:axes,baseProps:{width:w,height:h,layoutMode:"HORIZONTAL",itemSpacing:8},page});
const set=result.componentSet;set.x=x;set.y=y;sets[name]=set;variantIds[name]={};
for(const c of set.children){c.primaryAxisSizingMode="FIXED";c.counterAxisSizingMode="FIXED";c.counterAxisAlignItems="CENTER";c.primaryAxisAlignItems="MIN";fills(c,null);stroke(c,null);await build(c,set);variantIds[name][c.name]=c.id;}
return set;
}
const b=await family("Button",{Variant:["default","outline","ghost","link"],State:["Default","Hover","Focus","Disabled"]},144,32,200,400,(c)=>{
padding(c,12,12,6,6);gap(c,8);radius(c,6);c.primaryAxisAlignItems="CENTER";const v=c.variantProperties.Variant,s=c.variantProperties.State;
fills(c,v==="default"?"primary":s==="Hover"&&v!=="link"?"hover":v==="outline"?"input":null);
stroke(c,s==="Focus"?"primary":v==="outline"?"border":null);c.opacity=s==="Disabled"?0.45:1;
icon(c,"plus",16,v==="default"?"onPrimary":v==="link"?"link":"foreground");
txt(c,"Button","Button",v==="default"?"onPrimary":v==="link"?"link":"foreground");
});
props.Button={Label:b.addComponentProperty("Label","TEXT","Button"),Icon:b.addComponentProperty("Icon","INSTANCE_SWAP",icons.plus.id),ShowIcon:b.addComponentProperty("Show icon","BOOLEAN",false)};
for(const c of b.children){c.children[0].componentPropertyReferences={mainComponent:props.Button.Icon,visible:props.Button.ShowIcon};c.children[1].componentPropertyReferences={characters:props.Button.Label};}
await family("Input",{State:["Default","Focus","Invalid","Disabled"]},160,32,1000,400,(c)=>{
padding(c,8,8,6,6);radius(c,6);fills(c,"input");stroke(c,c.variantProperties.State==="Invalid"?"negative":c.variantProperties.State==="Focus"?"primary":"border");c.opacity=c.variantProperties.State==="Disabled"?0.45:1;gap(c,6);
const v=txt(c,"Value","Control","foreground",110);v.layoutSizingHorizontal="FILL";txt(c,"","Body","muted");
});
const inp=sets.Input;props.Input={Value:inp.addComponentProperty("Value","TEXT","Value"),Unit:inp.addComponentProperty("Unit","TEXT","")};
for(const c of inp.children){c.children[0].componentPropertyReferences={characters:props.Input.Value};c.children[1].componentPropertyReferences={characters:props.Input.Unit};}
await family("Select",{State:["Default","Focus","Disabled"]},160,32,1000,650,(c)=>{
padding(c,8,8,6,6);radius(c,6);fills(c,"input");stroke(c,c.variantProperties.State==="Focus"?"primary":"border");c.opacity=c.variantProperties.State==="Disabled"?0.45:1;gap(c,8);const t=txt(c,"Select","Control","foreground",110);t.layoutSizingHorizontal="FILL";icon(c,"chevron-down",14,"muted");
});
const sel=sets.Select;props.Select={Value:sel.addComponentProperty("Value","TEXT","Select")};for(const c of sel.children)c.children[0].componentPropertyReferences={characters:props.Select.Value};
await family("Navigation item",{Selected:["False","True"]},64,70,200,1000,(c)=>{
c.layoutMode="VERTICAL";padding(c,4,4,12,8);gap(c,8);radius(c,6);c.counterAxisAlignItems="CENTER";const selected=c.variantProperties.Selected==="True";fills(c,selected?"selected":null);icon(c,"folder-open",18,selected?"selectedText":"muted");txt(c,"Explorer","Caption",selected?"foreground":"muted");
if(selected){const line=figma.createRectangle();c.appendChild(line);line.name="Active indicator";line.layoutPositioning="ABSOLUTE";line.resize(2,54);line.x=0;line.y=8;fills(line,"primary");}
});
const nav=sets["Navigation item"];props.Nav={Label:nav.addComponentProperty("Label","TEXT","Explorer"),Icon:nav.addComponentProperty("Icon","INSTANCE_SWAP",icons["folder-open"].id)};
for(const c of nav.children){c.children[0].componentPropertyReferences={mainComponent:props.Nav.Icon};c.children[1].componentPropertyReferences={characters:props.Nav.Label};}
await family("Tab",{Active:["False","True"]},92,36,500,1000,(c)=>{
padding(c,12,12,8,8);gap(c,4);c.primaryAxisAlignItems="CENTER";const active=c.variantProperties.Active==="True";txt(c,"Backtest","Control",active?"selectedText":"muted");
if(active){const line=figma.createRectangle();c.appendChild(line);line.name="Selected underline";line.layoutPositioning="ABSOLUTE";line.resize(76,3);line.x=8;line.y=33;fills(line,"primary");}
});
const tab=sets.Tab;props.Tab={Label:tab.addComponentProperty("Label","TEXT","Backtest")};for(const c of tab.children)c.children[0].componentPropertyReferences={characters:props.Tab.Label};
const columnWidths=[24,156,156,64,88,88,48,112,64];
await family("Trade row",{Side:["Buy","Sell"],Result:["Win","Loss"]},888,28,200,1250,(c)=>{
padding(c,12,12,4,4);gap(c,8);stroke(c,null);const values=["1","2025-02-06 14:00","2025-02-06 19:00",c.variantProperties.Side,"1.1024","1.1058","0.10",c.variantProperties.Result==="Win"?"+34.00":"-24.00",c.variantProperties.Result];
for(let j=0;j<values.length;j++){const role=j===3?(c.variantProperties.Side==="Buy"?"positive":"negative"):[7,8].includes(j)?(c.variantProperties.Result==="Win"?"positive":"negative"):"foreground";const t=txt(c,values[j],"Body",role,columnWidths[j]);if([4,5,6,7].includes(j))t.textAlignHorizontal="RIGHT";}
});
const row=sets["Trade row"];props.Row={};for(const label of ["Number","Entry","Exit","Side label","Entry price","Exit price","Lots","Net PnL","Result label"])props.Row[label]=row.addComponentProperty(label,"TEXT",label);
for(const c of row.children)c.children.forEach((t,i)=>{t.componentPropertyReferences={characters:Object.values(props.Row)[i]};});
const slider=figma.createComponent();page.appendChild(slider);slider.name="Date range slider";slider.description="Two date-range handles. Static editable Figma representation; exact dates remain available in the screen.";slider.resize(360,32);slider.fills=[];slider.x=200;slider.y=1600;
for(const [name,x,w,role]of [["Available interval",0,360,"border"],["Selected interval",74,212,"primary"]]){const line=figma.createRectangle();slider.appendChild(line);line.name=name;line.resize(w,4);line.x=x;line.y=14;line.cornerRadius=2;fills(line,role);}
for(const x of [68,280]){const thumb=figma.createEllipse();slider.appendChild(thumb);thumb.name="Date handle";thumb.resize(12,12);thumb.x=x;thumb.y=10;fills(thumb,"foreground");stroke(thumb,"border");}
const logo=figma.createComponent();page.appendChild(logo);logo.name="Dotatel official wordmark";logo.description="Official Dotatel vector geometry, recolored only by the supplied light/dark brand variants.";logo.resize(170,27);logo.fills=[];logo.x=1200;logo.y=1600;
const lv=figma.createNodeFromSvg("<svg width=\"170\" height=\"27\" xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 635 100\" role=\"img\" aria-labelledby=\"title desc\">\n<title id=\"title\">Dotatel logo</title>\n<desc id=\"desc\">Custom split D followed by the geometric Dotatel wordmark.</desc>\n\n<g aria-label=\"Custom split D mark\">\n  <path fill=\"#080D0A\" d=\"M0 5H49C72 5 90 17 100 33L23 79C8 72 0 61 0 46Z\"/>\n  <path fill=\"#C7FF1A\" d=\"M28 82L99 40C102 47 103 54 103 61V95H28Z\"/>\n</g>\n<g transform=\"translate(28 0)\" fill=\"#080D0A\" aria-label=\"OTATEL\">\n  <path fill-rule=\"evenodd\" d=\"M124 14H174C192 14 203 27 203 45V55C203 73 192 86 174 86H124C106 86 95 73 95 55V45C95 27 106 14 124 14ZM128 30C117 30 112 36 112 46V54C112 64 117 70 128 70H170C181 70 186 64 186 54V46C186 36 181 30 170 30Z\"/>\n  <path d=\"M211 14H286V31H257V86H240V31H211Z\"/>\n  <path fill-rule=\"evenodd\" d=\"M323 14H343L379 86H359L352 71H314L307 86H287ZM322 55H344L333 31Z\"/>\n  <path d=\"M377 14H452V31H423V86H406V31H377Z\"/>\n  <path d=\"M462 14H527V30H479V42H520V58H479V70H527V86H462Z\"/>\n  <path d=\"M541 14H558V70H607V86H541Z\"/>\n</g>\n</svg>\n");logo.appendChild(lv);lv.resize(170,27);lv.x=0;lv.y=0;
for(const n of lv.findAll(()=>true)){if("fills"in n&&Array.isArray(n.fills))n.fills=n.fills.map(p=>p.type==="SOLID"?paint(p.color.g>.8&&p.color.r>.5?"primary":"foreground"):p);}
const all=[...Object.values(icons),...Object.values(sets),slider,logo];const created=all.flatMap(n=>[n.id,...n.findAll(()=>true).map(k=>k.id)]);
return {createdNodeIds:created,mutatedNodeIds:[page.id],icons:Object.fromEntries(Object.entries(icons).map(([k,v])=>[k,v.id])),sets:Object.fromEntries(Object.entries(sets).map(([k,v])=>[k,v.id])),variantIds,props,slider:slider.id,logo:logo.id,componentCount:page.findAllWithCriteria({types:["COMPONENT"]}).length,localAdaptations:true};
