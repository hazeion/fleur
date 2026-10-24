import type { Schema } from "../schema";
import type { ColumnKind, ColumnReference, DeleteAction, Table } from "../database";
export interface ColumnDefinition {
  readonly kind: ColumnKind;
  readonly check: Schema;
  readonly nullable: boolean;
  readonly generated: boolean;
  readonly primary: boolean;
  readonly max?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly defaultValue?: unknown;
  readonly defaultNow?: true;
  readonly reference?: { readonly target: ColumnReference; readonly onDelete: DeleteAction };
}
export const definitions = new WeakMap<object, ColumnDefinition>();
export const tableDefinitions = new WeakMap<object, { readonly name: string; readonly columns: Readonly<Record<string, ColumnReference>>; readonly versioned: boolean; readonly alias?: string; readonly source?: Table }>();
export const references = new WeakMap<object, { readonly table: Table; readonly field: string }>();

export function definition(column: ColumnReference): ColumnDefinition {
  const result = definitions.get(column);
  if (!result) throw new Error("Invalid column");
  return result;
}
