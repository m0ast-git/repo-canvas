// Stable area ownership: neither array order nor selection participates.
const light = ["#657D35", "#A16F1D", "#258B87", "#687DAA", "#986489", "#AD6050"];
const dark = ["#ADD58B", "#E2BB6F", "#79D2C9", "#AABDEB", "#D4A3CB", "#E9A08B"];
export function areaColor(area, theme = "light") {
  const id = typeof area === "string" ? area : area.id;
  const key = { olive: 0, leaf: 1, teal: 2 }[area.colorKey];
  let hash = 2166136261;
  for (const character of String(id)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return (theme === "dark" ? dark : light)[key ?? area.colorSlot ?? hash % light.length];
}

export function assignAreaColors(areas, previous = {}) {
  const assignments = Object.fromEntries(Object.entries(previous).filter(([,slot])=>Number.isInteger(slot)&&slot>=0&&slot<light.length));
  const used = new Set(Object.values(assignments));
  for (const area of [...areas].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (Object.hasOwn(assignments, area.id)) continue;
    let slot = light.findIndex((_,index)=>!used.has(index));
    if(slot<0)slot=Object.keys(assignments).length%light.length;
    assignments[area.id]=slot;used.add(slot);
  }
  return assignments;
}

export function routeSourceArea(route, entities, endpoint = "source") {
  const id = route[endpoint] || "";
  if (id.startsWith("area:")) return id.slice(5);
  if (id.startsWith("entity:")) {
    let item = entities.get(id.slice(7));
    const seen = new Set();
    while (item && !seen.has(item.id)) {
      seen.add(item.id);
      if (Object.hasOwn(item, "areaId") && item.areaId !== undefined) return item.areaId || null;
      item = entities.get(item.parentId);
    }
    return null;
  }
  return route[endpoint + "AreaId"] || null;
}

export function routeColors(route, entities, colors, theme = "light") {
  const neutral = theme === "dark" ? "#A0A9B2" : "#777777";
  const color = colors.get(routeSourceArea(route, entities)) || neutral;
  const reverseColor = route.bidirectional ? colors.get(routeSourceArea(route, entities, "target")) || neutral : color;
  return { color, reverseColor };
}

export function componentStatus(status) {
  return ({ operational: "ready", existing: "ready", accepted: "verified", completed: "verified", planned: "planned", active: "running", blocked: "question", unresolved: "question", inferred: "question", proposed: "question", problem: "error", disabled: "paused", cancelled: "paused" })[status] || "ready";
}

export function routeIsWithinArea(route, areaId, entities) {
  const source=routeSourceArea(route,entities);
  return source===areaId&&(route.type==="work"||routeSourceArea(route,entities,"target")===areaId);
}
