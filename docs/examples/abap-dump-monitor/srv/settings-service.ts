import type { ISettings } from './interfaces';

export interface SettingsRepo {
  runOne(key: string): Promise<{ value: string; dataType: string } | undefined>;
}

interface CacheEntry { value?: string; dataType?: string; expiresAt: number; }

export class SettingsService implements ISettings {
  private cache = new Map<string, CacheEntry>();

  constructor(private repo: SettingsRepo, private ttlMs = 5000) {}

  async get(key: string): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const row = await this.repo.runOne(key);
    this.cache.set(key, { value: row?.value, dataType: row?.dataType, expiresAt: now + this.ttlMs });
    return row?.value;
  }

  async getInt(key: string, fallback?: number): Promise<number> {
    const v = await this.get(key);
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`Setting ${key} not set`);
      return fallback;
    }
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`Setting ${key} is not a valid int: ${v}`);
    return n;
  }

  async getBool(key: string, fallback = false): Promise<boolean> {
    const v = await this.get(key);
    if (v === undefined) return fallback;
    return v === 'true' || v === '1';
  }

  async getCsv(key: string): Promise<string[]> {
    const v = await this.get(key);
    if (!v) return [];
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }
}
