import assert from "node:assert/strict";
import test from "node:test";
import { codeExcerpt } from "../repo-canvas/scripts/project-sources.mjs";
import { sourceSymbols } from "../repo-canvas/scripts/source-syntax.mjs";

const excerpt=(file,text,symbol)=>codeExcerpt(`${file}#${symbol}`,Buffer.from(text));
test("qualified symbols resolve the owning class and never fall back to a mention",()=>{
  const text='// Second.run is described here\nclass First {\n  run() { return "FIRST"; }\n}\nclass Second {\n  run() { return "SECOND"; }\n}\n';
  const result=excerpt("sample.ts",text,"Second.run");
  assert.equal(result.error,undefined);assert.equal(result.first,6);assert.equal(result.last,6);
  assert.match(result.text,/SECOND/);assert.doesNotMatch(result.text,/FIRST/);
  assert.match(excerpt("sample.ts",text,"run").error,/неоднозначен/);
  assert.match(excerpt("sample.ts",text,"Missing.run").error,/не найден/);
  assert.match(excerpt("sample.ts",'// fake()\nconst note="fake()";',"fake").error,/не найден/);
});

test("packaged grammars retain qualified methods across supported source languages",()=>{
  const cases=[
    ["a.jsx",'export class Second { run() { return <span>ok</span>; } }',"Second.run"],
    ["a.tsx",'namespace N { export class Second { run(): JSX.Element { return <span/>; } } }',"N.Second.run"],
    ["a.py",'class Second:\n  @checked\n  def run(self):\n    return "ok"\n',"Second.run"],
    ["a.go",'package main\nfunc (s *Second) Run() bool { return true }',"Second.Run"],
    ["a.rs",'impl Second { fn run(&self) -> bool { true } }',"Second.run"],
    ["a.java",'class Second { public boolean run() { return true; } }',"Second.run"],
    ["a.cs",'namespace N { class Second { public bool Run() { return true; } } }',"N.Second.Run"],
    ["a.rb",'class Second\n def run\n true\n end\nend',"Second.run"],
    ["a.php",'<?php class Second { public function run() { return true; } }',"Second.run"],
  ];
  for(const [file,text,symbol] of cases){
    const result=excerpt(file,text,symbol);assert.equal(result.error,undefined,`${file}: ${result.error}`);
    assert.ok(sourceSymbols(file,text).some(item=>item.name===symbol),file);
  }
});

test("AST bounds survive strings, decorators, CRLF, unicode and compact formatting",()=>{
  const text='const unrelated="} execute()";\r\nexport async function execute() {\r\n  const text="кириллица }";\r\n  return () => ({text});\r\n}\r\nconst other=1;';
  const result=excerpt("a.mjs",text,"execute");assert.equal(result.first,2);assert.equal(result.last,5);
  assert.match(result.text,/кириллица/);assert.doesNotMatch(result.text,/unrelated|other/);
  const decorated=excerpt("a.py",'@checked\ndef run():\n  return "ok"\n\ndef next():\n  pass\n',"run");
  assert.match(decorated.text,/@checked/);assert.doesNotMatch(decorated.text,/def next/);
});

test("source versions have independent ranges and unsupported syntax still permits exact lines",()=>{
  assert.match(excerpt("a.js",'function run(){return "old";}',"run").text,/old/);
  assert.match(excerpt("a.js",'\n\nfunction run(){return "new";}',"run").text,/3:.*new/);
  assert.match(excerpt("a.js",'function other(){}',"run").error,/не найден/);
  assert.match(excerpt("a.txt",'run()',"run").error,/диапазон строк/);
  assert.equal(codeExcerpt('a.txt:2',Buffer.from('one\ntwo\nthree')).first,2);
  assert.match(excerpt("a.ts",'function bad( {\n',"bad").error,/не найден/);
});

test("inventory keeps public structure ahead of function-local implementation details",()=>{
  const source='export function run(){ const local=1; function helper(){return local;} }\nclass Client { send(){ const payload=1; return payload; } }';
  const symbols=sourceSymbols('a.js',source);
  assert.deepEqual(symbols.filter(s=>s.inventory).map(s=>s.name),['run','Client','Client.send']);
  assert.ok(symbols.some(s=>s.name==='run.helper'));
});
