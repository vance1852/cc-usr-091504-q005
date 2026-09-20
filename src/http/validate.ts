import { yuanToCents, type Cents } from '../domain/money.js';
import { Errors } from '../domain/errors.js';

/** HTTP 入参金额解析：非法输入抛 VALIDATION_ERROR（400） */
export function parseYuan(value: unknown, field = '金额'): Cents {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw Errors.validation(`${field}必须是数字或数字字符串`);
  }
  try {
    return yuanToCents(value);
  } catch {
    throw Errors.validation(`${field}格式非法（元，最多两位小数）: ${String(value)}`);
  }
}

/** 取必填字符串字段 */
export function requireStr(body: any, field: string): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw Errors.validation(`字段 ${field} 必填`);
  }
  return v;
}
