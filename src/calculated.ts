/**
 * 派生计算列：在结构化查询结果上定义彼此引用的计算列。
 * 与查询引擎同一哲学 —— 先完成全部静态校验，再执行；
 * 任何错误都整次拒绝，绝不返回部分结果。
 *
 * 语义（README「派生计算列」）：
 * - 声明顺序不参与语义：ref 可引用任何已声明的计算列，与位置无关；
 * - source 与 ref 分开命名：同名源列不会覆盖计算列；
 * - 算术遇 NULL 得 NULL；coalesce 只跳过 NULL（0 / false / '' 都是合法值）；
 * - choose 只求值被选分支，NULL 条件选择 no；
 * - 所有声明（即使没选择输出）必须无环、引用合法、静态类型相容；
 * - 列类型由表达式静态推导，空输入也返回正确列类型；
 * - 袋语义与每行 sourceIds 原样来自原查询。
 */
import { executeQuery } from './index.js';
import type { ColumnDef, ColumnType, OutputRow, QueryResult, Scalar } from './types.js';
import type { Calculation, CalculationColumn, CalculatedRequest } from './calculated-types.js';

// ---------------------------------------------------------------------------
// 第一阶段：结构校验 —— 未受信 JSON → 带类型模型（只查形状，不查引用与类型）
// ---------------------------------------------------------------------------

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isScalar(x: unknown): x is Scalar {
  return (
    x === null ||
    typeof x === 'string' ||
    typeof x === 'boolean' ||
    (typeof x === 'number' && Number.isFinite(x))
  );
}

/** 计算列名：非空字符串（与源列分属不同命名空间，允许同名） */
function isCalcName(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function parseCalculatedRequest(raw: unknown, errors: string[]): CalculatedRequest | null {
  if (!isObject(raw)) {
    errors.push('request: must be a JSON object with "query", "calculations" and "select"');
    return null;
  }
  const calculations = parseCalculations(raw.calculations, errors);
  const select = parseSelect(raw.select, errors);
  // query 本身的结构与语义校验由 executeQuery 完成
  if (calculations === null || select === null) return null;
  return { query: raw.query, calculations, select };
}

function parseCalculations(raw: unknown, errors: string[]): CalculationColumn[] | null {
  if (!Array.isArray(raw)) {
    errors.push('calculations: must be an array of { name, expression }');
    return null;
  }
  let ok = true;
  const names = new Set<string>();
  const calculations: CalculationColumn[] = [];
  raw.forEach((rawCalc, i) => {
    const path = `calculations[${i}]`;
    if (!isObject(rawCalc)) {
      errors.push(`${path}: calculation must be an object { name, expression }`);
      ok = false;
      return;
    }
    if (!isCalcName(rawCalc.name)) {
      errors.push(`${path}.name: must be a non-empty string`);
      ok = false;
      return;
    }
    if (names.has(rawCalc.name)) {
      errors.push(`${path}.name: duplicate calculation name '${rawCalc.name}'`);
      ok = false;
      return;
    }
    names.add(rawCalc.name);
    const expression = parseExpression(rawCalc.expression, errors, `${path}.expression`);
    if (expression === null) {
      ok = false;
      return;
    }
    calculations.push({ name: rawCalc.name, expression });
  });
  return ok ? calculations : null;
}

function parseSelect(raw: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push('select: must be an array of calculation names');
    return null;
  }
  let ok = true;
  const seen = new Set<string>();
  const select: string[] = [];
  raw.forEach((name, i) => {
    if (!isCalcName(name)) {
      errors.push(`select[${i}]: must be a non-empty string`);
      ok = false;
      return;
    }
    // 输出列名唯一（与查询引擎的输出列不变式一致）
    if (seen.has(name)) {
      errors.push(`select[${i}]: duplicate output column '${name}'`);
      ok = false;
      return;
    }
    seen.add(name);
    select.push(name);
  });
  return ok ? select : null;
}

