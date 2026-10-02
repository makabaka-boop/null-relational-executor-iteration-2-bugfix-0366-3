/**
 * 派生计算列：在结构化查询结果之上定义彼此引用的计算列。
 *
 * 语义（与 README“派生计算列”一节一致）：
 * - `source` 引用查询输出列，`ref` 引用其他计算列；两个命名空间分开，
 *   同名源列不会覆盖计算列。声明顺序不参与语义（按需记忆化求值）。
 * - `add`/`divide`：任一操作数为 NULL 得 NULL；divide 右操作数为 0 是错误。
 * - `coalesce`：只跳过 NULL（0、false、'' 都是合法值），且右操作数短路不求值。
 * - `choose(test, yes, no)`：只求值被选分支；test === true 取 yes，否则取 no
 *   （test 为 NULL/false 都取 no）。
 * - 所有声明（即使没有被 select 选中）都必须：表达式结构合法、引用存在、无环、
 *   静态类型相容。全部校验先于任何行求值完成；任何错误整次拒绝，不返回部分结果。
 * - 输出列类型来自静态类型推导，因此空输入也返回正确的列类型。
 * - 袋语义与每行 sourceIds 直接来自原查询结果（逐行 1:1 映射，重复行保留）。
 */
import { executeQuery } from './index.js';
import type { Scalar, ColumnType, ColumnDef, QueryResult } from './types.js';
import type { Calculation, CalculationColumn } from './calculated-types.js';

/** 表达式静态类型：三种列类型，或 'null'（恒为 NULL，可流向任何类型） */
type CalcType = ColumnType | 'null';

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

/** 计算列名是“定义性名称”：非空且不含 '.' */
function isDefName(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && !x.includes('.');
}

/**
 * 结构校验：表达式形状（kind 枚举、字段存在、字面量取值）。
 * 发现错误全部记录到 errors；返回 false 表示该表达式不可用于后续类型推导。
 */
function checkExpression(raw: unknown, errors: string[], path: string): boolean {
  if (!isObject(raw) || typeof raw.kind !== 'string') {
    errors.push(`${path}: expression must be an object with a valid "kind"`);
    return false;
  }
  switch (raw.kind) {
    case 'literal':
      if (!isScalar(raw.value)) {
        errors.push(`${path}.value: must be a finite number, string, boolean or null`);
        return false;
      }
      return true;
    case 'source':
    case 'ref':
      if (typeof raw.name !== 'string' || raw.name.length === 0) {
        errors.push(`${path}.name: must be a non-empty string`);
        return false;
      }
      return true;
    case 'add':
    case 'divide':
    case 'coalesce': {
      const l = checkExpression(raw.left, errors, `${path}.left`);
      const r = checkExpression(raw.right, errors, `${path}.right`);
      return l && r;
    }
    case 'choose': {
      const t = checkExpression(raw.test, errors, `${path}.test`);
      const y = checkExpression(raw.yes, errors, `${path}.yes`);
      const n = checkExpression(raw.no, errors, `${path}.no`);
      return t && y && n;
    }
    default:
      errors.push(`${path}: unknown expression kind '${raw.kind}'`);
      return false;
  }
}

function failure(errors: string[]): QueryResult {
  return { ok: false, errors };
}

