import fs from "node:fs";
import path from "node:path";
import { CONTRIB_EXCLUDE, languageOf } from "./contributions.ts";
import type { NumberMap, RequestPage } from "./contributions.ts";

type PrCache = { version: 1; lastMergedDate: string | null; add: NumberMap; del: NumberMap };
type SearchResponse = {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{ number: number; repository_url: string; pull_request?: { merged_at?: string | null } }>;
};
type PrFile = { filename: string; additions: number; deletions: number };

const empty = (): PrCache => ({ version: 1, lastMergedDate: null, add: {}, del: {} });
const day = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => day(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const goodMap = (v: unknown): v is NumberMap =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(x => Number.isSafeInteger(x) && (x as number) >= 0);
function save(filename: string, data: PrCache) {
  const tmp = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filename);
}

/**
 * Incremental merged-PR statistics. Only complete UTC days are committed.
 * Windows are split whenever the GitHub Search 1000-result ceiling is reached.
 * One window is written atomically, so a failed request cannot advance the cursor.
 */
export async function getPrContributionStats(
  login: string,
  createdAt: string,
  dataDir: string,
  request: RequestPage,
  skippedOwners: Set<string>,
  stopped: () => boolean,
  mode: "churn" | "additions",
): Promise<Map<string, number> | null> {
  const filename = path.join(dataDir, "pr-cache.json");
  let cache = empty();
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as PrCache;
    if (parsed.version !== 1 || (parsed.lastMergedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.lastMergedDate)) || !goodMap(parsed.add) || !goodMap(parsed.del)) {
      throw new Error("Invalid PR cache; refusing to reset accumulated PR statistics.");
    }
    cache = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const today = day(new Date());
  const end = addDays(today, -1); // Current partial day is deliberately postponed.
  const start = cache.lastMergedDate ? addDays(cache.lastMergedDate, 1) : createdAt.slice(0, 10);

  async function collect(from: string, to: string): Promise<void> {
    if (stopped()) throw new Error("API rate limited during PR collection");
    const q = `is:pr is:merged author:${login} merged:${from}..${to}`;
    const first = await request<SearchResponse>(`/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=1`);
    if (!first || first.data.incomplete_results) throw new Error(`Incomplete PR search for ${from}..${to}`);
    if (first.data.total_count > 1000) {
      if (from === to) throw new Error(`More than 1000 PRs merged on ${from}; cannot safely paginate`);
      const middle = addDays(from, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 / 2));
      await collect(from, middle);
      await collect(addDays(middle, 1), to);
      return;
    }
    const items = [...first.data.items];
    let next = first.next;
    while (next) {
      if (stopped()) throw new Error("API rate limited during PR pagination");
      const page = await request<SearchResponse>(next);
      if (!page || page.data.incomplete_results) throw new Error("Incomplete PR pagination");
      items.push(...page.data.items);
      next = page.next;
    }
    if (items.length !== first.data.total_count) throw new Error(`PR search count mismatch for ${from}..${to}`);
    for (const pr of items) {
      const prefix = "https://api.github.com/repos/";
      if (!pr.repository_url.startsWith(prefix)) throw new Error("Unexpected PR repository URL");
      const repo = pr.repository_url.slice(prefix.length);
      const owner = repo.split("/")[0]!;
      if (skippedOwners.has(owner.toLowerCase())) continue;
      if (!pr.pull_request?.merged_at) throw new Error(`Search returned a PR without merged_at: ${repo}#${pr.number}`);
      let filesUrl: string | null = `/repos/${repo}/pulls/${pr.number}/files?per_page=100`;
      let count = 0;
      const localAdd: NumberMap = {};
      const localDel: NumberMap = {};
      while (filesUrl) {
        if (stopped()) throw new Error("API rate limited during PR file scan");
        const page: { data: PrFile[]; next: string | null } | null = await request<PrFile[]>(filesUrl);
        if (!page) throw new Error(`Cannot read PR files: ${repo}#${pr.number}`);
        count += page.data.length;
        if (count >= 3000) throw new Error(`PR ${repo}#${pr.number} reached GitHub file listing limit`);
        for (const file of page.data) {
          const lang = languageOf(file.filename);
          if (!lang || CONTRIB_EXCLUDE.has(lang)) continue;
          localAdd[lang] = (localAdd[lang] ?? 0) + file.additions;
          localDel[lang] = (localDel[lang] ?? 0) + file.deletions;
        }
        filesUrl = page.next;
      }
      for (const [lang, count] of Object.entries(localAdd)) cache.add[lang] = (cache.add[lang] ?? 0) + count;
      for (const [lang, count] of Object.entries(localDel)) cache.del[lang] = (cache.del[lang] ?? 0) + count;
    }
  }

  // Month-sized windows minimize requests. Split windows if Search exceeds 1000.
  // Save a cursor only once the entire time window was processed successfully.
  try {
    for (let date = start; date <= end;) {
      const before = JSON.parse(JSON.stringify(cache)) as PrCache;
      try {
      const firstNextMonth = day(new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1)));
      const monthEnd = addDays(firstNextMonth, -1);
      const to = monthEnd < end ? monthEnd : end;
      await collect(date, to);
      cache.lastMergedDate = to;
      save(filename, cache);
      date = addDays(to, 1);
      } catch (error) { cache = before; throw error; }
    }
  } catch (error) {
    console.warn("PR collection stopped; retaining last successful day's cache:", error);
    // Never render a partial PR collection; checkpoints remain available for retry.
    return null;
  }

  const totals = new Map<string, number>();
  for (const lang of new Set([...Object.keys(cache.add), ...Object.keys(cache.del)])) {
    const value = (cache.add[lang] ?? 0) + (mode === "churn" ? (cache.del[lang] ?? 0) : 0);
    if (value > 0) totals.set(lang, value);
  }
  return totals;
}