function parseExpression(raw: unknown, errors: string[], path: string): Calculation | null {
  if (!isObject(raw)) {
    errors.push(`${path}: expression must be an object with a "kind" field`);
    return null;
  }
  switch (raw.kind) {
    case 'source':
    case 'ref': {
      if (!isCalcName(raw.name)) {
        errors.push(`${path}.name: must be a non-empty string`);
        return null;
      }
      return { kind: raw.kind, name: raw.name };
    }
    case 'literal': {
      if (!('value' in raw) || !isScalar(raw.value)) {
        errors.push(`${path}.value: must be a finite number, string, boolean, or null`);
        return null;
      }
      return { kind: 'literal', value: raw.value };
    }
    case 'add':
    case 'divide':
    case 'coalesce': {
      const left = parseExpression(raw.left, errors, `${path}.left`);
      const right = parseExpression(raw.right, errors, `${path}.right`);
      return left !== null && right !== null ? { kind: raw.kind, left, right } : null;
    }
    case 'choose': {
      const test = parseExpression(raw.test, errors, `${path}.test`);
      const yes = parseExpression(raw.yes, errors, `${path}.yes`);
      const no = parseExpression(raw.no, errors, `${path}.no`);
      return test !== null && yes !== null && no !== null
        ? { kind: 'choose', test, yes, no }
        : null;
    }
    default:
      errors.push(
        `${path}.kind: unknown expression kind ${JSON.stringify(raw.kind)} (expected source | ref | literal | add | divide | coalesce | choose)`,
      );
      return null;
  }
}

// ---------------------------------------------------------------------------
// 第二阶段：语义校验 —— 引用合法、无环、静态类型相容，覆盖所有声明
// （即使没选择输出），因此空输入也会拒绝循环引用与未知引用
// ---------------------------------------------------------------------------

/** 表达式静态类型：三种列类型之一，或 'null'（字面量 NULL，与任何类型相容） */
type ExprType = ColumnType | 'null';

interface CalcEntry {
  index: number;
  expression: Calculation;
  /** 表达式内直接引用的其他计算列名 */
  refs: string[];
}

function collectRefs(e: Calculation, out: string[]): void {
  switch (e.kind) {
    case 'ref':
      out.push(e.name);
      return;
    case 'source':
    case 'literal':
      return;
    case 'add':
    case 'divide':
    case 'coalesce':
      collectRefs(e.left, out);
      collectRefs(e.right, out);
      return;
    case 'choose':
      collectRefs(e.test, out);
      collectRefs(e.yes, out);
      collectRefs(e.no, out);
      return;
  }
}

/**
 * 校验全部声明并推导 select 列的静态类型。
 * 发现错误只记录不执行：返回 null 时 errors 非空。
 */
function checkCalculations(
  calculations: CalculationColumn[],
  select: string[],
  sourceColumns: ColumnDef[],
  errors: string[],
): Map<string, ColumnType> | null {
  const entries = new Map<string, CalcEntry>();
  calculations.forEach((c, index) => {
    const refs: string[] = [];
    collectRefs(c.expression, refs);
    entries.set(c.name, { index, expression: c.expression, refs });
  });

  // select 必须引用已声明的计算列
  select.forEach((name, i) => {
    if (!entries.has(name)) {
      errors.push(`select[${i}]: unknown calculation '${name}'`);
    }
  });

  // ref 必须引用已声明的计算列（source 列名在类型推导阶段按查询输出模式检查）
  for (const entry of entries.values()) {
    checkRefs(entry.expression, entries, errors, `calculations[${entry.index}].expression`);
  }

  // 无环：对全部声明做深度优先遍历（声明顺序不参与语义）
  checkCycles(entries, errors);

  // 静态类型推导；对未知引用与环回边返回 null（错误已报告，不重复）
  const types = inferTypes(entries, sourceColumns, errors);
  if (errors.length > 0) return null;

  const selected = new Map<string, ColumnType>();
  select.forEach((name, i) => {
    const t = types.get(name)!;
    if (t === 'null') {
      errors.push(
        `select[${i}]: cannot determine a column type for '${name}' (expression is always NULL)`,
      );
      return;
    }
    selected.set(name, t);
  });
  return errors.length > 0 ? null : selected;
}

