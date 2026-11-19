import {pythonLanguage} from '@codemirror/lang-python';
import type {SyntaxNode} from '@lezer/common';

const builtins = new Set<string>(["ArithmeticError", "AssertionError", "AttributeError", "BaseException", "BlockingIOError", "BrokenPipeError", "BufferError", "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "DeprecationWarning", "EOFError", "Ellipsis", "EnvironmentError", "Exception", "False", "FileExistsError", "FileNotFoundError", "FloatingPointError", "FutureWarning", "GeneratorExit", "IOError", "ImportError", "ImportWarning", "IndentationError", "IndexError", "InterruptedError", "IsADirectoryError", "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError", "ModuleNotFoundError", "NameError", "None", "NotADirectoryError", "NotImplemented", "NotImplementedError", "OSError", "OverflowError", "PendingDeprecationWarning", "PermissionError", "ProcessLookupError", "RecursionError", "ReferenceError", "ResourceWarning", "RuntimeError", "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError", "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "True", "TypeError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError", "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning", "ValueError", "Warning", "ZeroDivisionError", "__build_class__", "__debug__", "__doc__", "__import__", "__loader__", "__name__", "__package__", "__spec__", "abs", "all", "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes", "callable", "chr", "classmethod", "compile", "complex", "copyright", "credits", "delattr", "dict", "dir", "divmod", "enumerate", "eval", "exec", "exit", "filter", "float", "format", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex", "id", "input", "int", "isinstance", "issubclass", "iter", "len", "license", "list", "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open", "ord", "pow", "print", "property", "quit", "range", "repr", "reversed", "round", "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super", "tuple", "type", "vars", "zip", "__name__", "__file__", "__package__", "__doc__"]);
export type PythonCompleteness = {missing:string[]; definitions:string[]; syntax:boolean};
/** Conservative static check of module expressions, never execution or a claim that a program will succeed.
 * Function/class bodies are lexical scopes, not module references. Dynamic namespace writes are unknown.
 */
export function pythonCompleteness(source:string, available:Iterable<string>=[]):PythonCompleteness {
  if(/^\s*(?:%%|%|!)/m.test(source))return {missing:[],definitions:[],syntax:true};
  const tree=pythonLanguage.parser.parse(source), definitions=new Set<string>(available), reads=new Set<string>();
  let syntax=true, dynamic=false;
  const text=(node:SyntaxNode)=>source.slice(node.from,node.to);
  const children=(node:SyntaxNode)=>{const result:SyntaxNode[]=[];for(let c=node.firstChild;c;c=c.nextSibling)result.push(c);return result;};
  const bind=(node:SyntaxNode)=>{
    if(node.name==='VariableName')definitions.add(text(node));
    else if(['TupleExpression','ArrayExpression','ParamList'].includes(node.name))children(node).forEach(bind);
  };
  const walk=(node:SyntaxNode)=>{
    if(node.type.isError)syntax=false;
    const parts=children(node);
    if(node.name==='ImportStatement') {
      // Import names and aliases; module components are not reads.
      let from=parts.some(p=>p.name==='from'), afterImport=false;
      for(let i=0;i<parts.length;i++) {
        const part=parts[i];if(part.name==='import'){afterImport=true;continue;}
        if(part.name==='*'){dynamic=true;continue;}
        if(part.name==='VariableName' && (!from || afterImport) && parts[i+1]?.name!=='.' && parts[i-1]?.name!=='.') {
          if(parts[i+1]?.name==='as')definitions.add(text(parts[i+2]));else definitions.add(text(part));
        }
        if(!from && part.name==='VariableName' && parts[i-1]?.name==='import')definitions.add(text(part));
      }
      return;
    }
    if(node.name==='FunctionDefinition' || node.name==='ClassDefinition') {
      const name=parts.find(p=>p.name==='VariableName');if(name)definitions.add(text(name));
      // Inspect bases/decorators/default expressions separately in the backend's AST check.
      return;
    }
    if(node.name==='AssignStatement' || node.name==='NamedExpression') {
      const op=parts.findIndex(p=>p.name==='AssignOp');
      for(const p of parts.slice(0,op))bind(p);
      for(const p of parts.slice(op+1))walk(p);
      return;
    }
    if(node.name==='ForStatement' || node.name==='ForInClause') {
      const until=parts.findIndex(p=>p.name==='in');
      for(const p of parts.slice(0,until))bind(p);
      for(const p of parts.slice(until+1))walk(p);
      return;
    }
    if(node.name==='LambdaExpression')return;
    if(node.name.includes('Comprehension')) {
      for(let i=0;i<parts.length;i++)if(parts[i].name==='for') {
        for(let j=i+1;j<parts.length && parts[j].name!=='in';j++)bind(parts[j]);
      }
    }
    if(node.name==='WithStatement' || node.name==='TryStatement') {
      for(let i=1;i<parts.length;i++)if(parts[i-1].name==='as')bind(parts[i]);
    }
    if(node.name==='ArgList') {
      parts.forEach((part,index)=>{if(!(part.name==='VariableName' && parts[index+1]?.name==='AssignOp'))walk(part);});return;
    }
    if(node.name==='VariableName') {
      const value=text(node);reads.add(value);
      if(['exec','eval','globals','locals'].includes(value))dynamic=true;
    }
    parts.forEach(walk);
  };
  walk(tree.topNode);
  // Parser errors inside deferred bodies still matter for a standalone program.
  tree.iterate({enter:node=>{if(node.type.isError)syntax=false;}});
  return {missing:dynamic?[]:[...reads].filter(name=>!definitions.has(name)&&!builtins.has(name)).sort(),definitions:[...definitions],syntax};
}
