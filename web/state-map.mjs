// Rename one status without losing another status or the fallback entry.
export function renameStateKey(map, oldKey, newKey) {
  if (!newKey.trim() || newKey === '*') throw new Error('Bitte einen eigenen Statuswert eingeben.');
  if (oldKey !== newKey && Object.hasOwn(map, newKey))
    throw new Error('Dieser Statuswert ist bereits vorhanden.');
  return Object.fromEntries(Object.entries(map).map(([key, value]) =>
    [key === oldKey ? newKey : key, value]));
}