function checkRefs(
  e: Calculation,
  entries: Map<string, CalcEntry>,
  errors: string[],
  path: string,
): void {
  switch (e.kind) {
    case 'ref':
      if (!entries.has(e.name)) {
        errors.push(`${path}.name: unknown calculation '${e.name}'`);
      }
      return;
    case 'source':
    case 'literal':
      return;
    case 'add':
    case 'divide':
    case 'coalesce':
      checkRefs(e.left, entries, errors, `${path}.left`);
      checkRefs(e.right, entries, errors, `${path}.right`);
      return;
    case 'choose':
      checkRefs(e.test, entries, errors, `${path}.test`);
      checkRefs(e.yes, entries, errors, `${path}.yes`);
      checkRefs(e.no, entries, errors, `${path}.no`);
      return;
  }
}

function checkCycles(entries: Map<string, CalcEntry>, errors: string[]): void {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      errors.push(`calculations: circular reference ${cycle.map((n) => `'${n}'`).join(' -> ')}`);
      return;
    }
    const entry = entries.get(name);
    if (entry === undefined) return; // 未知引用已在引用检查中报告
    state.set(name, 'visiting');
    stack.push(name);
    for (const ref of entry.refs) visit(ref);
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of entries.keys()) visit(name);
}

function literalType(value: Scalar): ExprType {
  if (value === null) return 'null';
  return typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'boolean';
}

/** 公共类型：相同类型相容；'null' 与任何类型相容（结果取另一方） */
function commonType(a: ExprType, b: ExprType): ExprType | null {
  if (a === 'null') return b;
  if (b === 'null') return a;
  return a === b ? a : null;
}

/**
 * 推导全部声明的静态类型（含 source 列名检查）。
 * 每个声明只推导一次（记忆化）；未知引用与环回边返回 null，
 * 对应错误已在引用/环检查阶段报告。
 */
function inferTypes(
  entries: Map<string, CalcEntry>,
  sourceColumns: ColumnDef[],
  errors: string[],
): Map<string, ExprType> {
  const sourceTypes = new Map(sourceColumns.map((c) => [c.name, c.type]));
  const memo = new Map<string, ExprType | null>();
  const inProgress = new Set<string>();

  const inferCalc = (name: string): ExprType | null => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const entry = entries.get(name);
    if (entry === undefined || inProgress.has(name)) return null; // 已报告
    inProgress.add(name);
    const t = inferExpr(entry.expression, `calculations[${entry.index}].expression`);
    inProgress.delete(name);
    memo.set(name, t);
    return t;
  };

  const inferExpr = (e: Calculation, path: string): ExprType | null => {
    switch (e.kind) {
      case 'literal':
        return literalType(e.value);
      case 'source': {
        const t = sourceTypes.get(e.name);
        if (t === undefined) {
          errors.push(`${path}.name: unknown source column '${e.name}'`);
          return null;
        }
        return t;
      }
      case 'ref':
        return inferCalc(e.name);
      case 'add':
      case 'divide': {
        const lt = inferExpr(e.left, `${path}.left`);
        const rt = inferExpr(e.right, `${path}.right`);
        if (lt === null || rt === null) return null;
        if ((lt !== 'number' && lt !== 'null') || (rt !== 'number' && rt !== 'null')) {
          errors.push(`${path}: '${e.kind}' requires numeric operands, got ${lt} and ${rt}`);
          return null;
        }
        return 'number';
      }
      case 'coalesce': {
        const lt = inferExpr(e.left, `${path}.left`);
        const rt = inferExpr(e.right, `${path}.right`);
        if (lt === null || rt === null) return null;
        const t = commonType(lt, rt);
        if (t === null) {
          errors.push(`${path}: 'coalesce' operands must have the same type, got ${lt} and ${rt}`);
        }
        return t;
      }
      case 'choose': {
        const tt = inferExpr(e.test, `${path}.test`);
        const yt = inferExpr(e.yes, `${path}.yes`);
        const nt = inferExpr(e.no, `${path}.no`);
        let ok = true;
        if (tt !== null && tt !== 'boolean' && tt !== 'null') {
          errors.push(`${path}.test: 'choose' test must be boolean, got ${tt}`);
          ok = false;
        }
        if (yt === null || nt === null) return null;
        const t = commonType(yt, nt);
        if (t === null) {
          errors.push(`${path}: 'choose' branches must have the same type, got ${yt} and ${nt}`);
          ok = false;
        }
        return ok ? t : null;
      }
    }
  };

  // 所有声明（即使没选择输出）都必须静态类型相容
  const types = new Map<string, ExprType>();
  for (const [name] of entries) {
    const t = inferCalc(name);
    if (t !== null) types.set(name, t);
  }
  return types;
}

