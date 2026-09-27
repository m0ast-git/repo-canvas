// Give each relationship its own place on the node boundary. Allocation is
// deterministic and belongs to world geometry, so zoom never changes a port.
export function graphWithConnectionPorts(nodes, edges, obstacles = []) {
  const graphNodes = nodes.map(node => ({...node, ports: []}));
  const byId = new Map(graphNodes.map(node => [node.id, node]));
  const graphEdges = edges.map(edge => ({id: edge.id, source: edge.source, target: edge.target}));
  const sides = new Map();
  const openings=new Map();
  // A fixed port must be exposed, even when saved cards partly overlap.
  // Subtract obstacle projections from each boundary, leaving routing to libavoid.
  const intervals=(node,side)=>{
    const key=node.id+':'+side;if(openings.has(key))return openings.get(key);
    const vertical=side==='EAST'||side==='WEST',length=vertical?node.height:node.width;
    const inset=Math.min(20,length/4),origin=vertical?node.y:node.x;
    const level=vertical?node.x+(side==='EAST'?node.width:0):node.y+(side==='SOUTH'?node.height:0);
    let ranges=[[inset,length-inset]];
    for(const box of obstacles){
      if(box.id===node.id||box.nodeId===node.id)continue;
      const across=vertical?box.x:box.y,size=vertical?box.width:box.height;
      if(level<across-4||level>across+size+4)continue;
      const lo=(vertical?box.y:box.x)-origin-4,hi=lo+(vertical?box.height:box.width)+8;
      ranges=ranges.flatMap(([a,b])=>hi<=a||lo>=b?[[a,b]]:[[a,Math.min(b,lo)],[Math.max(a,hi),b]].filter(([x,y])=>y-x>=1));
    }
    openings.set(key,ranges);return ranges;
  };
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    for (const end of ["source", "target"]) {
      const node = byId.get(edge[end]);
      const other = byId.get(edge[end === "source" ? "target" : "source"]);
      if (!node || !other) continue;
      const dx = other.x + other.width/2 - node.x - node.width/2;
      const dy = other.y + other.height/2 - node.y - node.height/2;
      const preferred = Math.abs(dx)/Math.max(1,(node.width+other.width)/2) >= Math.abs(dy)/Math.max(1,(node.height+other.height)/2)
        ? dx >= 0 ? "EAST" : "WEST" : dy >= 0 ? "SOUTH" : "NORTH";
      const choices=['NORTH','EAST','SOUTH','WEST'].filter(side=>intervals(node,side).length);
      const distance=side=>Math.hypot(other.x+other.width/2-(node.x+(side==='WEST'?0:side==='EAST'?node.width:node.width/2)),other.y+other.height/2-(node.y+(side==='NORTH'?0:side==='SOUTH'?node.height:node.height/2)));
      const side=choices.includes(preferred)?preferred:choices.sort((a,b)=>distance(a)-distance(b))[0]||preferred;
      const key = `${node.id}:${side}`;
      const entry = {node, side, edge: graphEdges[i], end, order: ["EAST","WEST"].includes(side) ? other.y + other.height/2 : other.x + other.width/2};
      if (!sides.has(key)) sides.set(key, []);
      sides.get(key).push(entry);
    }
  }
  for (const group of sides.values()) {
    group.sort((a,b) => a.order-b.order || a.edge.id.localeCompare(b.edge.id));
    group.forEach(({node,side,edge,end},index) => {
      const vertical = side === "EAST" || side === "WEST";
      const length = vertical ? node.height : node.width;
      const inset = Math.min(20, length/4);
      const ranges=intervals(node,side);
      let remaining=ranges.reduce((sum,[a,b])=>sum+b-a,0)*(index+1)/(group.length+1);
      let along=inset+(length-inset*2)*(index+1)/(group.length+1);
      for(const [a,b] of ranges){if(remaining<=b-a){along=a+remaining;break;}remaining-=b-a;}
      const port = {id:`${node.id}:${edge.id}:${end}`, x:vertical ? side === "EAST" ? node.width : 0 : along, y:vertical ? along : side === "SOUTH" ? node.height : 0, width:0, height:0, properties:{"port.side":side}};
      node.ports.push(port); edge[`${end}Port`] = port.id;
    });
  }
  return {children: graphNodes, edges: graphEdges};
}
