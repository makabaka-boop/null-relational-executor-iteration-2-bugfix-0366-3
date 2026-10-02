/**
 * 派生计算列的公共类型：表达式树与 {query, calculations, select} 请求模型。
 * 语义见 calculated.ts 头部注释与 README「派生计算列」。
 */
import type { Scalar } from './types.js';

/**
 * 计算列表达式：
 * - source 引用查询输出列，ref 引用其他计算列（两个命名空间互不影响）
 * - add/divide 为数值运算；coalesce 只跳过 NULL；choose 只求值被选分支
 */
export type Calculation =
  | { kind: 'source'; name: string }
  | { kind: 'ref'; name: string }
  | { kind: 'literal'; value: Scalar }
  | { kind: 'add' | 'divide' | 'coalesce'; left: Calculation; right: Calculation }
  | { kind: 'choose'; test: Calculation; yes: Calculation; no: Calculation };

export interface CalculationColumn {
  name: string;
  expression: Calculation;
}

/** 结构校验后的请求模型；query 的结构与语义校验由 executeQuery 完成 */
export interface CalculatedRequest {
  query: unknown;
  calculations: CalculationColumn[];
  select: string[];
}
