import fs from "node:fs";
const templates=new Map();

export function promptTemplate(name,values) {
  if(!/^[a-z-]+$/.test(name))throw new Error("Unknown prompt template");
  if(!templates.has(name))templates.set(name,fs.readFileSync(new URL(`../prompts/${name}.md`,import.meta.url),"utf8"));
  return templates.get(name).replace(/\{\{([A-Z_]+)\}\}/g,(_,key)=>{if(!Object.hasOwn(values,key))throw new Error(`Missing prompt input: ${key}`);return String(values[key]);});
}
