/**
 * 派生计算列：声明顺序不参与语义、choose 只求值被选分支、coalesce 只跳过 NULL、
 * 静态校验（无环 / 引用合法 / 类型相容）与数据行无关、列类型静态推导、
 * 袋语义与 sourceIds 透传、错误整次拒绝。
 * 随机化部分用「ref 代入展开 + 封闭表达式求值」的独立参考实现交叉核对，
 * 并验证同一组定义在任意声明顺序下结果一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { executeCalculated } from '../src/calculated.js';
import type { Calculation, CalculationColumn } from '../src/calculated-types.js';
import { createServer } from '../src/server.js';
import type { ColumnDef, ColumnType, Scalar } from '../src/index.js';
import { rng, scan, table } from './helpers.js';

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

const src = (name: string): Calculation => ({ kind: 'source', name });
const refC = (name: string): Calculation => ({ kind: 'ref', name });
const litC = (value: Scalar): Calculation => ({ kind: 'literal', value });
const add = (left: Calculation, right: Calculation): Calculation => ({ kind: 'add', left, right });
const div = (left: Calculation, right: Calculation): Calculation => ({
  kind: 'divide',
  left,
  right,
});
const coal = (left: Calculation, right: Calculation): Calculation => ({
  kind: 'coalesce',
  left,
  right,
});
const choose = (test: Calculation, yes: Calculation, no: Calculation): Calculation => ({
  kind: 'choose',
  test,
  yes,
  no,
});
const calc = (name: string, expression: Calculation): CalculationColumn => ({ name, expression });

const sales = table(
  'sales',
  [
    ['n', 'number'],
    ['s', 'string'],
    ['b', 'boolean'],
  ],
  [
    ['r1', 100, '', false],
    ['r2', 0, 'x', true],
    ['r3', null, null, null],
  ],
);
const query = { tables: [sales], plan: scan('sales') };

function expectFailure(request: unknown, pattern: RegExp): void {
  const result = executeCalculated(request);
  assert.ok(!result.ok, `expected failure, got ${JSON.stringify(result)}`);
  // 错误响应不得携带任何部分结果
  assert.ok(!('rows' in result), 'failure must not contain partial rows');
  assert.ok(!('columns' in result), 'failure must not contain partial columns');
  assert.ok(result.errors.length > 0, 'must report at least one error');
  assert.match(
    result.errors.join('\n'),
    pattern,
    `errors ${JSON.stringify(result.errors)} should match ${pattern}`,
  );
}

// ---------------------------------------------------------------------------
// 声明顺序不参与语义
// ---------------------------------------------------------------------------

test('声明顺序不参与语义：前向引用与后向引用结果一致', () => {
  const a = calc('a', add(src('n'), litC(1)));
  const b = calc('b', add(refC('a'), litC(10)));
  const c = calc('c', coal(refC('b'), litC(0)));
  const forward = executeCalculated({ query, calculations: [c, b, a], select: ['c', 'b'] });
  const backward = executeCalculated({ query, calculations: [a, b, c], select: ['c', 'b'] });
  assert.ok(forward.ok && backward.ok);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward.columns, [
    { name: 'c', type: 'number' },
    { name: 'b', type: 'number' },
  ]);
  // r1: n=100 → b=111, c=111；r2: n=0 → b=11, c=11；r3: n=null → b=null, c=0
  assert.deepEqual(
    forward.rows.map((r) => r.values),
    [
      [111, 111],
      [11, 11],
      [0, null],
    ],
  );
});

// ---------------------------------------------------------------------------
// choose：只求值被选分支；NULL 条件选择 no
// ---------------------------------------------------------------------------

test('choose 只求值被选分支：未选中分支的除零不影响结果', () => {
  const result = executeCalculated({
    query: {
      tables: [table('t', [['b', 'boolean']], [['a', true], ['c', false]])],
      plan: scan('t'),
    },
    calculations: [
      calc(
        'c',
        choose(
          src('b'),
          div(litC(1), litC(0)), // TRUE 行选中此分支 —— 但只在 b=true 时才会出错
          litC(7),
        ),
      ),
    ],
    select: ['c'],
  });
  // b=true 的行选中了除零分支 → 整次拒绝
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /division by zero/);

  // 调换分支：除零只在 no 分支，b=true 的行不触碰它
    const ok = executeCalculated({
    query: {
      tables: [table('t', [['b', 'boolean']], [['a', true], ['c', false]])],
      plan: scan('t'),
    },
    calculations: [calc('c', choose(src('b'), litC(7), div(litC(1), litC(0))))],
    select: ['c'],
  });
  // b=false 的行选中了除零分支 → 仍然整次拒绝
  assert.ok(!ok.ok);

  // 全部行为 TRUE：no 分支（除零）从未被选中 → 成功
  const allTrue = executeCalculated({
    query: {
      tables: [
        table('t', [['b', 'boolean'], ['n', 'number']], [
          ['a', true, 1],
          ['c', true, 2],
        ]),
      ],
      plan: scan('t'),
    },
    calculations: [calc('c', choose(src('b'), src('n'), div(litC(1), litC(0))))],
    select: ['c'],
  });
  assert.ok(allTrue.ok, JSON.stringify(allTrue));
  assert.deepEqual(
    allTrue.rows.map((r) => r.values),
    [[1], [2]],
  );
});

test('choose：FALSE 与 NULL 条件都选择 no 分支', () => {
  const result = executeCalculated({
    query,
    calculations: [calc('c', choose(src('b'), litC('yes'), litC('no')))],
    select: ['c'],
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [['no'], ['yes'], ['no']], // r1: b=false → no；r2: b=true → yes；r3: b=null → no
  );
  assert.deepEqual(result.columns, [{ name: 'c', type: 'string' }]);
});

// ---------------------------------------------------------------------------
// coalesce：只跳过 NULL（0 / false / '' 都是合法值）
// ---------------------------------------------------------------------------

test('coalesce 只跳过 NULL：零、false、空字符串不被替换', () => {
  const result = executeCalculated({
    query,
    calculations: [
      calc('zn', coal(src('n'), litC(999))),
      calc('zs', coal(src('s'), litC('fallback'))),
      calc('zb', coal(src('b'), litC(true))),
    ],
    select: ['zn', 'zs', 'zb'],
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      [100, '', false], // r1：0 之外的 falsy（''、false）原样保留
      [0, 'x', true], // r2：0 原样保留
      [999, 'fallback', true], // r3：NULL 才回退
    ],
  );
});

test('coalesce：两侧都为 NULL 时结果为 NULL', () => {
  const result = executeCalculated({
    query,
    calculations: [calc('c', coal(src('n'), litC(null)))],
    select: ['c'],
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [[100], [0], [null]],
  );
  assert.deepEqual(result.columns, [{ name: 'c', type: 'number' }]);
});

// ---------------------------------------------------------------------------
// 算术：遇 NULL 得 NULL；除零整次拒绝
// ---------------------------------------------------------------------------

test('算术遇 NULL 得 NULL', () => {
  const result = executeCalculated({
    query,
    calculations: [
      calc('p', add(src('n'), litC(1))),
      calc('q', div(src('n'), litC(2))),
    ],
    select: ['p', 'q'],
  });
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      [101, 50],
      [1, 0],
      [null, null],
    ],
  );
});

test('除零：整次拒绝且不返回部分结果', () => {
  expectFailure(
    {
      query,
      calculations: [calc('r', div(src('n'), src('n')))],
      select: ['r'],
    },
    /division by zero/,
  );
});

test('需求驱动：未选择的声明不求值，其运行期错误不影响结果', () => {
  const result = executeCalculated({
    query,
    calculations: [
      calc('used', src('n')),
      calc('unused', div(litC(1), litC(0))),
    ],
    select: ['used'],
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [[100], [0], [null]],
  );
});

// ---------------------------------------------------------------------------
// 静态校验：与数据行无关（空输入同样拒绝），覆盖所有声明
// ---------------------------------------------------------------------------

const emptyQuery = {
  tables: [table('t', [['n', 'number']], [])],
  plan: scan('t'),
};

test('空输入：循环引用仍被拒绝（自环 / 互环 / 长链）', () => {
  expectFailure(
    { query: emptyQuery, calculations: [calc('a', refC('a'))], select: ['a'] },
    /circular reference 'a' -> 'a'/,
  );
  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('a', refC('b')), calc('b', refC('a'))],
      select: ['a'],
    },
    /circular reference 'a' -> 'b' -> 'a'/,
  );
  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('a', refC('b')), calc('b', refC('c')), calc('c', refC('a'))],
      select: ['b'],
    },
    /circular reference/,
  );
});

test('空输入：未知 ref 与未知 source 列仍被拒绝', () => {
  expectFailure(
    { query: emptyQuery, calculations: [calc('a', refC('ghost'))], select: ['a'] },
    /unknown calculation 'ghost'/,
  );
  expectFailure(
    { query: emptyQuery, calculations: [calc('a', src('ghost'))], select: ['a'] },
    /unknown source column 'ghost'/,
  );
});

test('空输入：静态类型错误仍被拒绝', () => {
  expectFailure(
    { query: emptyQuery, calculations: [calc('a', add(litC('x'), litC(1)))], select: ['a'] },
    /'add' requires numeric operands, got string and number/,
  );
  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('a', choose(litC(1), litC(1), litC(2)))],
      select: ['a'],
    },
    /'choose' test must be boolean, got number/,
  );
  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('a', choose(litC(true), litC(1), litC('x')))],
      select: ['a'],
    },
    /'choose' branches must have the same type, got number and string/,
  );
  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('a', coal(litC(1), litC('x')))],
      select: ['a'],
    },
    /'coalesce' operands must have the same type, got number and string/,
  );
});

test('未选择的声明也必须无环、引用合法、静态类型相容', () => {
  expectFailure(
    {
      query,
      calculations: [calc('used', src('n')), calc('unused', refC('ghost'))],
      select: ['used'],
    },
    /unknown calculation 'ghost'/,
  );
  expectFailure(
    {
      query,
      calculations: [calc('used', src('n')), calc('unused', add(litC('x'), litC(1)))],
      select: ['used'],
    },
    /requires numeric operands/,
  );
  expectFailure(
    {
      query,
      calculations: [calc('used', src('n')), calc('x', refC('y')), calc('y', refC('x'))],
      select: ['used'],
    },
    /circular reference/,
  );
});

// ---------------------------------------------------------------------------
// 列类型：静态推导，空输入也返回正确列类型
// ---------------------------------------------------------------------------

test('空输入也返回正确列类型（类型来自表达式而非数据行）', () => {
  const result = executeCalculated({
    query: emptyQuery,
    calculations: [
      calc('num', add(src('n'), litC(1))),
      calc('str', coal(litC(null), litC('x'))),
      calc('bool', choose(litC(null), litC(true), litC(false))),
      calc('quo', div(src('n'), litC(2))),
    ],
    select: ['num', 'str', 'bool', 'quo'],
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.columns, [
    { name: 'num', type: 'number' },
    { name: 'str', type: 'string' },
    { name: 'bool', type: 'boolean' },
    { name: 'quo', type: 'number' },
  ]);
  assert.deepEqual(result.rows, []);
});

test('首行值为 NULL 不污染列类型', () => {
  const result = executeCalculated({
    query: {
      tables: [
        table('t', [['s', 'string']], [
          ['a', null],
          ['b', 'x'],
        ]),
      ],
      plan: scan('t'),
    },
    calculations: [calc('c', src('s'))],
    select: ['c'],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.columns, [{ name: 'c', type: 'string' }]);
});

test('字面量 NULL 与任何类型相容；恒为 NULL 的被选列无法确定类型', () => {
  const ok = executeCalculated({
    query,
    calculations: [
      calc('a', add(litC(null), src('n'))), // null 字面量按数值处理
      calc('b', coal(litC(null), src('s'))),
    ],
    select: ['a', 'b'],
  });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(ok.columns, [
    { name: 'a', type: 'number' },
    { name: 'b', type: 'string' },
  ]);
  assert.deepEqual(
    ok.rows.map((r) => r.values),
    [
      [null, ''],
      [null, 'x'],
      [null, null],
    ],
  );

  expectFailure(
    {
      query: emptyQuery,
      calculations: [calc('x', coal(litC(null), litC(null)))],
      select: ['x'],
    },
    /cannot determine a column type/,
  );
});

// ---------------------------------------------------------------------------
// 命名空间：source 与 ref 分开命名，同名源列不会覆盖计算列
// ---------------------------------------------------------------------------

test('同名源列不会覆盖计算列：source 读查询列，ref 读计算列', () => {
  const result = executeCalculated({
    query: { tables: [table('t', [['n', 'number']], [['a', 5]])], plan: scan('t') },
    calculations: [
      calc('n', add(src('n'), litC(1))), // 计算列 n 与源列 n 同名：source 仍读源列
      calc('m', add(refC('n'), litC(10))), // ref 读计算列 n
      calc('o', src('n')), // source 读源列
    ],
    select: ['n', 'm', 'o'],
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.rows.map((r) => r.values), [[6, 16, 5]]);
});

// ---------------------------------------------------------------------------
// 袋语义与来源证据：原样来自原查询
// ---------------------------------------------------------------------------

test('袋语义与 sourceIds 透传：重复行保留，证据来自连接两侧', () => {
  const left = table(
    'l',
    [
      ['k', 'number'],
      ['v', 'number'],
    ],
    [
      ['a', 1, 10],
      ['b', 1, 20],
    ],
  );
  const right = table(
    'r',
    [
      ['k', 'number'],
      ['w', 'number'],
    ],
    [
      ['x', 1, 100],
      ['y', 1, 200],
    ],
  );
  const result = executeCalculated({
    query: {
      tables: [left, right],
      plan: { op: 'join', left: scan('l'), right: scan('r'), leftColumn: 'k', rightColumn: 'k' },
    },
    calculations: [calc('s', add(src('v'), src('w')))],
    select: ['s'],
  });
  assert.ok(result.ok, JSON.stringify(result));
  // 2×2 笛卡尔展开，一行不多一行不少
  assert.deepEqual(result.rows, [
    { values: [110], sourceIds: ['a', 'x'] },
    { values: [210], sourceIds: ['a', 'y'] },
    { values: [120], sourceIds: ['b', 'x'] },
    { values: [220], sourceIds: ['b', 'y'] },
  ]);
});

test('重复行不去重：相同值的行逐行保留', () => {
  const dup = table('t', [['n', 'number']], [
    ['a', 1],
    ['b', 1],
    ['c', 1],
  ]);
  const result = executeCalculated({
    query: { tables: [dup], plan: scan('t') },
    calculations: [calc('d', add(src('n'), litC(1)))],
    select: ['d'],
  });
  assert.ok(result.ok);
  assert.deepEqual(result.rows, [
    { values: [2], sourceIds: ['a'] },
    { values: [2], sourceIds: ['b'] },
    { values: [2], sourceIds: ['c'] },
  ]);
});

// ---------------------------------------------------------------------------
// 请求级校验：select、重复声明、结构形状
// ---------------------------------------------------------------------------

test('select 必须引用已声明的计算列，且输出列名唯一', () => {
  expectFailure(
    { query, calculations: [calc('a', src('n'))], select: ['ghost'] },
    /select\[0\]: unknown calculation 'ghost'/,
  );
  expectFailure(
    { query, calculations: [calc('a', src('n'))], select: ['a', 'a'] },
    /duplicate output column 'a'/,
  );
});

test('计算列声明：名称唯一且非空', () => {
  expectFailure(
    { query, calculations: [calc('a', src('n')), calc('a', src('n'))], select: ['a'] },
    /duplicate calculation name 'a'/,
  );
  expectFailure(
    { query, calculations: [{ name: '', expression: src('n') }], select: [] },
    /name: must be a non-empty string/,
  );
});

test('结构校验：请求形状、表达式形状、字面量取值', () => {
  expectFailure(null, /must be a JSON object/);
  expectFailure({ query, calculations: {}, select: [] }, /calculations: must be an array/);
  expectFailure({ query, calculations: [], select: 'a' }, /select: must be an array/);
  expectFailure(
    { query, calculations: [{ name: 'a', expression: { kind: 'subtract' } }], select: ['a'] },
    /unknown expression kind "subtract"/,
  );
  expectFailure(
    { query, calculations: [{ name: 'a', expression: { kind: 'add', left: litC(1) } }], select: ['a'] },
    /expression must be an object with a "kind" field/,
  );
  expectFailure(
    { query, calculations: [{ name: 'a', expression: litC(NaN) }], select: ['a'] },
    /must be a finite number, string, boolean, or null/,
  );
  expectFailure(
    { query, calculations: [{ name: 'a', expression: { kind: 'source' } }], select: ['a'] },
    /name: must be a non-empty string/,
  );
});

test('原查询失败时整次拒绝（错误来自查询校验）', () => {
  const result = executeCalculated({
    query: { tables: [sales], plan: { op: 'project', input: scan('sales'), columns: [{ name: 'ghost' }] } },
    calculations: [calc('a', src('n'))],
    select: ['a'],
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /unknown column 'ghost'/);
  assert.ok(!('rows' in result));
});

// ---------------------------------------------------------------------------
// HTTP 接口
// ---------------------------------------------------------------------------

test('HTTP：/execute-calculated 成功 200、校验失败 422 且无部分结果', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const okResp = await fetch(`${base}/execute-calculated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: {
          tables: [
            {
              name: 't',
              columns: [{ name: 'n', type: 'number' }],
              rows: [
                { id: 'a', values: [2] },
                { id: 'b', values: [null] },
              ],
            },
          ],
          plan: { op: 'scan', table: 't' },
        },
        // 前向引用：声明顺序不影响结果
        calculations: [
          { name: 'doubled', expression: { kind: 'add', left: { kind: 'ref', name: 'base' }, right: { kind: 'ref', name: 'base' } } },
          { name: 'base', expression: { kind: 'coalesce', left: { kind: 'source', name: 'n' }, right: { kind: 'literal', value: 0 } } },
        ],
        select: ['doubled'],
      }),
    });
    assert.equal(okResp.status, 200);
    const okBody = (await okResp.json()) as {
      ok: true;
      columns: { name: string; type: string }[];
      rows: { values: unknown[]; sourceIds: string[] }[];
    };
    assert.deepEqual(okBody, {
      ok: true,
      columns: [{ name: 'doubled', type: 'number' }],
      rows: [
        { values: [4], sourceIds: ['a'] },
        { values: [0], sourceIds: ['b'] },
      ],
    });

    // 空表 + 循环引用：静态校验拒绝，不依赖数据行
    const cycle = await fetch(`${base}/execute-calculated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: {
          tables: [{ name: 't', columns: [{ name: 'n', type: 'number' }], rows: [] }],
          plan: { op: 'scan', table: 't' },
        },
        calculations: [
          { name: 'a', expression: { kind: 'ref', name: 'b' } },
          { name: 'b', expression: { kind: 'ref', name: 'a' } },
        ],
        select: ['a'],
      }),
    });
    assert.equal(cycle.status, 422);
    const cycleBody = (await cycle.json()) as { ok: false; errors: string[] };
    assert.match(cycleBody.errors.join('\n'), /circular reference/);
    assert.ok(!('rows' in cycleBody));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 随机交叉核对：独立参考实现（ref 代入展开 + 封闭表达式求值）
// ---------------------------------------------------------------------------

type RefType = ColumnType | 'null';

/** 参考展开：把 ref 递归代入为封闭表达式（与引擎的记忆化递归无关） */
function refExpand(byName: Map<string, Calculation>, e: Calculation): Calculation {
  switch (e.kind) {
    case 'ref':
      return refExpand(byName, byName.get(e.name)!);
    case 'add':
    case 'divide':
    case 'coalesce':
      return { kind: e.kind, left: refExpand(byName, e.left), right: refExpand(byName, e.right) };
    case 'choose':
      return {
        kind: 'choose',
        test: refExpand(byName, e.test),
        yes: refExpand(byName, e.yes),
        no: refExpand(byName, e.no),
      };
    default:
      return e;
  }
}

