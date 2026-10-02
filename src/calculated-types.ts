import type { Scalar } from './types.js';
export type Calculation =
  | {kind:'source';name:string}
  | {kind:'ref';name:string}
  | {kind:'literal';value:Scalar}
  | {kind:'add'|'divide'|'coalesce';left:Calculation;right:Calculation}
  | {kind:'choose';test:Calculation;yes:Calculation;no:Calculation};
export interface CalculationColumn {name:string;expression:Calculation}
export interface CalculatedRequest {query:unknown;calculations:CalculationColumn[];select:string[]}
