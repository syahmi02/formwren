import type { AnyDataset } from './tx/contract.ts';

export interface OptionItem {
  value: unknown;
  label: string;
}

/** Where options come from: a Dataset (read with `optionValue` and `optionLabel`) or a static list. */
export type OptionsSource = AnyDataset | readonly { value: unknown; label?: unknown }[];

function isList(source: OptionsSource): source is readonly { value: unknown; label?: unknown }[] {
  return Array.isArray(source);
}

/**
 * Turns a Dataset or a static list into `{ value, label }[]`. A Dataset is read over its visible
 * rows. `optionLabel` defaults to `optionValue`. Throws if a Dataset is given without valid columns,
 * so callers decide how to report it. A static list ignores both column names.
 */
export function readOptions(source: OptionsSource, optionValue?: string, optionLabel?: string): OptionItem[] {
  if (isList(source)) {
    return source.map((item) => ({ value: item.value, label: item.label === null || item.label === undefined ? String(item.value ?? '') : String(item.label) }));
  }
  const valueColumn = optionValue;
  const labelColumn = optionLabel ?? optionValue;
  if (
    typeof valueColumn !== 'string' ||
    typeof labelColumn !== 'string' ||
    !source.columns.some((c) => c.id === valueColumn) ||
    !source.columns.some((c) => c.id === labelColumn)
  ) {
    throw new Error(`Options from Dataset "${source.id}" need valid optionValue and optionLabel columns`);
  }
  const list: OptionItem[] = [];
  for (let i = 0; i < source.rowCount; i++) {
    const label = source.getValue(i, labelColumn);
    list.push({ value: source.getValue(i, valueColumn), label: label === null ? '' : String(label) });
  }
  return list;
}