/** 参考求值：封闭表达式直接递归解释 */
function refEvalClosed(e: Calculation, source: Map<string, Scalar>): Scalar {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'source':
      return source.get(e.name)!;
    case 'ref':
      throw new Error('ref must be expanded before evaluation');
    case 'choose':
      return refEvalClosed(e.test, source) === true
        ? refEvalClosed(e.yes, source)
        : refEvalClosed(e.no, source);
    case 'coalesce': {
      const l = refEvalClosed(e.left, source);
      const r = refEvalClosed(e.right, source);
      return l === null ? r : l;
    }
    case 'add':
    case 'divide': {
      const l = refEvalClosed(e.left, source);
      const r = refEvalClosed(e.right, source);
      if (l === null || r === null) return null;
      return e.kind === 'add' ? (l as number) + (r as number) : (l as number) / (r as number);
    }
  }
}

/** 参考类型推导：封闭表达式自底向上 */
function refTypeClosed(e: Calculation, sourceTypes: Map<string, ColumnType>): RefType {
  switch (e.kind) {
    case 'literal':
      if (e.value === null) return 'null';
      return typeof e.value === 'number' ? 'number' : typeof e.value === 'string' ? 'string' : 'boolean';
    case 'source':
      return sourceTypes.get(e.name)!;
    case 'add':
    case 'divide':
      return 'number';
    case 'coalesce': {
      const lt = refTypeClosed(e.left, sourceTypes);
      return lt === 'null' ? refTypeClosed(e.right, sourceTypes) : lt;
    }
    case 'choose': {
      const yt = refTypeClosed(e.yes, sourceTypes);
      return yt === 'null' ? refTypeClosed(e.no, sourceTypes) : yt;
    }
    case 'ref':
      throw new Error('ref must be expanded before typing');
  }
}

