// Only presentation is bundled. Original directed relations remain available
// for scenario highlighting, evidence, and the inspector.
export function connectionChannel(edge, reverse = false) {
  const port = value => String(value || "").replace(/^(source|target)-/, "");
  const source = port(edge.sourceHandle || edge.sourcePort || edge.fromPort);
  const target = port(edge.targetHandle || edge.targetPort || edge.toPort);
  return JSON.stringify([edge.channelId || edge.channel || "", reverse ? target : source, reverse ? source : target]);
}
export function mergeReciprocalRoutes(edges) {
  const output = [];
  const byDirection = new Map();
  for (const edge of edges) {
    const reverse = byDirection.get(`${edge.target}->${edge.source}:${edge.status}:${connectionChannel(edge,true)}`);
    if (reverse) {
      reverse.bidirectional = true;
      reverse.relations.push(...(edge.relations || []));
      const labels = new Set(reverse.relations.map(item => item.ownerLabel || item.label || "").filter(Boolean));
      reverse.sharedLabel = labels.size === 1 ? [...labels][0] : "";
    } else {
      const copy = {...edge, relations: [...(edge.relations || [])]};
      byDirection.set(`${edge.source}->${edge.target}:${edge.status}:${connectionChannel(edge)}`, copy);
      output.push(copy);
    }
  }
  return output;
}
