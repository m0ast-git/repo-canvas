import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TreeSitter from "@vscode/tree-sitter-wasm";

// One packaged runtime and matching grammars: no compiler or network at runtime.
const { Parser, Language } = TreeSitter;
const directory = path.dirname(fileURLToPath(import.meta.resolve("@vscode/tree-sitter-wasm")));
const languages = new Map(Object.entries({
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".cs": "c-sharp",
  ".rb": "ruby", ".php": "php",
}));
await Parser.init();
const grammars = new Map(await Promise.all([...new Set(languages.values())].map(async name =>
  [name, await Language.load(path.join(directory, `tree-sitter-${name}.wasm`))])));
const declarations = new Set([
  "function_declaration", "generator_function_declaration", "function_signature", "function_definition", "function_item",
  "class_declaration", "abstract_class_declaration", "class_definition", "class", "module", "struct_item", "enum_item",
  "trait_item", "type_item", "mod_item", "const_item", "static_item", "impl_item", "type_spec",
  "interface_declaration", "type_alias_declaration", "enum_declaration", "internal_module", "namespace_declaration",
  "struct_declaration", "record_declaration", "trait_declaration", "method_declaration", "constructor_declaration",
  "method_definition", "method_signature", "abstract_method_signature", "method", "singleton_method",
  "variable_declarator", "property_declaration", "public_field_definition", "field_definition",
]);
const wrappers = new Set(["export_statement", "decorated_definition", "lexical_declaration", "variable_declaration"]);
const functionScopes = new Set(["function_declaration", "generator_function_declaration", "function_definition", "function_item", "method_definition", "method_declaration", "constructor_declaration", "method", "singleton_method", "arrow_function", "function_expression", "lambda"]);
const cache = new Map();
let cachedBytes = 0;
const CACHE_BYTES = 8 * 1024 * 1024;

export function sourceLanguage(file) { return languages.get(path.extname(file).toLowerCase()); }

function declarationName(node) {
  const name = node.childForFieldName("name") || (node.type === "impl_item" ? node.childForFieldName("type") : null);
  if (!name || ["object_pattern", "array_pattern", "computed_property_name"].includes(name.type)) return "";
  return name.text.replaceAll("::", ".");
}

function collectSymbols(tree, language) {
  const symbols = [];
  const pending = [{ node: tree.rootNode, scope: [], local: false }];
  while (pending.length) {
    const { node, scope, local } = pending.pop();
    let nextScope = scope;
    if (declarations.has(node.type)) {
      const name = declarationName(node);
      if (name) {
        let owner = scope;
        if (language === "go" && node.type === "method_declaration") {
          const type = node.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0];
          if (type) owner = [...scope, type.text];
        }
        nextScope = [...owner, name];
        let span = node;
        while (span.parent && wrappers.has(span.parent.type)) span = span.parent;
        // Intact declarations in a partly edited file remain addressable.
        if (!node.hasError && node.type !== "impl_item") symbols.push({
          name: nextScope.join("."), leaf: name, line: span.startPosition.row + 1,
          endLine: span.endPosition.row + (span.endPosition.column ? 1 : 0), kind: node.type, inventory: !local,
        });
      }
    }
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) pending.push({ node: children[i], scope: nextScope, local: local || functionScopes.has(node.type) });
  }
  return symbols;
}

export function sourceSymbols(file, content) {
  const language = sourceLanguage(file);
  if (!language) return [];
  const key = `${language}:${crypto.createHash("sha256").update(content).digest("hex")}`;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached.symbols; }
  const parser = new Parser();
  let tree;
  try {
    parser.setLanguage(grammars.get(language));
    tree = parser.parse(content);
    if (!tree) return [];
    const symbols = collectSymbols(tree, language);
    // Retain plain ranges, not source text or WASM trees; historical versions expire.
    const bytes = Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(symbols));
    if (bytes <= CACHE_BYTES) {
      cache.set(key, { symbols, bytes }); cachedBytes += bytes;
      while (cache.size > 64 || cachedBytes > CACHE_BYTES) {
        const oldest = cache.keys().next().value; cachedBytes -= cache.get(oldest).bytes; cache.delete(oldest);
      }
    }
    return symbols;
  } finally { tree?.delete(); parser.delete(); }
}

export function resolveSourceSymbol(file, content, symbol) {
  if (!sourceLanguage(file)) return { error: "Для этого языка адресация символов не поддерживается; укажите файл или диапазон строк" };
  const name = symbol.replace(/\(.*\)$/, "").replaceAll("::", ".").trim();
  const candidates = sourceSymbols(file, content).filter(item => name.includes(".") ? item.name === name : item.leaf === name);
  if (!candidates.length) return { error: `Символ ${symbol} не найден среди корректных объявлений` };
  if (candidates.length > 1) return { error: `Символ ${symbol} неоднозначен; укажите полное имя или диапазон строк (${candidates.slice(0, 5).map(item => `${item.name}:${item.line}`).join(", ")})` };
  return candidates[0];
}

// Parse imports and a comment/whitespace-independent fingerprint with the installed parser.
// Unchanged exports alone are deliberately NOT treated as unchanged behaviour.
export function sourceStructure(file,content) {
  const language=sourceLanguage(file);if(!language)return {language:null,imports:[],exports:[],syntaxHash:null};
  const parser=new Parser();let tree;
  try {
    parser.setLanguage(grammars.get(language));tree=parser.parse(content);
    const imports=[];const exports=[];const leaves=[];const stack=[tree.rootNode];
    while(stack.length) {
      const node=stack.pop();if(/comment/.test(node.type))continue;
      if(["import_statement","export_statement","import_from_statement","import_spec","use_declaration"].includes(node.type)) {
        const source=node.childForFieldName("source")||node.childForFieldName("module_name")||node.childForFieldName("path");
        if(source)imports.push({specifier:source.text.replace(/^["'`]|["'`]$/g,""),line:node.startPosition.row+1});
        if(node.type==="export_statement") {
          const declaration=node.childForFieldName("declaration");const body=declaration?.childForFieldName("body");
          exports.push(content.slice(node.startIndex,body?.startIndex??node.endIndex).slice(0,240));
        }
      }
      if(node.type==="call_expression"&&["require","import"].includes(node.childForFieldName("function")?.text)) {
        const first=node.childForFieldName("arguments")?.namedChildren[0];
        if(first?.type==="string")imports.push({specifier:first.text.slice(1,-1),line:node.startPosition.row+1});
      }
      if(!node.childCount)leaves.push([node.type,node.text]);
      else for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);
    }
    return {language,imports,exports,syntaxHash:tree.rootNode.hasError?null:crypto.createHash("sha256").update(JSON.stringify(leaves)).digest("hex")};
  } finally {tree?.delete();parser.delete();}
}
