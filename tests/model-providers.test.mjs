import assert from "node:assert/strict";
import test from "node:test";
import {externalArguments,parseExternalOutput,selectModelProfile,validateStructuredValue,taskComplexity} from "../repo-canvas/scripts/model-providers.mjs";

test("an explicit provider with an empty model still resolves a named model",()=>{
  const config={modelProvider:"codex",allowedModelProviders:["codex"],modelPool:[{provider:"codex",model:"economy-model",tier:"fast"}]};
  assert.equal(selectModelProfile("reviewer",{config,profile:{provider:"codex",model:"",effort:"low"}}).model,"economy-model");
});

test("roles select capabilities in the permitted pool without fixed model names",()=>{
  const config={modelProvider:"codex",allowedModelProviders:["codex"],modelPool:[{provider:"codex",model:"quick",tier:"fast"},{provider:"codex",model:"reasoned",tier:"balanced"},{provider:"claude",model:"outside",tier:"balanced"}]};
  assert.equal(selectModelProfile("observer",{config}).model,"quick");
  assert.equal(selectModelProfile("architect",{config}).model,"reasoned");
  assert.equal(selectModelProfile("verifier",{config}).provider,"codex");
});
test("Claude and Kimi have independent protocol adapters and cannot invoke workspace tools",()=>{
  const options={profile:{model:"",effort:"low"},schema:{type:"object"},agentFile:"reader.md"};
  const claude=externalArguments("claude",options);const kimi=externalArguments("kimi",options);
  assert.ok(claude.includes("--safe-mode")&&claude.includes("--restricted")&&claude.includes("--tools"));
  assert.equal(claude[claude.indexOf("--tools")+1],"");
  assert.ok(kimi.includes("--agent-file")&&!kimi.includes("--yolo")&&!kimi.includes("--auto"));
  assert.deepEqual(parseExternalOutput("claude",JSON.stringify({type:"result",structured_output:{ok:true},usage:{input_tokens:8}})).value,{ok:true});
  assert.deepEqual(parseExternalOutput("kimi",JSON.stringify({role:"assistant",content:[{type:"text",text:'{"ok":true}'}]})).value,{ok:true});
  assert.throws(()=>parseExternalOutput("kimi",JSON.stringify({role:"assistant",content:"bad json"})),/JSON/);
});
test("structured validation rejects malformed output instead of trusting JSONL transport",()=>{
  const schema={type:"object",additionalProperties:false,properties:{count:{type:"integer"},ok:{type:"boolean"}},required:["count","ok"]};
  assert.deepEqual(validateStructuredValue({count:2,ok:true},schema),{count:2,ok:true});
  assert.throws(()=>validateStructuredValue({count:2.5,ok:true},schema),/целое/);
  assert.throws(()=>validateStructuredValue({count:2},schema),/обязательное/);
  assert.throws(()=>validateStructuredValue({count:2,ok:true,extra:1},schema),/неизвестное/);
});

test("large evidence and rejected fragments escalate within the allowed context budget",()=>{
  const config={modelProvider:"codex",allowedModelProviders:["codex"],modelPool:[{provider:"codex",model:"small",tier:"fast",context:32000},{provider:"codex",model:"large",tier:"strong",context:256000},{provider:"claude",model:"forbidden",tier:"strong",context:1000000}]};
  assert.equal(taskComplexity("observer",{promptChars:5000}),"normal");
  assert.equal(taskComplexity("verifier",{promptChars:150000}),"hard");
  assert.equal(taskComplexity("architect",{retry:true}),"hard");
  assert.equal(selectModelProfile("verifier",{config,complexity:"hard",contextTokens:90000}).model,"large");
  assert.throws(()=>selectModelProfile("architect",{config,contextTokens:300000}),/контекст/);
});

test("senior roles stay on medium through retries and explicit choices remain fixed",()=>{
  const config={modelProvider:"codex",allowedModelProviders:["codex"],modelPool:[{provider:"codex",model:"fast",tier:"fast"},{provider:"codex",model:"senior",tier:"strong"}]};
  for(const role of ["architect","verifier","historian"]){for(const complexity of ["normal","hard"]){const profile=selectModelProfile(role,{config,complexity});assert.equal(profile.model,"senior");assert.equal(profile.effort,"medium");}}
  config.modelPool=[{provider:"codex",model:"chosen",effort:"low",roles:["architect"]}];
  assert.equal(selectModelProfile("architect",{config,complexity:"hard"}).effort,"low");
  assert.equal(selectModelProfile("historian",{config}).model,"chosen");
  const previous=process.env.REPO_CANVAS_ARCHITECT_EFFORT;
  try{process.env.REPO_CANVAS_ARCHITECT_EFFORT="high";assert.equal(selectModelProfile("architect",{config}).effort,"low","An explicit role selection must win over a legacy environment default");}
  finally{if(previous===undefined)delete process.env.REPO_CANVAS_ARCHITECT_EFFORT;else process.env.REPO_CANVAS_ARCHITECT_EFFORT=previous;}
});
