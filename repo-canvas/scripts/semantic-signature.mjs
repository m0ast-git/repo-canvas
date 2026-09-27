import crypto from "node:crypto";

export function semanticSignature(snapshot) {
  const clean=item=>Object.fromEntries(Object.entries(item || {}).filter(([key])=>!["x","y","width","height","minWidth","minHeight","actor","updatedAt","verification","_checkpoint"].includes(key)));
  return crypto.createHash("sha256").update(JSON.stringify({map:clean(snapshot.map),areas:snapshot.areas.map(clean),entities:snapshot.entities.map(clean),relations:snapshot.relations.map(clean)})).digest("hex");
}
