// Finds an enum type: the build output first (its values are the compiler's), the source when there is no build or it
// has no such enum. Pure.

import { enumFromSource } from './adsinterface';
import { EnumInfo, findEnum, parseTmc } from './tmc';

export function pickEnum(tmcXml: string | undefined, sources: { file: string; view: string }[], typeName: string): { info: EnumInfo; origin: 'build' | 'source' } | undefined {
  if (tmcXml) {
    try {
      const info = findEnum(parseTmc(tmcXml), typeName);
      if (info) return { info, origin: 'build' };
    } catch { /* an unreadable build output: the source may still answer */ }
  }
  const info = enumFromSource(sources, typeName);
  return info ? { info, origin: 'source' } : undefined;
}
