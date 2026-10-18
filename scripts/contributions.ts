import fs from "node:fs";
import path from "node:path";

export type NumberMap = Record<string, number>;
export interface CommitStats { add: NumberMap; del: NumberMap }
export interface ApiPage<T> { data: T; next: string | null }
export type RequestPage = <T>(path: string) => Promise<ApiPage<T> | null>;

interface CacheEntry extends CommitStats {
  lastDate: string | null;
  boundaryShas: string[];
  // New: SHA of the repository's default-branch HEAD at the last completed scan.
  lastHeadSha?: string;
}
type Cache = Record<string, CacheEntry>;
type Commit = {
  sha: string;
  author?: { login?: string | null } | null;
  commit?: { author?: { date?: string | null }; committer?: { date?: string | null } };
};
type CommitDetails = { files?: Array<{ filename: string; additions?: number; deletions?: number }> };
type Comparison = { status: string; ahead_by: number; behind_by: number; total_commits: number; commits: Commit[] };

export const CONTRIB_EXCLUDE = new Set(["Markdown", "MDX", "YAML", "JSON", "TOML", "TeX", "CSS", "HTML"]);
const EXT_LANGUAGE: Record<string, string> = {
  js:"JavaScript",jsx:"JavaScript",mjs:"JavaScript",cjs:"JavaScript",ts:"TypeScript",tsx:"TypeScript",
  py:"Python",pyw:"Python",java:"Java",kt:"Kotlin",kts:"Kotlin",scala:"Scala",groovy:"Groovy",
  c:"C",h:"C",cpp:"C++",cc:"C++",cxx:"C++",hpp:"C++",hh:"C++",hxx:"C++",cs:"C#",
  go:"Go",rs:"Rust",rb:"Ruby",php:"PHP",swift:"Swift",dart:"Dart",m:"Objective-C",mm:"Objective-C++",
  sh:"Shell",bash:"Shell",zsh:"Shell",ps1:"PowerShell",lua:"Lua",r:"R",jl:"Julia",pl:"Perl",
  ex:"Elixir",exs:"Elixir",erl:"Erlang",hs:"Haskell",clj:"Clojure",elm:"Elm",nim:"Nim",
  html:"HTML",htm:"HTML",css:"CSS",scss:"SCSS",sass:"Sass",less:"Less",vue:"Vue",svelte:"Svelte",
  astro:"Astro",sql:"SQL",graphql:"GraphQL",gql:"GraphQL",json:"JSON",yaml:"YAML",yml:"YAML",
  toml:"TOML",md:"Markdown",mdx:"MDX",tex:"TeX",ipynb:"Jupyter Notebook",sol:"Solidity",zig:"Zig",qml:"QML"
};
const IGNORED = new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml","composer.lock","cargo.lock","poetry.lock","go.sum"]);
export function languageOf(filename: string): string | null {
  const base = filename.split("/").pop()?.toLowerCase() ?? "";
  if (IGNORED.has(base) || base.endsWith(".min.js") || base.endsWith(".min.css")) return null;
  if (base === "dockerfile") return "Dockerfile";
  return EXT_LANGUAGE[base.split(".").pop() ?? ""] ?? null;
}
const validMap = (v: unknown): v is NumberMap =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(n => Number.isSafeInteger(n) && (n as number) >= 0);
const isSha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
function readCache(file: string): Cache {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid contribution cache");
  for (const [repo, raw] of Object.entries(value)) {
    const entry = raw as CacheEntry;
    if (!entry || (entry.lastDate !== null && typeof entry.lastDate !== "string") ||
      !Array.isArray(entry.boundaryShas) || !entry.boundaryShas.every(isSha) ||
      (entry.lastHeadSha !== undefined && !isSha(entry.lastHeadSha)) ||
      !validMap(entry.add) || !validMap(entry.del)) throw new Error(`Invalid contribution cache entry: ${repo}`);
  }
  return value as Cache;
}
function save(file: string, value: Cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function getAuthorCommits(repo: string, login: string, request: RequestPage): Promise<Commit[]> {
  let url: string | null = `/repos/${repo}/commits?author=${encodeURIComponent(login)}&per_page=100`;
  const result: Commit[] = [];
  while (url) {
    const page: ApiPage<Commit[]> | null = await request<Commit[]>(url);
    if (!page) throw new Error(`Cannot list commits for ${repo}`);
    result.push(...page.data);
    url = page.next;
  }
  return result;
}

// One-time migration: legacy cache only knows the last author's SHA(s), not the
// previous default-branch HEAD. Stop at that boundary and retain existing totals.
// Subsequent runs use Compare, so older commits merged later are not lost.
async function fromLegacyBoundary(repo: string, login: string, entry: CacheEntry, request: RequestPage): Promise<Commit[]> {
  const all = await getAuthorCommits(repo, login, request);
  if (!entry.lastDate && entry.boundaryShas.length === 0) return all;
  const boundary = new Set(entry.boundaryShas);
  if (boundary.size === 0) throw new Error(`Legacy cache has no SHA boundary for ${repo}; manual migration required`);
  const first = all.findIndex(c => boundary.has(c.sha));
  if (first < 0) throw new Error(`Legacy SHA boundary unreachable for ${repo}; do not advance cache`);
  return all.slice(0, first);
}

// Compare computes HEAD minus previous HEAD in Git ancestry, independent of
// authored timestamps or merges introducing old commits.
async function sinceHead(repo: string, oldHead: string, newHead: string, login: string, request: RequestPage): Promise<Commit[]> {
  if (oldHead === newHead) return [];
  let url: string | null = `/repos/${repo}/compare/${oldHead}...${newHead}?per_page=100`;
  const commits: Commit[] = [];
  let total: number | null = null;
  while (url) {
    const page: ApiPage<Comparison> | null = await request<Comparison>(url);
    if (!page) throw new Error(`Cannot compare default-branch heads for ${repo}`);
    const c = page.data;
    if (c.behind_by !== 0 || (c.status !== "ahead" && c.status !== "identical")) {
      throw new Error(`Default branch diverged or was force-pushed: ${repo}; manual reconciliation required`);
    }
    if (total === null) total = c.total_commits;
    commits.push(...c.commits);
    url = page.next;
  }
  if (commits.length !== total) throw new Error(`Incomplete compare pagination in ${repo}: ${commits.length}/${total}`);
  return commits.filter(c => c.author?.login?.toLowerCase() === login.toLowerCase());
}

/** Default-branch-only incremental stats, preserving legacy per-repository totals.
 * Uses lastHeadSha for accurate later merges and retains lastDate for inspection.
 */
export async function getContributionStats(repositories: Iterable<string>, login: string, dir: string,
  request: RequestPage, stopped: () => boolean, mode: "churn" | "additions"): Promise<Map<string, number> | null> {
  const file = path.join(dir, "contrib-cache.json");
  const cache = readCache(file);
  const allowed = [...new Set(repositories)];
  let complete = true;
  try {
    for (const repo of allowed) {
      if (stopped()) { complete = false; break; }
      const entry = cache[repo] ?? { lastDate: null, boundaryShas: [], add: {}, del: {} };
      try {
        // GET commits without sha= uses the repository's default branch.
        const headPage = await request<Commit[]>(`/repos/${repo}/commits?per_page=1`);
        if (!headPage) throw new Error(`Cannot read default-branch HEAD: ${repo}`);
        if (headPage.data.length === 0) { cache[repo] = entry; continue; }
        const head = headPage.data[0]!.sha;
        const commits = entry.lastHeadSha
          ? await sinceHead(repo, entry.lastHeadSha, head, login, request)
          : await fromLegacyBoundary(repo, login, entry, request);
        if (stopped()) throw new Error(`Rate limited while listing ${repo}`);
        const deltaAdd: NumberMap = {}, deltaDel: NumberMap = {};
        for (const {sha} of commits) {
          let detailUrl: string | null = `/repos/${repo}/commits/${sha}?per_page=100`;
          let count = 0;
          while (detailUrl) {
            if (stopped()) throw new Error(`Rate limited while reading ${repo}@${sha}`);
            const page: ApiPage<CommitDetails> | null = await request<CommitDetails>(detailUrl);
            if (!page?.data.files) throw new Error(`Cannot read commit details ${repo}@${sha}`);
            count += page.data.files.length;
            if (count >= 3000) throw new Error(`Commit ${sha} reaches GitHub's file limit`);
            for (const f of page.data.files) {
              const lang = languageOf(f.filename);
              if (!lang) continue;
              deltaAdd[lang] = (deltaAdd[lang] ?? 0) + (f.additions ?? 0);
              deltaDel[lang] = (deltaDel[lang] ?? 0) + (f.deletions ?? 0);
            }
            detailUrl = page.next;
          }
        }
        for (const [lang,val] of Object.entries(deltaAdd)) entry.add[lang] = (entry.add[lang] ?? 0) + val;
        for (const [lang,val] of Object.entries(deltaDel)) entry.del[lang] = (entry.del[lang] ?? 0) + val;
        entry.lastHeadSha = head;
        entry.lastDate = new Date().toISOString(); // informational, never used as query boundary
        entry.boundaryShas = [head]; // keep a human-readable SHA checkpoint
        cache[repo] = entry;
      } catch (error) {
        console.warn(`Commit scan incomplete for ${repo}:`, error);
        complete = false;
      }
    }
  } finally { save(file, cache); }
  if (!complete) { console.warn("Commit scan incomplete; saved finished repositories, keeping SVG unchanged"); return null; }
  const result = new Map<string,number>();
  for (const repo of allowed) {
    const entry = cache[repo];
    if (!entry) continue;
    for (const lang of new Set([...Object.keys(entry.add),...Object.keys(entry.del)])) {
      if (CONTRIB_EXCLUDE.has(lang)) continue;
      const weight = (entry.add[lang] ?? 0) + (mode === "churn" ? entry.del[lang] ?? 0 : 0);
      if (weight) result.set(lang, (result.get(lang) ?? 0) + weight);
    }
  }
  return result;
}
