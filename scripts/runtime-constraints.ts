/** AST guard for request-lifetime RPC transports in Workshop and its app entrypoints. */
import ts from 'typescript6';
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** One executable transport site, including factories reached through local aliases. */
export interface TransportSite {file:string;line:number;api:string;owner:string;rule?:string}
/** Analyze source inputs without executing or importing application code. */
export function auditRuntimeSources(inputs:ReadonlyMap<string,string>):TransportSite[] {
  const files=new Map([...inputs].map(([name,text])=>[resolve(name),text]));
  const options:ts.CompilerOptions={allowJs:true,noLib:true,noResolve:false,moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ESNext};
  const host=ts.createCompilerHost(options);
  host.fileExists=name=>files.has(resolve(name));
  host.readFile=name=>files.get(resolve(name));
  host.getSourceFile=(name,version)=>{const text=files.get(resolve(name));return text===undefined?undefined:ts.createSourceFile(name,text,version,true);};
  host.directoryExists=name=>[...files.keys()].some(file=>file.startsWith(resolve(name)+'/'));
  const program=ts.createProgram([...files.keys()],options,host),checker=program.getTypeChecker();
  const sites:TransportSite[]=[];
  function moduleOf(node:ts.Node):string|undefined {for(let n:ts.Node|undefined=node;n;n=n.parent)if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))return n.moduleSpecifier.text;return undefined;}
  function origin(node:ts.Node,seen=new Set<ts.Node>()):string|undefined {
    if(seen.has(node))return;seen.add(node);
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return origin(node.expression,seen);
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&node.arguments.length===1&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='capnweb')return 'capnweb:*';
    if(ts.isPropertyAccessExpression(node)){const base=origin(node.expression,seen);if(base?.endsWith(':*'))return base.slice(0,-1)+node.name.text;}
    if(ts.isElementAccessExpression(node)&&node.argumentExpression){const base=origin(node.expression,seen),key=literal(node.argumentExpression);if(base?.endsWith(':*')&&key)return base.slice(0,-1)+key;}
    const symbol=checker.getSymbolAtLocation(node);
    if(ts.isIdentifier(node)&&!symbol){if(node.text==='fetch')return 'global:fetch';if(['globalThis','window'].includes(node.text))return 'global:*';}
    const body=ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isMethodDeclaration(node)?node.body:undefined;
    if(body){
      if(node.getSourceFile().fileName.endsWith('/packages/workshop-frontend/src/rpcTransport.ts'))return 'shared:connection';
      let result:string|undefined;
      const scan=(child:ts.Node):void=>{if(result)return;if(ts.isCallExpression(child)||ts.isNewExpression(child)){const value=origin(child.expression,seen);if(value?.startsWith('capnweb:')&&/RpcSession$/.test(value))result=value;}if(!result)ts.forEachChild(child,scan);};
      scan(body);if(result)return result;
    }
    for(const d of symbol?.declarations??[]){
      if(ts.isImportSpecifier(d)){const module=moduleOf(d);if(module==='capnweb')return module+':'+(d.propertyName??d.name).text;}
      if(ts.isNamespaceImport(d)){const module=moduleOf(d);if(module==='capnweb')return module+':*';}
      if(ts.isVariableDeclaration(d)&&d.initializer){const value=origin(d.initializer,seen);if(value)return value;}
      if(ts.isFunctionLike(d)){const value=origin(d,seen);if(value)return value;}
      if(ts.isBindingElement(d)&&ts.isObjectBindingPattern(d.parent)&&ts.isVariableDeclaration(d.parent.parent)&&d.parent.parent.initializer){const base=origin(d.parent.parent.initializer,seen);if(base?.endsWith(':*'))return base.slice(0,-1)+(d.propertyName??d.name).getText();}
    }
    if(symbol?.flags&&symbol.flags&ts.SymbolFlags.Alias){const target=checker.getAliasedSymbol(symbol);if(target!==symbol)for(const d of target.declarations??[]){const value=origin(d,seen);if(value)return value;}}
    return undefined;
  }
  function literal(node:ts.Node):string|undefined {
    if(ts.isStringLiteralLike(node))return node.text;
    const d=checker.getSymbolAtLocation(node)?.valueDeclaration;
    return d&&ts.isVariableDeclaration(d)&&d.initializer&&ts.isStringLiteralLike(d.initializer)?d.initializer.text:undefined;
  }
  function rawRequest(node:ts.Node,seen=new Set<ts.Node>()):boolean {
    if(seen.has(node))return false;seen.add(node);
    const d=checker.getSymbolAtLocation(node)?.valueDeclaration;
    if(d&&ts.isVariableDeclaration(d)&&d.initializer)return rawRequest(d.initializer,seen);
    if(d&&ts.isParameter(d)){
      if(d.type&&ts.isTypeReferenceNode(d.type)&&d.type.typeName.getText()==='Request')return true;
      const fn=d.parent;
      return ts.isFunctionLike(fn)&&fn.parameters[0]===d&&'name' in fn&&fn.name!==undefined&&['fetch','connect'].includes(fn.name.getText());
    }
    return false;
  }
  function owner(node:ts.Node):string {
    for(let n:ts.Node|undefined=node;n;n=n.parent)if(ts.isClassDeclaration(n)){
      const durable=n.heritageClauses?.some(h=>h.token===ts.SyntaxKind.ExtendsKeyword&&h.types.some(t=>{
        const symbol=checker.getSymbolAtLocation(t.expression);
        return symbol?.declarations?.some(d=>ts.isImportSpecifier(d)&&moduleOf(d)==='cloudflare:workers'&&(d.propertyName??d.name).text==='DurableObject');
      }));
      if(durable)return 'durable-object';
    }
    return 'request';
  }
  const roots=[...inputs.keys()];
  for(const sf of program.getSourceFiles()){
    if(!files.has(resolve(sf.fileName)))continue;
    const original=roots.find(name=>resolve(name)===resolve(sf.fileName))??sf.fileName;
    const path=original.replaceAll('\\','/');
    const frontend=path.includes('packages/workshop-frontend/src/');
    const backend=path.includes('packages/workshop-backend/src/');
    const shared=path.endsWith('packages/workshop-frontend/src/rpcTransport.ts');
    function visit(node:ts.Node):void {
      if(ts.isCallExpression(node)||ts.isNewExpression(node)){
        const source=origin(node.expression);
        if(frontend&&!shared&&!path.endsWith('/packages/workshop-frontend/src/main.tsx')&&source==='shared:connection')sites.push({file:original,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,api:'connectWorkshop',owner:'browser',rule:'shared-connection-bypass'});
        if(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='formData'&&rawRequest(node.expression.expression))sites.push({file:original,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,api:'Request.formData',owner:'request',rule:'unbounded-request-form'});
        if(source?.startsWith('capnweb:')){
          const api=source.slice('capnweb:'.length),kind=owner(node);
          if(['newWebSocketRpcSession','newHttpBatchRpcSession','newWorkersRpcResponse','RpcSession','newMessagePortRpcSession'].includes(api)){
            const rule=frontend&&!shared&&['newWebSocketRpcSession','newHttpBatchRpcSession','RpcSession'].includes(api)?'shared-connection-bypass':
              backend&&api==='newWebSocketRpcSession'&&kind!=='durable-object'?'worker-lifetime-websocket':undefined;
            sites.push({file:original,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,api,owner:frontend?'browser':kind,...(rule?{rule}:{})});
          }
        }
        if(frontend&&!shared&&source==='global:fetch'){
          const address=node.arguments?.[0];
          const values:string[]=[];
          const collect=(n:ts.Node):void=>{if(ts.isStringLiteralLike(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n))values.push(n.text);ts.forEachChild(n,collect);};
          if(address)collect(address);
          if(values.some(value=>/(?:^|\/)api(?:[?#][^/]*)?$/.test(value)))sites.push({file:original,line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1,api:'fetch',owner:'browser',rule:'shared-connection-bypass'});
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(sf);
  }
  return sites.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
}

/** Enumerate only Git-owned source; omit tests, declarations, generated output and dependencies. */
export function runtimeSources(root:string):Map<string,string> {
  const names=execFileSync('git',['ls-files','-z','--','packages'],{cwd:root,encoding:'utf8'}).split('\0');
  return new Map(names.filter(name=>/\.[cm]?[jt]sx?$/.test(name)&&!/(?:^|\/)(?:node_modules|dist|generated|integration-tests|__tests__|tests|test|references|fixtures)(?:\/|$)|(?:\.d\.[cm]?ts|[.-](?:test|spec)\.[cm]?[jt]sx?)$/.test(name)).map(name=>[resolve(root,name),readFileSync(resolve(root,name),'utf8')]));
}

/** Include a starter's owned app sources when this kernel is used as its submodule. */
export function runtimeRepositories(root:string):Map<string,string> {
  const inputs=runtimeSources(root);
  const parent=execFileSync('git',['rev-parse','--show-superproject-working-tree'],{cwd:root,encoding:'utf8'}).trim();
  if(parent){
    for(const [file,text]of runtimeSources(parent))inputs.set(file,text);
    const cloud=resolve(parent,'legion-os-cloud');
    if(existsSync(resolve(cloud,'.git')))for(const [file,text]of runtimeSources(cloud))inputs.set(file,text);
  }
  return inputs;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const roots=process.argv.slice(2);if(!roots.length)roots.push(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
  const inputs=new Map(roots.flatMap(root=>[...runtimeRepositories(resolve(root))]));
  const sites=auditRuntimeSources(inputs),violations=sites.filter(site=>site.rule);
  console.log(JSON.stringify({files:inputs.size,transportSites:sites.map(site=>({...site,file:relative(process.cwd(),site.file)})),violations:violations.length},null,2));
  process.exitCode=violations.length?1:0;
}
