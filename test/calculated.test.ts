/**
 * 派生计算列（POST /execute-calculated / executeCalculated）：
 * - 声明顺序不参与语义（ref 按需记忆化求值，环/坏引用静态拒绝）
 * - choose 只求值被选分支（NULL 条件取 no）；coalesce 只跳过 NULL
 * - 所有声明（含未选中的）静态校验；空输入也返回正确列类型
 * - 袋语义与每行 sourceIds 1:1 来自原查询；运行期错误整次拒绝
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { executeCalculated } from '../src/calculated.js';
import { createServer } from '../src/server.js';
import { table } from './helpers.js';
import type { Calculation } from '../src/calculated-types.js';

// ---- 表达式构造器 ----------------------------------------------------------
const L = (value: number | string | boolean | null): Calculation => ({ kind: 'literal', value });
const S = (name: string): Calculation => ({ kind: 'source', name });
const R = (name: string): Calculation => ({ kind: 'ref', name });
const add = (left: Calculation, right: Calculation): Calculation => ({ kind: 'add', left, right });
const div = (left: Calculation, right: Calculation): Calculation => ({ kind: 'divide', left, right });
const coalesce = (left: Calculation, right: Calculation): Calculation => ({ kind: 'coalesce', left, right });
const choose = (test: Calculation, yes: Calculation, no: Calculation): Calculation => ({
  kind: 'choose',
  test,
  yes,
  no,
});
const C = (name: string, expression: Calculation) => ({ name, expression });

const nums = table(
  'nums',
  [
    ['n', 'number'],
    ['s', 'string'],
    ['b', 'boolean'],
  ],
  [
    ['a', 10, 'x', true],
    ['b', 0, '', false],
    ['c', null, null, null],
    ['d', 6, 'y', true],
  ],
);
const empty = table('e', [['n', 'number']], []);
const emptyAll = table(
  'ea',
  [
    ['n', 'number'],
    ['s', 'string'],
    ['b', 'boolean'],
  ],
  [],
);

function request(calculations: ReturnType<typeof C>[], select: string[], sourceTable = nums) {
  return {
    tables: [sourceTable],
    query: { tables: [sourceTable], plan: { op: 'scan', table: sourceTable.name } },
    calculations,
    select,
  };
}

function ok(req: unknown) {
  const r = executeCalculated(req);
  assert.ok(r.ok, `expected success, got ${JSON.stringify(r)}`);
  return r;
}

function fail(req: unknown, pattern: RegExp) {
  const r = executeCalculated(req);
  assert.ok(!r.ok, `expected failure, got ${JSON.stringify(r)}`);
  assert.ok(!('rows' in r), 'failure must not carry partial rows');
  assert.ok(!('columns' in r), 'failure must not carry partial columns');
  assert.match(r.errors.join('\n'), pattern, `errors ${JSON.stringify(r.errors)} vs ${pattern}`);
}

test('声明顺序不参与语义：ref 指向后声明的计算列也能取到值，两种顺序结果一致', () => {
  const forward = request([C('a', add(S('n'), R('b'))), C('b', L(1))], ['a']);
  const reverse = request([C('b', L(1)), C('a', add(S('n'), R('b')))], ['a']);
  const rf = ok(forward);
  const rr = ok(reverse);
  assert.deepEqual(
    rf.rows.map((r) => r.values),
    [[11], [1], [null], [7]],
  );
  assert.deepEqual(
    rr.rows.map((r) => r.values),
    [[11], [1], [null], [7]],
  );
});

test('多层互相引用按拓扑求值（旧实现：后声明的依赖读到 NULL）', () => {
  const r = ok(
    request(
      [C('z', add(R('y'), R('x'))), C('y', add(S('n'), L(1))), C('x', L(100))],
      ['z'],
    ),
  );
  assert.deepEqual(
    r.rows.map((row) => row.values),
    [[111], [101], [null], [107]],
  );
});

test('choose 只求值被选分支；NULL/false 条件选 no', () => {
  // test 恒 true：no 分支永不求值，里面的 1/0 不得导致失败
  const onlyYes = ok(request([C('v', choose(L(true), L(42), div(L(1), L(0))))], ['v']));
  assert.deepEqual(
    onlyYes.rows.map((row) => row.values),
    Array(4).fill([42]),
  );
  // test 恒 false：yes 分支永不求值
  const onlyNo = ok(request([C('v', choose(L(false), div(L(1), L(0)), L(9)))], ['v']));
  assert.deepEqual(
    onlyNo.rows.map((row) => row.values),
    Array(4).fill([9]),
  );
  // test 为 NULL 也选 no
  const nullTest = ok(request([C('v', choose(L(null), div(L(1), L(0)), L(5)))], ['v']));
  assert.deepEqual(
    nullTest.rows.map((row) => row.values),
    Array(4).fill([5]),
  );
  // 数据行驱动：b=true 时选 yes（42）；b=false/null 时选 no。
  // no 分支里的 1/0 仅在 false/null 行被求值 → 整次拒绝，而非“未选中”。
  fail(
    request([C('v', choose(S('b'), L(42), div(L(1), L(0))))], ['v']),
    /division by zero/,
  );
  // 所有行都为 true 时危险分支永不执行
  const allTrue = table(
    'at',
    [['b', 'boolean']],
    [
      ['a', true],
      ['c', true],
    ],
  );
  const r = ok(
    request([C('v', choose(S('b'), L(42), div(L(1), L(0))))], ['v'], allTrue),
  );
  assert.deepEqual(
    r.rows.map((row) => row.values),
    [[42], [42]],
  );
});

test('coalesce 只跳过 NULL：0、false、空字符串保持原值', () => {
  const r = ok(
    request(
      [
        C('num', coalesce(S('n'), L(-1))),
        C('str', coalesce(S('s'), L('fallback'))),
        C('bool', coalesce(S('b'), L(true))),
      ],
      ['num', 'str', 'bool'],
    ),
  );
  assert.deepEqual(
    r.rows.map((row) => row.values),
    [
      [10, 'x', true],
      [0, '', false], // 旧实现 || 会变成 [-1, 'fallback', true]
      [-1, 'fallback', true], // 源值为 NULL → 取备用值
      [6, 'y', true],
    ],
  );
});

test('coalesce 短路：右侧危险分支仅在左值为 NULL 的行被求值', () => {
  // 所有行 n 都非 NULL（不含 null 行）：右侧永不求值
  const noNullRows = table(
    'nn',
    [['n', 'number']],
    [
      ['a', 0],
      ['b', 5],
    ],
  );
  const r = ok(request([C('v', coalesce(S('n'), div(L(1), L(0))))], ['v'], noNullRows));
  assert.deepEqual(
    r.rows.map((row) => row.values),
    [[0], [5]],
  );
  // 存在 NULL 行时右侧被求值 → 除零 → 整次拒绝
  fail(request([C('v', coalesce(S('n'), div(L(1), L(0))))], ['v']), /division by zero/);
});

test('循环引用静态拒绝：直接环、间接环、自环（即使无数据行）', () => {
  fail(request([C('a', R('a'))], ['a']), /circular reference/);
  fail(request([C('a', R('b')), C('b', R('a'))], ['a']), /circular reference/);
  fail(
    request(
      [C('a', add(L(1), R('b'))), C('b', add(L(1), R('c'))), C('c', add(L(1), R('a')))],
      ['a'],
    ),
    /circular reference/,
  );
  const onEmpty = request([C('a', R('b')), C('b', R('a'))], ['a'], empty);
  fail(onEmpty, /circular reference/);
});

test('不存在的引用静态拒绝（空输入也不放过）：未知 ref / 未知 source', () => {
  fail(request([C('a', R('ghost'))], ['a']), /unknown calculation reference 'ghost'/);
  fail(request([C('a', S('ghost'))], ['a']), /unknown source column 'ghost'/);
  fail(
    request([C('a', S('ghost'))], ['a'], empty),
    /unknown source column 'ghost'/,
  );
});

test('未被 select 的声明也必须无环、引用合法、类型相容', () => {
  fail(
    request([C('good', L(1)), C('loop', R('loop'))], ['good']),
    /circular reference/,
  );
  fail(
    request([C('good', L(1)), C('badref', R('nope'))], ['good']),
    /unknown calculation reference 'nope'/,
  );
  fail(
    request([C('good', L(1)), C('badtype', add(S('s'), L(1)))], ['good']),
    /numeric operand/,
  );
});

test('静态类型相容：算术要求数值，choose 条件要求布尔，分支/coalesce 类型需相容', () => {
  fail(request([C('a', add(S('s'), L(1)))], ['a']), /numeric operand/);
  fail(request([C('a', div(S('b'), L(1)))], ['a']), /numeric operand/);
  fail(request([C('a', choose(S('n'), L(1), L(2)))], ['a']), /condition must be boolean/);
  fail(
    request([C('a', choose(S('b'), L(1), L('x')))], ['a']),
    /type mismatch/,
  );
  fail(request([C('a', coalesce(L(1), L('x')))], ['a']), /type mismatch/);
  // 恒 NULL 与具体类型相容（可流向任何类型）
  ok(request([C('a', add(coalesce(L(null), L(2)), L(3)))], ['a']));
  ok(request([C('a', choose(S('b'), L(1), coalesce(L(null), L(2))))], ['a']));
});

test('输出列类型来自静态推导：空输入也返回正确类型', () => {
  const r = ok(
    request(
      [C('num', coalesce(S('n'), L(-1))), C('str', S('s')), C('bool', choose(S('b'), L(true), L(false)))],
      ['num', 'str', 'bool'],
      emptyAll,
    ),
  );
  assert.deepEqual(r.columns, [
    { name: 'num', type: 'number' },
    { name: 'str', type: 'string' },
    { name: 'bool', type: 'boolean' },
  ]);
  assert.deepEqual(r.rows, []);
});

test('列类型不依赖首行数据：首行为 NULL 时类型仍正确（旧实现会误判为 number）', () => {
  const leadingNull = table(
    'ln',
    [['s', 'string']],
    [
      ['a', null],
      ['b', 'hello'],
    ],
  );
  const r = ok(request([C('v', S('s'))], ['v'], leadingNull));
  assert.equal(r.columns[0]!.type, 'string');
});

test('恒为 NULL 的表达式没有列类型：作为输出列被拒绝，内部引用则允许', () => {
  fail(request([C('a', L(null))], ['a']), /always null/);
  fail(request([C('a', coalesce(L(null), L(null)))], ['a']), /always null/);
  // 仅作内部表达式使用、最终可推导具体类型时合法
  const r = ok(request([C('mid', L(null)), C('v', coalesce(R('mid'), L(3)))], ['v']));
  assert.equal(r.columns[0]!.type, 'number');
});

test('袋语义：重复行保留并逐行映射；sourceIds 1:1 来自原查询', () => {
  const dup = table(
    'dup',
    [['n', 'number']],
    [
      ['x1', 1],
      ['x2', 1], // 同值不同源行：重复值必须保留为两行
      ['y', 2],
    ],
  );
  const r = ok(request([C('doubled', add(S('n'), S('n')))], ['doubled'], dup));
  assert.deepEqual(r.rows, [
    { values: [2], sourceIds: ['x1'] },
    { values: [2], sourceIds: ['x2'] },
    { values: [4], sourceIds: ['y'] },
  ]);
});

test('结构校验：非法请求形状、表达式 kind、字面量、计算列名', () => {
  fail(null, /must be a JSON object/);
  fail({ query: {}, calculations: {}, select: [] }, /calculations: must be an array/);
  // 底层查询非法时先拒绝查询（select 错误不再产生部分结果）
  fail({ query: {}, calculations: [], select: ['x'] }, /must be an array of table definitions/);
  // 查询合法但 select 指向不存在的计算列
  fail(request([], ['x']), /select: unknown calculation 'x'/);
  fail(request([C('', L(1))], ['']), /name: must be a non-empty string/);
  fail(request([C('a.b', L(1))], ['a.b']), /without '\.'/);
  fail(request([C('a', L(1)), C('a', L(2))], ['a']), /duplicate calculation/);
  fail(
    { ...request([C('a', L(1))], ['a']), calculations: [{ name: 'a', expression: { kind: 'bogus' } }] },
    /unknown expression kind/,
  );
  fail(
    {
      ...request([C('a', L(1))], ['a']),
      calculations: [{ name: 'a', expression: { kind: 'literal', value: NaN } }],
    },
    /must be a finite number/,
  );
  fail(
    { ...request([C('a', L(1)), C('b', L(2))], ['a', 'b', 'a']) },
    /duplicate output column/,
  );
});

test('底层查询失败时直接透传错误，不返回部分结果', () => {
  const req = {
    tables: [nums],
    query: { tables: [nums], plan: { op: 'scan', table: 'ghost' } },
    calculations: [C('a', L(1))],
    select: ['a'],
  };
  fail(req, /unknown table/);
});

test('引用闭包外的未选中声明不被求值：其中的运行期错误不影响报表', () => {
  const r = ok(
    request(
      [
        C('used', L(11)),
        C('unusedBoom', div(L(1), L(0))), // 结构/类型合法（静态通过），但运行会除零
        C('unusedCycleFreeNull', coalesce(L(null), S('n'))),
      ],
      ['used'],
    ),
  );
  assert.deepEqual(
    r.rows.map((row) => row.values),
    Array(4).fill([11]),
  );
});

// ---- HTTP 端到端 ------------------------------------------------------------

test('HTTP：/execute-calculated 成功 200、校验失败 422、空输入类型正确', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const good = await fetch(`${base}/execute-calculated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        request(
          [
            C('later', L(1)),
            C('total', add(S('n'), R('later'))),
            C('safeZero', coalesce(S('n'), L(-99))),
          ],
          ['total', 'safeZero'],
        ),
      ),
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as {
      columns: { name: string; type: string }[];
      rows: { values: unknown[] }[];
    };
    assert.deepEqual(body.columns, [
      { name: 'total', type: 'number' },
      { name: 'safeZero', type: 'number' },
    ]);
    assert.deepEqual(
      body.rows.map((r: { values: unknown[] }) => r.values),
      [
        [11, 10],
        [1, 0],
        [null, -99],
        [7, 6],
      ],
    );

    const bad = await fetch(`${base}/execute-calculated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request([C('a', R('a'))], ['a'], empty)),
    });
    assert.equal(bad.status, 422);
    const badBody = (await bad.json()) as { ok: boolean; errors: string[] };
    assert.equal(badBody.ok, false);
    assert.match(badBody.errors.join('\n'), /circular reference/);
    assert.ok(!('rows' in badBody));

    const emptyRes = await fetch(`${base}/execute-calculated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        request(
          [C('num', coalesce(S('n'), L(0))), C('s', S('s')), C('b', S('b'))],
          ['num', 's', 'b'],
          emptyAll,
        ),
      ),
    });
    assert.equal(emptyRes.status, 200);
    const emptyBody = (await emptyRes.json()) as {
      columns: { name: string; type: string }[];
      rows: unknown[];
    };
    assert.deepEqual(emptyBody.columns, [
      { name: 'num', type: 'number' },
      { name: 's', type: 'string' },
      { name: 'b', type: 'boolean' },
    ]);
    assert.deepEqual(emptyBody.rows, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
