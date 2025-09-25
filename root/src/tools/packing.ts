import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWeather } from './weather.js';

type PackingData = {
  hot: string[];
  mild: string[];
  cold: string[];
  special: Record<string, string[]>;
};

let cache: { data?: PackingData } = {};

async function loadPacking(): Promise<PackingData> {
  if (cache.data) return cache.data;
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidates = [
    process.env.PACKING_DATA_PATH,
    path.join(process.cwd(), 'root', 'src', 'data', 'packing.json'),
    path.join(process.cwd(), 'src', 'data', 'packing.json'),
    path.join(here, '..', 'data', 'packing.json'),
  ].filter((p): p is string => !!p);
  let lastErr: unknown;
  for (const p of candidates) {
    try {
      const txt = await readFile(p, { encoding: 'utf-8' });
      if (txt.length > 262_144) throw new Error('packing_file_too_large');
      cache.data = JSON.parse(txt) as PackingData;
      return cache.data!;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('packing_file_not_found');
}

export async function suggestPacking(
  input: {
    city: string;
    month?: string;
    dates?: string;
    children?: number;
    seniors?: number;
    interests?: string[];
  },
  signal?: AbortSignal,
): Promise<
  | {
      ok: true;
      summary: string;
      source: string;
      band: 'hot' | 'mild' | 'cold';
      items: { base: string[]; special: Record<string, string[]> };
    }
  | { ok: false; reason: string }
> {
  const data = await loadPacking();

  const wx = await getWeather({ city: input.city, month: input.month, dates: input.dates });
  if (!wx.ok) return { ok: false, reason: wx.reason };

  const maxC = wx.maxC ?? 22;
  const minC = wx.minC ?? 12;
  const band: 'hot' | 'mild' | 'cold' = maxC >= 28 ? 'hot' : minC <= 8 ? 'cold' : 'mild';

  const base = Array.from(new Set((data[band] || []).slice(0, 50)));
  const interests = (input.interests || []).map((s) => s.toLowerCase());
  const specialKeys: string[] = [];
  if ((input.children || 0) > 0) specialKeys.push('kids');
  for (const key of Object.keys(data.special || {})) {
    if (key === 'kids') continue;
    if (interests.some((i) => i.includes(key))) specialKeys.push(key);
  }
  const special: Record<string, string[]> = {};
  for (const k of specialKeys) {
    const arr = data.special?.[k] || [];
    if (arr.length) special[k] = Array.from(new Set(arr.slice(0, 50)));
  }

  const summary = `Packing for ${input.city}: ${band} conditions expected.`;
  return {
    ok: true,
    summary,
    source: wx.source || 'open-meteo.com',
    band,
    items: { base, special },
  };
}
