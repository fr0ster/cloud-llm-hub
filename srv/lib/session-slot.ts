export const sessionSlot = (userId: string, key: string): string =>
  JSON.stringify([userId, key]);