test('随机计算列：任意声明顺序下引擎结果与独立参考一致（值、类型、sourceIds）', () => {
  const rand = rng(20261002);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const TYPES: ColumnType[] = ['number', 'string', 'boolean'];

  const genLiteral = (type: ColumnType): Scalar => {
    if (rand() < 0.2) return null;
    if (type === 'number') return Math.floor(rand() * 11) - 5;
    if (type === 'string') return pick(['', 'a', 'bc', 'z'] as const);
    return rand() < 0.5;
  };

  // 类型正确的随机表达式：ref 只指向已生成的声明（天然无环）
  const genExpr = (
    cols: ColumnDef[],
    calcs: { name: string; type: ColumnType }[],
    type: ColumnType,
    depth: number,
  ): Calculation => {
    const options: (() => Calculation)[] = [() => litC(genLiteral(type))];
    const srcs = cols.filter((c) => c.type === type);
    if (srcs.length > 0) options.push(() => src(pick(srcs).name));
    const refs = calcs.filter((c) => c.type === type);
    if (refs.length > 0) options.push(() => refC(pick(refs).name));
    if (depth > 0) {
      if (type === 'number') {
        options.push(() => add(genExpr(cols, calcs, 'number', depth - 1), genExpr(cols, calcs, 'number', depth - 1)));
        // 除数取非零字面量：本测试交叉核对值与类型，除零由定向测试覆盖
        options.push(() =>
          div(genExpr(cols, calcs, 'number', depth - 1), litC(pick([1, 2, 3, -2] as const))),
        );
      }
      options.push(() => coal(genExpr(cols, calcs, type, depth - 1), genExpr(cols, calcs, type, depth - 1)));
      options.push(() =>
        choose(
          genExpr(cols, calcs, 'boolean', depth - 1),
          genExpr(cols, calcs, type, depth - 1),
          genExpr(cols, calcs, type, depth - 1),
        ),
      );
    }
    return pick(options)();
  };

  for (let iter = 0; iter < 300; iter += 1) {
    const cols: ColumnDef[] = [
      { name: 'n', type: 'number' },
      { name: 's', type: 'string' },
      { name: 'b', type: 'boolean' },
    ];
    const rowCount = Math.floor(rand() * 6); // 含空输入
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `r${i}`,
      values: [genLiteral('number'), genLiteral('string'), genLiteral('boolean')],
    }));
    const queryReq = { tables: [{ name: 't', columns: cols, rows }], plan: scan('t') };

    // 依赖顺序生成（无环），随后随机洗牌声明顺序
    const calcCount = 1 + Math.floor(rand() * 5);
    const generated: { name: string; type: ColumnType }[] = [];
    const calculations: CalculationColumn[] = [];
    for (let i = 0; i < calcCount; i += 1) {
      const type = pick(TYPES);
      const expression = genExpr(cols, generated, type, 3);
      calculations.push({ name: `c${i}`, expression });
      generated.push({ name: `c${i}`, type });
    }
    const shuffled = [...calculations];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const select = [...generated]
      .filter(() => rand() < 0.7)
      .map((c) => c.name);
    if (select.length === 0) select.push('c0');

    // 参考：代入展开后逐行求值、逐列推导类型
    const byName = new Map(calculations.map((c) => [c.name, c.expression]));
    const sourceTypes = new Map(cols.map((c) => [c.name, c.type]));
    const expanded = select.map((name) => refExpand(byName, byName.get(name)!));
    const expectedTypes = expanded.map((e) => refTypeClosed(e, sourceTypes));

    const engine = executeCalculated({ query: queryReq, calculations: shuffled, select });
    const engineOrdered = executeCalculated({ query: queryReq, calculations, select });

    if (expectedTypes.some((t) => t === 'null')) {
      // 被选列恒为 NULL：无法确定列类型，整次拒绝
      assert.ok(!engine.ok, `iter ${iter}: expected rejection, got ${JSON.stringify(engine)}`);
      assert.match(engine.errors.join('\n'), /cannot determine a column type/);
      continue;
    }

    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    assert.deepEqual(
      engine.columns,
      select.map((name, i) => ({ name, type: expectedTypes[i]! as ColumnType })),
      `iter ${iter} columns`,
    );
    const expectedRows = rows.map((row) => {
      const source = new Map(cols.map((c, i) => [c.name, row.values[i]!]));
      return {
        values: expanded.map((e) => refEvalClosed(e, source)),
        sourceIds: [row.id],
      };
    });
    assert.deepEqual(engine.rows, expectedRows, `iter ${iter} rows`);

    // 声明顺序不参与语义：洗牌前后结果完全一致
    assert.deepEqual(engineOrdered, engine, `iter ${iter} declaration order must not matter`);
  }
});
