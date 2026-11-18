import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type ts from 'typescript';

type Literal = string | Literal[] | undefined;
type Scope = Map<string, Literal>;
type Source = { file: string, content: string };
type Route = { path: string, method: string, file: string, line: number };

// Resolve registration expressions without loading or executing application code.
export async function stockRoutes(root: string, t: typeof ts) {
  const routes: Route[] = [], sources: Source[] = [];
  const seen = new Set<string>();
  const roots = /\/modules\/(inventory|production|reports)\//;
  const entry = 'apps/api-ts/src/app.ts';

  function literal(node: ts.Expression, scope: Scope): Literal {
    if (t.isStringLiteralLike(node)) return node.text;
    if (t.isIdentifier(node)) return scope.get(node.text);
    if (t.isAsExpression(node) || t.isParenthesizedExpression(node)) return literal(node.expression, scope);
    if (t.isArrayLiteralExpression(node)) return node.elements.map(element => literal(element, scope));
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.PlusToken) {
      const left=literal(node.left,scope), right=literal(node.right,scope);
      if (typeof left === 'string' && typeof right === 'string') return left + right;
    }
    if (t.isTemplateExpression(node)) {
      let value=node.head.text;
      for(const span of node.templateSpans) {
        const field=literal(span.expression,scope);
        if(typeof field!=='string')return;
        value+=field+span.literal.text;
      }
      return value;
    }
  }

  async function inspect(file: string, name: string) {
    const key=file+'#'+name;
    if(seen.has(key))return;
    seen.add(key);
    const content=await readFile(path.join(root,file),'utf8');
    sources.push({file,content});
    const source=t.createSourceFile(file,content,t.ScriptTarget.Latest,true);
    const imports=new Map<string,{file:string,name:string}>();
    for(const statement of source.statements) {
      if(!t.isImportDeclaration(statement)||!t.isStringLiteral(statement.moduleSpecifier))continue;
      const bindings=statement.importClause?.namedBindings, specifier=statement.moduleSpecifier.text;
      if(!specifier.startsWith('.')||!bindings||!t.isNamedImports(bindings))continue;
      const dependency=path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier.replace(/\.js$/,'.ts')));
      for(const item of bindings.elements)imports.set(item.name.text,{file:dependency,name:item.propertyName?.text??item.name.text});
    }
    const fn=source.statements.find((node):node is ts.FunctionDeclaration=>t.isFunctionDeclaration(node)&&node.name?.text===name);
    if(!fn?.body)throw Error('Registro Fastify ausente em '+key);
    const children:{file:string,name:string}[]=[];
    function visit(node:ts.Node,scope:Scope) {
      if(t.isFunctionLike(node))return; // Handler bodies never register routes.
      if(t.isBlock(node)) {
        const block=new Map(scope);
        for(const statement of node.statements)visit(statement,block);
        return;
      }
      if(t.isVariableDeclaration(node)&&t.isIdentifier(node.name)&&node.initializer)scope.set(node.name.text,literal(node.initializer,scope));
      if(t.isForOfStatement(node)&&t.isVariableDeclarationList(node.initializer)) {
        const values=literal(node.expression,scope), binding=node.initializer.declarations[0]?.name;
        if(!Array.isArray(values)||!binding)throw Error('Laço de registro sem destinos literais em '+key);
        for(const value of values){
          const loop=new Map(scope);
          if(t.isIdentifier(binding))loop.set(binding.text,value);
          else if(t.isArrayBindingPattern(binding)&&Array.isArray(value))binding.elements.forEach((element,i)=>{
            if(t.isBindingElement(element)&&t.isIdentifier(element.name))loop.set(element.name.text,value[i]);
          });
          visit(node.statement,loop);
        }
        return;
      }
      if(t.isCallExpression(node)) {
        const callee=node.expression;
        if(t.isIdentifier(callee)&&callee.text.startsWith('register')&&node.arguments[0]?.getText(source)==='app') {
          const child=imports.get(callee.text);
          if(child&&roots.test(child.file))children.push(child);
        }
        if(file!==entry&&t.isPropertyAccessExpression(callee)&&callee.expression.getText(source)==='app'&&/^(get|post|put|patch|delete)$/.test(callee.name.text)) {
          const url=literal(node.arguments[0],scope);
          if(typeof url!=='string')throw Error('Destino Fastify indefinido em '+key);
          if(/^\/api\/v1\/(stock|production|inventory-counts|inventory-settings)(\/|$)/.test(url))
            routes.push({method:callee.name.text.toUpperCase(),path:url.replace(/:(\w+)/g,'{$1}'),file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
        }
      }
      t.forEachChild(node,child=>visit(child,scope));
    }
    visit(fn.body,new Map());
    for(const child of children)await inspect(child.file,child.name);
  }
  try { await inspect(entry,'buildApp'); }
  catch(error){if(!(error instanceof Error && 'code' in error && error.code==='ENOENT' && seen.size===1))throw error;}
  return {routes,sources};
}