// ---------------------------------------------------------------------------
// 第三阶段：执行 —— 按 select 需求驱动求值（未选择的声明不求值），
// 每行独立记忆化；静态校验已保证引用合法且无环，递归必然终止
// ---------------------------------------------------------------------------

/** 求值期错误（如除零）：与校验错误一样整次拒绝 */
class EvaluationError extends Error {}

function evaluateRows(
  calculations: CalculationColumn[],
  select: string[],
  baseColumns: ColumnDef[],
  baseRows: OutputRow[],
): OutputRow[] {
  const byName = new Map(calculations.map((c) => [c.name, c.expression]));
  return baseRows.map((row) => {
    const source = new Map<string, Scalar>(baseColumns.map((c, i) => [c.name, row.values[i]!]));
    const memo = new Map<string, Scalar>();

    const evalCalc = (name: string): Scalar => {
      if (memo.has(name)) return memo.get(name)!;
      const expression = byName.get(name)!; // 静态校验保证存在
      let value: Scalar;
      try {
        value = evalExpr(expression);
      } catch (err) {
        if (err instanceof EvaluationError) throw err;
        throw new EvaluationError(
          `calculation '${name}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      memo.set(name, value);
      return value;
    };

    const evalExpr = (e: Calculation): Scalar => {
      switch (e.kind) {
        case 'literal':
          return e.value;
        case 'source':
          return source.get(e.name) ?? null; // 列名已校验；?? null 仅作防御
        case 'ref':
          return evalCalc(e.name);
        case 'choose': {
          // 只求值被选分支；NULL 条件选择 no
          const test = evalExpr(e.test);
          return test === true ? evalExpr(e.yes) : evalExpr(e.no);
        }
        case 'coalesce': {
          // 只跳过 NULL：0、false、'' 都是合法值
          const l = evalExpr(e.left);
          const r = evalExpr(e.right);
          return l === null ? r : l;
        }
        case 'add':
        case 'divide': {
          const l = evalExpr(e.left);
          const r = evalExpr(e.right);
          if (l === null || r === null) return null; // 算术遇 NULL 得 NULL
          if (typeof l !== 'number' || typeof r !== 'number') {
            throw new EvaluationError('internal: non-numeric operand after static checks');
          }
          if (e.kind === 'divide' && r === 0) throw new Error('division by zero');
          return e.kind === 'add' ? l + r : l / r;
        }
      }
    };

    // 袋语义与来源证据原样透传：每行一一对应，不去重
    return { values: select.map(evalCalc), sourceIds: row.sourceIds };
  });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function executeCalculated(request: unknown): QueryResult {
  const errors: string[] = [];

  // 第一阶段：结构校验
  const parsed = parseCalculatedRequest(request, errors);
  if (parsed === null || errors.length > 0) return { ok: false, errors };

  // 第二阶段：执行原查询（其自身完成全部校验；失败则整次拒绝）
  const base = executeQuery(parsed.query);
  if (!base.ok) return base;

  // 第三阶段：计算列语义校验 —— 所有声明必须无环、引用合法、静态类型相容
  const selected = checkCalculations(parsed.calculations, parsed.select, base.columns, errors);
  if (selected === null || errors.length > 0) return { ok: false, errors };

  // 第四阶段：按 select 需求驱动求值；列类型来自静态推导，与数据行无关
  try {
    const rows = evaluateRows(parsed.calculations, parsed.select, base.columns, base.rows);
    const columns: ColumnDef[] = parsed.select.map((name) => ({
      name,
      type: selected.get(name)!,
    }));
    return { ok: true, columns, rows };
  } catch (err) {
    // 求值期错误（如除零）同样整次拒绝，不返回部分结果
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
}
