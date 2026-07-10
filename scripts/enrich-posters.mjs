// scripts/enrich-posters.mjs
// Разовое обогащение базы постерами через TMDB.
// Запуск:  TMDB_API_KEY=xxxx node scripts/enrich-posters.mjs
// Результат:
//   • data/movies.enriched.json — те же поля + poster (локальный путь), tmdbId, genres, runtime, country
//   • posters/<id>.jpg — сами картинки постеров, СКАЧАННЫЕ в проект
//
// Почему картинки скачиваем к себе, а не ссылаемся на image.tmdb.org:
// в России домены TMDB (включая image.tmdb.org) заблокированы через GeoDNS —
// прямые ссылки показывали бы у посетителей чёрные квадраты. Скачанные постеры
// отдаются с нашего же хостинга (Cloudflare) и видны всем, плюс работают офлайн.
// Сам этот скрипт должен запускаться там, где TMDB доступен: на серверах GitHub
// Actions (они не в России) — блокировки для них нет.
//
// Ключ TMDB бесплатный: https://www.themoviedb.org/settings/api
//   • v3 API Key (короткая строка)        → уходит как ?api_key=
//   • v4 Read Access Token (JWT с точками) → уходит как Authorization: Bearer
// Атрибуция TMDB обязательна в UI (уже добавлена в index.html).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTERS_DIR = join(ROOT, 'posters');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342'; // постер среднего размера (~20–40 КБ)
const KEY = process.env.TMDB_API_KEY;

if (!KEY) {
  console.error('Нужен TMDB_API_KEY в переменных окружения.');
  process.exit(1);
}

// v4-токен (JWT) отличаем по двум точкам — его шлём заголовком, иначе api_key в query
const isV4 = KEY.split('.').length === 3;
const authHeaders = isV4 ? { Authorization: `Bearer ${KEY}` } : {};
const withKey = (url) => (isV4 ? url : url + (url.includes('?') ? '&' : '?') + `api_key=${KEY}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const safeName = (id) => String(id).replace(/[^a-z0-9._-]/gi, '_');

// fetch с ретраями: сетевые сбои и 429 (respect Retry-After)
async function api(path, tries = 4) {
  const url = withKey(API + path);
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: authHeaders });
      if (res.status === 429) {
        const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt === tries) return null;
      await sleep(400 * attempt); // бэкофф
    }
  }
  return null;
}

// скачиваем картинку в posters/<id>.jpg; если уже есть — пропускаем (быстрые повторные прогоны)
async function downloadPoster(posterPath, id) {
  const file = `${safeName(id)}.jpg`;
  const dest = join(POSTERS_DIR, file);
  const rel = `posters/${file}`;
  if (await exists(dest)) return rel;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(IMG + posterPath);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      return rel;
    } catch (e) {
      if (attempt === 3) return null;
      await sleep(400 * attempt);
    }
  }
  return null;
}

// выбираем самое релевантное совпадение: сначала по точному году, потом ±1, иначе первое
function pickBest(results, year) {
  if (!results?.length) return null;
  const y = Number(year);
  const yearOf = (r) => Number((r.release_date || '').slice(0, 4));
  return (
    results.find((r) => yearOf(r) === y) ||
    results.find((r) => Math.abs(yearOf(r) - y) <= 1) ||
    results[0]
  );
}

async function enrich(movie) {
  const { Title: title, Year: year, ID: id } = movie;
  const search = await api(
    `/search/movie?query=${encodeURIComponent(title)}&year=${year}&include_adult=false`
  );
  let hit = pickBest(search?.results, year);
  // запасная попытка без года — на случай расхождения дат релиза
  if (!hit) {
    const loose = await api(`/search/movie?query=${encodeURIComponent(title)}&include_adult=false`);
    hit = pickBest(loose?.results, year);
  }
  if (!hit) return { poster: null };

  // добираем детали одним запросом: жанры, хронометраж, страна
  const d = await api(`/movie/${hit.id}`);
  const poster = hit.poster_path ? await downloadPoster(hit.poster_path, id) : null;
  return {
    poster,
    tmdbId: hit.id,
    genres: d?.genres?.map((g) => g.name) ?? [],
    runtime: d?.runtime ?? null,
    country: d?.origin_country?.[0] || d?.production_countries?.[0]?.iso_3166_1 || null,
  };
}

async function main() {
  await mkdir(POSTERS_DIR, { recursive: true });
  const movies = JSON.parse(await readFile(join(ROOT, 'data', 'movies.json')));
  const out = [];
  let ok = 0;
  for (const m of movies) {
    const info = await enrich(m);
    out.push({ ...m, ...info });
    if (info.poster) ok++;
    console.log(`#${m.ListNumber} ${m.Title} → ${info.poster ? 'ok' : 'нет постера'}`);
    await sleep(120); // бережём лимит TMDB (~8 rps)
  }
  await writeFile(join(ROOT, 'data', 'movies.enriched.json'), JSON.stringify(out, null, 2));
  console.log(`\nГотово: ${out.length} фильмов, постеров ${ok}/${out.length}.`);
  console.log('→ data/movies.enriched.json + papka posters/');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