export function executeCalculated(request: unknown): QueryResult {
  try {
    // -- 第一阶段：请求本身的结构（形状错误直接拒绝，不执行查询） -----------
    if (!isObject(request)) {
      return failure([
        'calculated request: must be a JSON object with "query", "calculations" and "select"',
      ]);
    }
    const calcsRaw = request.calculations;
    const selectRaw = request.select;
    if (!Array.isArray(calcsRaw) || !Array.isArray(selectRaw)) {
      return failure([
        'calculations: must be an array of calculation declarations',
        'select: must be an array of calculation names',
      ]);
    }

    const errors: string[] = [];
    const calcs: CalculationColumn[] = [];
    const calcIndex = new Map<string, number>();
    const names = new Set<string>();
    calcsRaw.forEach((raw, i) => {
      const path = `calculations[${i}]`;
      if (!isObject(raw) || !isDefName(raw.name)) {
        errors.push(`${path}.name: must be a non-empty string without '.'`);
        return;
      }
      if (names.has(raw.name)) {
        errors.push(`${path}: duplicate calculation '${raw.name}'`);
        return;
      }
      names.add(raw.name);
      calcIndex.set(raw.name, i);
      calcs.push({ name: raw.name, expression: raw.expression as Calculation });
    });
    const select = selectRaw.filter((s): s is string => typeof s === 'string' && s.length > 0);
    if (select.length !== selectRaw.length) {
      errors.push('select: must contain only non-empty strings');
    }

    // -- 第二阶段：表达式结构校验（所有声明，含未被选中的） -----------------
    // 在执行底层查询之前完成：形状错误不会触发查询执行，也不返回部分结果。
    for (const c of calcs) {
      const path = `calculations[${calcIndex.get(c.name)}].expression`;
      checkExpression(c.expression, errors, path);
    }
    if (errors.length > 0) return failure(errors);

    // 第三阶段（执行）：先跑底层查询；查询本身失败时透传其校验错误（无部分结果）。
    const base = executeQuery(request.query);
    if (!base.ok) return base;

    // -- 第四阶段：静态语义：引用存在性、无环、类型相容 + 类型推导 ----------
    const byName = new Map(calcs.map((c) => [c.name, c]));
    const sourceTypes = new Map<string, ColumnType>(base.columns.map((c) => [c.name, c.type]));
    const types = new Map<string, CalcType>();
    const bad = new Set<string>();
    // 0 未访问 / 1 当前 DFS 栈上 / 2 已完成
    const color = new Map<string, 0 | 1 | 2>(calcs.map((c) => [c.name, 0]));

    const calcPath = (name: string) => `calculations[${calcIndex.get(name)}].expression`;

    function exprType(e: Calculation, path: string): CalcType | null {
      switch (e.kind) {
        case 'literal':
          return e.value === null ? 'null' : (typeof e.value as CalcType);
        case 'source': {
          const t = sourceTypes.get(e.name);
          if (t === undefined) {
            errors.push(`${path}: unknown source column '${e.name}'`);
            return null;
          }
          return t;
        }
        case 'ref':
          return resolveRef(e.name, path);
        case 'add':
        case 'divide': {
          const l = exprType(e.left, `${path}.left`);
          const r = exprType(e.right, `${path}.right`);
          let ok = true;
          if (l !== null && l !== 'null' && l !== 'number') {
            errors.push(`${path}.left: '${e.kind}' requires a numeric operand, got ${l}`);
            ok = false;
          }
          if (r !== null && r !== 'null' && r !== 'number') {
            errors.push(`${path}.right: '${e.kind}' requires a numeric operand, got ${r}`);
            ok = false;
          }
          return l === null || r === null || !ok ? null : 'number';
        }
        case 'coalesce': {
          const l = exprType(e.left, `${path}.left`);
          const r = exprType(e.right, `${path}.right`);
          if (l === null || r === null) return null;
          return commonType(l, r, path, 'coalesce operands');
        }
        case 'choose': {
          const t = exprType(e.test, `${path}.test`);
          const y = exprType(e.yes, `${path}.yes`);
          const n = exprType(e.no, `${path}.no`);
          if (t !== null && t !== 'null' && t !== 'boolean') {
            errors.push(`${path}.test: 'choose' condition must be boolean, got ${t}`);
          }
          if (y === null || n === null) return null;
          return commonType(y, n, path, 'choose branches');
        }
      }
    }

    function commonType(a: CalcType, b: CalcType, path: string, what: string): CalcType | null {
      if (a === 'null') return b;
      if (b === 'null') return a;
      if (a === b) return a;
      errors.push(`${path}: type mismatch in ${what} (${a} vs ${b})`);
      return null;
    }

    function resolveRef(name: string, path: string): CalcType | null {
      if (!names.has(name)) {
        errors.push(`${path}: unknown calculation reference '${name}'`);
        return null;
      }
      const state = color.get(name)!;
      if (state === 2) return bad.has(name) ? null : (types.get(name) ?? null);
      if (state === 1) {
        errors.push(`${path}: circular reference involving calculation '${name}'`);
        return null;
      }
      color.set(name, 1);
      const t = exprType(byName.get(name)!.expression, calcPath(name));
      color.set(name, 2);
      if (t === null) {
        bad.add(name);
        return null;
      }
      types.set(name, t);
      return t;
    }

    // 所有声明都必须无环、引用合法、类型相容——即使最终没有 select 它。
    for (const c of calcs) resolveRef(c.name, calcPath(c.name));

    // select 列表校验：存在、不重复、有具体列类型（恒 NULL 的表达式无法作列）。
    const selected: string[] = [];
    const seenSelect = new Set<string>();
    for (const name of select) {
      if (!names.has(name)) {
        errors.push(`select: unknown calculation '${name}'`);
        continue;
      }
      if (seenSelect.has(name)) {
        errors.push(`select: duplicate output column '${name}'`);
        continue;
      }
      seenSelect.add(name);
      selected.push(name);
      if (!bad.has(name) && types.get(name) === 'null') {
        errors.push(`select: calculation '${name}' is always null and has no column type`);
      }
    }

    if (errors.length > 0) return failure(errors);

    // -- 第五阶段：逐行求值（校验全部通过后才开始；不产生部分结果） ---------
    const columns: ColumnDef[] = selected.map((name) => ({
      name,
      type: types.get(name) as ColumnType,
    }));

    const rows = base.rows.map((row) => {
      const sourceValues = new Map<string, Scalar>(
        base.columns.map((c, i) => [c.name, row.values[i] ?? null]),
      );
      const memo = new Map<string, Scalar>();

      function evalExpr(e: Calculation, owner: string): Scalar {
        switch (e.kind) {
          case 'literal':
            return e.value;
          case 'source':
            return sourceValues.get(e.name) ?? null;
          case 'ref':
            return valueOf(e.name);
          // 只求值被选分支：未选分支中的除零等错误不会影响本行。
          case 'choose': {
            const test = evalExpr(e.test, owner);
            return test === true
              ? evalExpr(e.yes, owner)
              : evalExpr(e.no, owner);
          }
          // 短路：左值非 NULL（含 0/false/''）时直接返回，不求值右侧。
          case 'coalesce': {
            const left = evalExpr(e.left, owner);
            return left === null ? evalExpr(e.right, owner) : left;
          }
          case 'add':
          case 'divide': {
            const l = evalExpr(e.left, owner);
            const r = evalExpr(e.right, owner);
            if (l === null || r === null) return null;
            if (typeof l !== 'number' || typeof r !== 'number') {
              throw new Error(`calculation '${owner}': numeric operand required`);
            }
            if (e.kind === 'divide' && r === 0) {
              throw new Error(`calculation '${owner}': division by zero`);
            }
            return e.kind === 'add' ? l + r : l / r;
          }
        }
      }

      function valueOf(name: string): Scalar {
        if (memo.has(name)) return memo.get(name)!;
        const value = evalExpr(byName.get(name)!.expression, name);
        memo.set(name, value);
        return value;
      }

      // 按需求值：未被 select（及其引用闭包）触及的声明不会被执行。
      return { values: selected.map(valueOf), sourceIds: row.sourceIds };
    });

    return { ok: true, columns, rows };
  } catch (err) {
    // 校验通过后的运行期错误（如除零）同样整次拒绝。
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
