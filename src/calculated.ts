import { executeQuery } from './index.js';
import type { Scalar, ColumnType } from './types.js';
import type { Calculation, CalculatedRequest } from './calculated-types.js';

function evaluate(e:Calculation, source:Map<string,Scalar>, values:Map<string,Scalar>):Scalar {
  if(e.kind==='literal')return e.value;
  if(e.kind==='source') {
    if(!source.has(e.name))throw Error('unknown source '+e.name);
    return source.get(e.name)!;
  }
  if(e.kind==='ref')return values.get(e.name) ?? null;
  if(e.kind==='choose') {
    const test=evaluate(e.test,source,values);
    const yes=evaluate(e.yes,source,values),no=evaluate(e.no,source,values);
    return test===true?yes:no;
  }
  const l=evaluate(e.left,source,values),r=evaluate(e.right,source,values);
  if(e.kind==='coalesce')return l || r;
  if(l===null || r===null)return null;
  if(typeof l!=='number'||typeof r!=='number')throw Error('numeric operand required');
  if(e.kind==='divide' && r===0)throw Error('division by zero');
  return e.kind==='add'?l+r:l/r;
}

export function executeCalculated(request:CalculatedRequest) {
  try {
    if(!Array.isArray(request.calculations)||!Array.isArray(request.select))throw Error('invalid calculated request');
    const names=new Set<string>();
    for(const c of request.calculations){if(!c.name||names.has(c.name))throw Error('duplicate calculation');names.add(c.name);}
    if(request.select.some(n=>!names.has(n)))throw Error('unknown selected calculation');
    const base=executeQuery(request.query);if(!base.ok)return base;
    const result=base.rows.map(row=>{
      const source=new Map(base.columns.map((c,i)=>[c.name,row.values[i]!]));
      const values=new Map<string,Scalar>();
      for(const c of request.calculations)values.set(c.name,evaluate(c.expression,source,values));
      return {values:request.select.map(n=>values.get(n)!),sourceIds:row.sourceIds};
    });
    const columns=request.select.map((name,i)=>({name,type:(typeof result[0]?.values[i]==='string'?'string':
      typeof result[0]?.values[i]==='boolean'?'boolean':'number') as ColumnType}));
    return {ok:true as const,columns,rows:result};
  }catch(e){return {ok:false as const,errors:[e instanceof Error?e.message:String(e)]};}
}
