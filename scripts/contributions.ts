import fs from "node:fs";
import path from "node:path";

export type NumberMap = Record<string, number>;
export interface CommitStats { add: NumberMap; del: NumberMap }
export interface ApiPage<T> { data: T; next: string | null }
export type RequestPage = <T>(path: string) => Promise<ApiPage<T> | null>;
interface Cache {
  version: 3;
  login: string;
  initialized: boolean;
  commits: Record<string, CommitStats>;
  scannedHeads: string[];
}
type Branch = { commit: { sha: string } };
type Commit = { sha: string };
type Details = { files?: Array<{ filename: string; additions?: number; deletions?: number }> };
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
  toml:"TOML",md:"Markdown",mdx:"MDX",tex:"TeX",ipynb:"Jupyter Notebook",sol:"Solidity",
  zig:"Zig",qml:"QML"
};
const IGNORED = new Set(["package-lock.json","yarn.lock","pnpm-lock.yaml","composer.lock","cargo.lock","poetry.lock","go.sum"]);
export function languageOf(filename: string): string | null {
  const base = filename.split("/").pop()?.toLowerCase() ?? "";
  if (IGNORED.has(base) || base.endsWith(".min.js") || base.endsWith(".min.css")) return null;
  if (base === "dockerfile") return "Dockerfile";
  return EXT_LANGUAGE[base.split(".").pop() ?? ""] ?? null;
}
const validMap = (v: unknown): v is NumberMap => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(n => Number.isSafeInteger(n) && (n as number) >= 0);
const cacheFile = (dir: string) => path.join(dir,"contrib-cache-v3.json");
function readCache(login: string, dir: string): Cache {
  let value: Cache;
  try { value = JSON.parse(fs.readFileSync(cacheFile(dir),"utf8")) as Cache; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version:3,login,initialized:false,commits:{},scannedHeads:[] }; throw e; }
  if (value.version !== 3 || value.login !== login || typeof value.initialized !== "boolean" || !Array.isArray(value.scannedHeads) || !value.scannedHeads.every(x => /^[a-f0-9]{40}$/.test(x)) || !value.commits || !Object.entries(value.commits).every(([sha,s]) => /^[a-f0-9]{40}$/.test(sha) && validMap(s.add) && validMap(s.del))) throw new Error("Invalid v3 contribution cache");
  return value;
}
function save(dir: string, cache: Cache) {
  fs.mkdirSync(dir,{recursive:true});
  const tmp = `${cacheFile(dir)}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(cache,null,2));
  fs.renameSync(tmp,cacheFile(dir));
}
function summarize(commits: Iterable<CommitStats>, mode: "churn" | "additions") {
  const result = new Map<string,number>();
  for (const stats of commits) for (const lang of new Set([...Object.keys(stats.add),...Object.keys(stats.del)])) {
    if (CONTRIB_EXCLUDE.has(lang)) continue;
    result.set(lang,(result.get(lang) ?? 0) + (stats.add[lang] ?? 0) + (mode === "churn" ? stats.del[lang] ?? 0 : 0));
  }
  return result;
}
/** Rebuild from authorized non-Fork and selected organization repositories only.
 * v3 intentionally does not reuse old v2 SHA cache because that cache may contain Fork commits.
 */
export async function getContributionStats(repositories: Iterable<string>, login: string, dir: string,
  request: RequestPage, stopped: () => boolean, mode: "churn" | "additions"): Promise<Map<string,number> | null> {
  const cache = readCache(login,dir);
  const heads = new Set(cache.scannedHeads);
  let complete = true;
  try {
    for (const repo of new Set(repositories)) {
      if (stopped()) { complete = false; break; }
      let branches: string | null = `/repos/${repo}/branches?per_page=100`;
      while (branches) {
        const page: ApiPage<Branch[]> | null = await request<Branch[]>(branches);
        if (!page) { complete = false; break; }
        for (const branch of page.data) {
          const head = branch.commit.sha;
          if (heads.has(head)) continue;
          let success = true;
          let url: string | null = `/repos/${repo}/commits?sha=${encodeURIComponent(head)}&author=${encodeURIComponent(login)}&per_page=100`;
          while (url) {
            if (stopped()) { success = false; break; }
            const cp: ApiPage<Commit[]> | null = await request<Commit[]>(url);
            if (!cp) { success = false; break; }
            for (const {sha} of cp.data) {
              if (Object.hasOwn(cache.commits,sha)) continue;
              const stats: CommitStats = {add:{},del:{}};
              let detailUrl: string | null = `/repos/${repo}/commits/${sha}?per_page=100`;
              let count = 0;
              while (detailUrl) {
                const dp: ApiPage<Details> | null = await request<Details>(detailUrl);
                if (!dp?.data.files) { success = false; break; }
                count += dp.data.files.length;
                if (count >= 3000) throw new Error(`Commit ${sha} exceeds file listing limit`);
                for (const file of dp.data.files) {
                  const lang = languageOf(file.filename);
                  if (!lang) continue;
                  stats.add[lang] = (stats.add[lang] ?? 0) + (file.additions ?? 0);
                  stats.del[lang] = (stats.del[lang] ?? 0) + (file.deletions ?? 0);
                }
                detailUrl = dp.next;
              }
              if (!success) break;
              cache.commits[sha] = stats;
            }
            if (!success) break;
            url = cp.next;
          }
          if (success) { heads.add(head); cache.scannedHeads.push(head); }
          else complete = false;
        }
        branches = page.next;
      }
    }
    if (complete) cache.initialized = true;
  } finally { save(dir,cache); }
  if (!cache.initialized) {
    console.warn("Initial commit rescan incomplete; retain existing SVG and retry next run");
    return null;
  }
  return summarize(Object.values(cache.commits),mode);
}
