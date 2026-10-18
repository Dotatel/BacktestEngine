const page=await figma.getNodeByIdAsync("3:2");await figma.setCurrentPageAsync(page);
const iconIds=new Set(["4:2", "4:5", "4:13", "4:18", "4:22", "4:25", "4:31", "4:34", "4:37", "4:40", "4:44", "4:49", "4:52", "4:63", "4:66", "4:72", "4:78", "4:82", "4:85", "4:89", "4:94", "4:101", "4:105", "4:109", "4:121", "4:125", "4:132"]);const changed=[];
for(const id of iconIds){const master=await figma.getNodeByIdAsync(id);for(const n of master.children){if(n.type==="FRAME"){n.fills=[];changed.push(n.id);}}}
for(const inst of page.findAllWithCriteria({types:["INSTANCE"]})){const master=await inst.getMainComponentAsync();if(master&&iconIds.has(master.id)){for(const n of inst.children){if(n.type==="FRAME"){n.fills=[];changed.push(n.id);}}}}
const assistant=await figma.getNodeByIdAsync("6:971");for(const n of assistant.findAllWithCriteria({types:["TEXT"]})){if(n.characters.includes("Review assumptions")){for(const s of n.getStyledTextSegments(["fontName"]))await figma.loadFontAsync(s.fontName);n.characters="Review assumptions";changed.push(n.id);}}
return {mutatedNodeIds:changed,iconBackgroundsCleared:changed.length};
