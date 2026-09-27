import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema,ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {agentTools,callAgentTool} from "./agent-context.mjs";
import {validateStructuredValue} from "./structured-schema.mjs";

export async function startContextServer(transport=new StdioServerTransport()) {
  const server=new Server({name:"repo-canvas",version:"0.14.0"},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:agentTools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try {
      const tool=agentTools.find(item=>item.name===request.params.name);if(!tool)throw new Error("Неизвестный инструмент");
      const args=request.params.arguments||{};validateStructuredValue(args,tool.inputSchema);
      const value=callAgentTool(tool.name,args);return {content:[{type:"text",text:JSON.stringify(value)}]};
    } catch(error) {return {isError:true,content:[{type:"text",text:error.message}]};}
  });
  await server.connect(transport);
  const stop=async()=>{await server.close();};process.once("SIGINT",stop);process.once("SIGTERM",stop);
  return server;
}
