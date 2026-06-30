import fs from "fs";
import path from "path";
import { graphql } from "@octokit/graphql";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required.");

type NumberMap = Record<string, number>;

interface CloneCache {
  trackingStartedAt: string | null;
  total: number;
  lastCountedDate: string | null;
}

interface ContributionCacheEntry {
  lastDate: string | null;
  boundaryShas: string[];
  add: NumberMap;
  del: NumberMap;
}

type ContributionCache = Record<string, ContributionCacheEntry>;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface OrganizationsResponse {
  viewer: {
    organizations: {
      nodes: Array<{ login: string }>;
      pageInfo: PageInfo;
    };
  };
}

interface OwnedRepository {
  nameWithOwner: string;
}

interface OwnedRepositoriesResponse {
  viewer: {
    repositories: {
      nodes: Array<OwnedRepository & { stargazerCount: number }>;
      pageInfo: PageInfo;
    };
  };
}

interface CloneTraffic {
  clones: Array<{
    timestamp: string;
    count: number;
  }>;
}

interface CommitRef {
  sha: string;
  date: string | null;
}

interface RestCommit {
  sha: string;
  commit?: {
    committer?: { date?: string | null };
    author?: { date?: string | null };
  };
}

interface RestCommitDetail {
  files?: Array<{
    filename: string;
    additions?: number;
    deletions?: number;
  }>;
}

// 右列“我的贡献”统计方法：
//   "additions" -> 新增的行
//   "churn"     -> 新增 + 删除
const COUNT_MODE = "churn";

// “我的贡献”中忽略的语言
const CONTRIB_EXCLUDE = new Set(["Markdown", "MDX", "YAML", "JSON", "TOML", "TeX"]);

// 组织：填 "all" 统计你所属的全部组织；或填某个组织 login 只统计该组织
const ORG_LOGIN = "all";

// Actions 会显式传入 stats-data；本地默认使用旁边的私有仓库。
const DATA_DIR =
  process.env.STATS_DATA_DIR ||
  path.resolve("..", "Siornya-profile-data");
const CACHE_PATH = path.join(DATA_DIR, "contrib-cache.json");
const CLONE_CACHE_PATH = path.join(DATA_DIR, "clone-cache.json");

const gql = graphql.defaults({
  headers: { authorization: `token ${token}` },
});

const GH_API = "https://api.github.com";

let rateLimited = false;

async function ghRest<T>(apiPath: string): Promise<T | null> {
  if (rateLimited) return null;

  const res = await fetch(`${GH_API}${apiPath}`, {
    headers: {
      authorization: `token ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "siornya-stats",
    },
  });

  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");

  if (res.status === 403 && remaining === 0) {
    console.warn("Rate limit reached — stopping with partial data.");
    rateLimited = true;
    return null;
  }

  if (!res.ok) {
    if (res.status === 404 || res.status === 409) return null; // 空仓库/无权限等，跳过
    throw new Error(`GitHub REST request failed: ${res.status} ${res.statusText}`);
  }

  if (remaining > 0 && remaining < 40) {
    console.warn(`Rate limit low (${remaining} left) — stopping early.`);
    rateLimited = true;
  }

  return res.json() as Promise<T>;
}

// 扩展名 -> 语言
const EXT_LANGUAGE: Record<string, string> = {
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript",
  py: "Python", pyw: "Python",
  java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", groovy: "Groovy",
  c: "C", h: "C",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++",
  cs: "C#",
  go: "Go", rs: "Rust", rb: "Ruby", php: "PHP", swift: "Swift", dart: "Dart",
  m: "Objective-C", mm: "Objective-C++",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  lua: "Lua", r: "R", jl: "Julia", pl: "Perl", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", hs: "Haskell", clj: "Clojure", elm: "Elm", nim: "Nim",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  vue: "Vue", svelte: "Svelte", astro: "Astro",
  sql: "SQL", graphql: "GraphQL", gql: "GraphQL",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  md: "Markdown", mdx: "MDX", tex: "TeX",
  ipynb: "Jupyter Notebook", sol: "Solidity", zig: "Zig",
};

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "cargo.lock", "poetry.lock", "go.sum",
]);

function languageOf(filename: string): string | null {
  const base = filename.split("/").pop()?.toLowerCase() ?? "";
  if (IGNORED_FILES.has(base)) return null;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return null;
  if (base === "dockerfile") return "Dockerfile";
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return EXT_LANGUAGE[ext] ?? null;
}

// 简单并发池
async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: size }, async () => {
    while (queue.length) {
      if (rateLimited) break;
      await worker(queue.shift()!);
    }
  });
  await Promise.all(runners);
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
};

const escapeXml = (value: unknown): string =>
  String(value).replace(/[<>&]/g, (character) => XML_ESCAPES[character]!);

const maxDate = (
  a: string | null,
  b: string | null,
): string | null => (!a ? b : !b ? a : a > b ? a : b);

const nextUtcDate = (date: string): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

// =====================================================================
// 1) 基本信息
// =====================================================================
const { viewer } = await gql<{
  viewer: { login: string; createdAt: string };
}>(`query { viewer { login createdAt } }`);
const login = viewer.login;
const createdYear = new Date(viewer.createdAt).getFullYear();
const nowYear = new Date().getFullYear();

// 解析要统计的组织列表（ORG_LOGIN === "all" -> 你所属的全部组织）
async function getOrgLogins(): Promise<string[]> {
  const q = `
    query($cursor: String) {
      viewer {
        organizations(first: 100, after: $cursor) {
          nodes { login }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const logins: string[] = [];
  let cursor: string | null = null;
  do {
    const r: OrganizationsResponse = await gql<OrganizationsResponse>(
      q,
      { cursor },
    );
    const page: OrganizationsResponse["viewer"]["organizations"] =
      r.viewer.organizations;
    for (const n of page.nodes) logins.push(n.login);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return logins;
}

const orgLogins = ORG_LOGIN === "all" ? await getOrgLogins() : [ORG_LOGIN];
const orgSet = new Set(orgLogins);

// =====================================================================
// 2) Total Stars（你拥有的 public/private 非 fork 仓库）
// =====================================================================
async function getOwnedRepositories(): Promise<{
  repositories: OwnedRepository[];
  stars: number;
}> {
  let stars = 0;
  const repositories: OwnedRepository[] = [];

  const ownedQ = `
    query($cursor: String, $privacy: RepositoryPrivacy!) {
      viewer {
        repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], isFork: false, privacy: $privacy) {
          nodes { nameWithOwner stargazerCount }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  for (const privacy of ["PUBLIC", "PRIVATE"] as const) {
    let cursor: string | null = null;
    do {
      const r: OwnedRepositoriesResponse =
        await gql<OwnedRepositoriesResponse>(ownedQ, { cursor, privacy });
      const page: OwnedRepositoriesResponse["viewer"]["repositories"] =
        r.viewer.repositories;
      for (const n of page.nodes) {
        stars += n.stargazerCount;
        repositories.push({ nameWithOwner: n.nameWithOwner });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }

  return { repositories, stars };
}

const { repositories: ownedRepositories, stars: totalStars } =
  await getOwnedRepositories();

let cloneCache: CloneCache = {
  trackingStartedAt: null,
  total: 0,
  lastCountedDate: null,
};
try {
  const parsed = JSON.parse(
    fs.readFileSync(CLONE_CACHE_PATH, "utf8"),
  ) as CloneCache;
  if (typeof parsed?.total === "number") cloneCache = parsed;
} catch {
  // 首次运行时创建缓存
}

cloneCache.trackingStartedAt ??= new Date().toISOString().slice(0, 10);

const latestDailyClones: NumberMap = {};
let cloneCollectionComplete = true;

for (const repository of ownedRepositories) {
  if (rateLimited) {
    cloneCollectionComplete = false;
    break;
  }

  const traffic = await ghRest<CloneTraffic>(
    `/repos/${repository.nameWithOwner}/traffic/clones?per=day`,
  );
  if (!traffic?.clones) {
    cloneCollectionComplete = false;
    continue;
  }

  for (const day of traffic.clones) {
    const date = day.timestamp.slice(0, 10);
    latestDailyClones[date] = (latestDailyClones[date] || 0) + day.count;
  }
}

if (cloneCollectionComplete) {
  const today = new Date().toISOString().slice(0, 10);
  const completeDates = Object.keys(latestDailyClones)
    .filter((date) => date < today)
    .sort();

  if (completeDates.length) {
    const oldestAvailable = completeDates[0]!;
    const newDates = completeDates.filter(
      (date) =>
        cloneCache.lastCountedDate === null ||
        date > cloneCache.lastCountedDate,
    );

    if (
      cloneCache.lastCountedDate !== null &&
      newDates.length &&
      oldestAvailable > nextUtcDate(cloneCache.lastCountedDate)
    ) {
      console.warn("Clone history has a gap because collection was delayed.");
    }

    for (const date of newDates)
      cloneCache.total += latestDailyClones[date] || 0;

    const newestAvailable = completeDates.at(-1)!;
    if (
      cloneCache.lastCountedDate === null ||
      newestAvailable > cloneCache.lastCountedDate
    ) {
      cloneCache.lastCountedDate = newestAvailable;
    }
  }
} else {
  console.warn("Clone collection incomplete — keeping the previous total.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(CLONE_CACHE_PATH, JSON.stringify(cloneCache, null, 2));

const totalClones = cloneCache.total;

// =====================================================================
// 3) 逐年找出“所有你提交过的仓库”，并累加 all-time 总贡献数
// =====================================================================
const contribQuery = `
  query($from: DateTime!, $to: DateTime!) {
    viewer {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar { totalContributions }
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner owner { login } }
        }
      }
    }
  }
`;

let totalContributions = 0;
const repositoryNames = new Set<string>();

for (let year = createdYear; year <= nowYear; year++) {
  const from = new Date(Date.UTC(year, 0, 1)).toISOString();
  const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();

  const { viewer: v } = await gql<{
    viewer: {
      contributionsCollection: {
        contributionCalendar: { totalContributions: number };
        commitContributionsByRepository: Array<{
          repository: OwnedRepository & { owner: { login: string } };
        }>;
      };
    };
  }>(contribQuery, { from, to });
  const cc = v.contributionsCollection;
  totalContributions += cc.contributionCalendar.totalContributions;

  for (const { repository } of cc.commitContributionsByRepository) {
    const owner = repository.owner.login;
    if (owner === login || orgSet.has(owner))
      repositoryNames.add(repository.nameWithOwner);
  }
}

// =====================================================================
// 4) 逐仓库增量统计你的提交（带缓存）
// =====================================================================
let cache: ContributionCache = {};
try {
  cache = JSON.parse(
    fs.readFileSync(CACHE_PATH, "utf8"),
  ) as ContributionCache;
} catch {
  cache = {};
}

// 取该仓库自上次以来的新 commit（按 lastDate 限定 + 边界 SHA 去重）
async function fetchNewCommits(
  repoFullName: string,
  entry: ContributionCacheEntry,
): Promise<CommitRef[]> {
  const sinceParam = entry.lastDate
    ? `&since=${encodeURIComponent(entry.lastDate)}`
    : "";
  const boundary = new Set(entry.boundaryShas);
  const out: CommitRef[] = [];

  for (let page = 1; ; page++) {
    if (rateLimited) break;
    const list = await ghRest<RestCommit[]>(
      `/repos/${repoFullName}/commits?author=${encodeURIComponent(login)}&per_page=100&page=${page}${sinceParam}`,
    );
    if (!list || list.length === 0) break;
    for (const c of list) {
      if (boundary.has(c.sha)) continue; // 上次已统计过的边界 commit
      const date = c.commit?.committer?.date || c.commit?.author?.date || null;
      out.push({ sha: c.sha, date });
    }
    if (list.length < 100) break;
  }
  return out;
}

for (const repoFullName of repositoryNames) {
  if (rateLimited) break;

  const entry = cache[repoFullName] || {
    lastDate: null,
    boundaryShas: [],
    add: {},
    del: {},
  };

  const newCommits = await fetchNewCommits(repoFullName, entry);
  if (!newCommits.length) {
    cache[repoFullName] = entry;
    continue;
  }

  // 累加到临时对象；只有整仓完整处理完才并入，避免限流中途导致重复/漏算
  const tmpAdd: NumberMap = {};
  const tmpDel: NumberMap = {};

  await pool(newCommits, 6, async ({ sha }) => {
    const detail = await ghRest<RestCommitDetail>(
      `/repos/${repoFullName}/commits/${sha}`,
    );
    if (!detail?.files) return;
    for (const f of detail.files) {
      const lang = languageOf(f.filename);
      if (!lang) continue;
      tmpAdd[lang] = (tmpAdd[lang] || 0) + (f.additions || 0);
      tmpDel[lang] = (tmpDel[lang] || 0) + (f.deletions || 0);
    }
  });

  if (rateLimited) {
    // 本仓未跑完：不推进 lastDate，下次重做（entry 维持原样）
    cache[repoFullName] = entry;
    break;
  }

  for (const [k, v] of Object.entries(tmpAdd))
    entry.add[k] = (entry.add[k] || 0) + v;
  for (const [k, v] of Object.entries(tmpDel))
    entry.del[k] = (entry.del[k] || 0) + v;

  // 推进边界
  let newest = entry.lastDate;
  for (const c of newCommits) newest = maxDate(newest, c.date);
  let boundaryShas = newCommits.filter((c) => c.date === newest).map((c) => c.sha);
  if (newest === entry.lastDate)
    boundaryShas = [...new Set([...entry.boundaryShas, ...boundaryShas])];
  entry.lastDate = newest;
  entry.boundaryShas = boundaryShas;

  cache[repoFullName] = entry;
}

// 保存缓存（即使限流也保存已完成部分的进度）
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

// 汇总右列语言
const contribLangs = new Map<string, number>();
for (const entry of Object.values(cache)) {
  const add = entry.add || {};
  const del = entry.del || {};
  const names = new Set([...Object.keys(add), ...Object.keys(del)]);
  for (const name of names) {
    if (CONTRIB_EXCLUDE.has(name)) continue;
    const weight =
      COUNT_MODE === "churn"
        ? (add[name] || 0) + (del[name] || 0)
        : add[name] || 0;
    if (weight > 0) contribLangs.set(name, (contribLangs.get(name) || 0) + weight);
  }
}

// =====================================================================
// 5) 渲染 SVG
// =====================================================================
// 取前 5，其余汇总成 Others
interface RowsData {
  rows: Array<[string, number]>;
  total: number;
}

function buildRows(map: Map<string, number>): RowsData {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0) || 1;
  const top = sorted.slice(0, 5);
  const othersVal = total - top.reduce((s, [, v]) => s + v, 0);
  const rows = [...top];
  if (othersVal > 0.5) rows.push(["Others", othersVal]);
  return { rows, total };
}

// My Contributions
const left = buildRows(contribLangs);
const maxRows = Math.max(left.rows.length, 1);

const cardWidth = 420;
const cardHeight = 285 + maxRows * 38;

function renderColumn(
  { rows, total }: RowsData,
  colX: number,
  title: string,
): string {
  let out = `
    <text x="${colX}" y="250" class="text">${title}</text>`;
  rows.forEach(([name, size], i) => {
    const percent = ((size / total) * 100).toFixed(1);
    const barW = (size / total) * 140;
    const y = 290 + i * 38;
    const isOthers = name === "Others";
    const barFill = isOthers ? "#ffffff30" : "url(#barGradient)";
    out += `
      <text x="${colX}" y="${y}" class="lang"${isOthers ? ' opacity="0.7"' : ""}>${escapeXml(name)}</text>
      <rect x="${colX + 95}" y="${y - 14}" width="140" height="11" rx="5.5" fill="#ffffff18"/>
      <rect x="${colX + 95}" y="${y - 14}" width="${barW}" height="11" rx="5.5" fill="${barFill}"/>
      <text x="${colX + 245}" y="${y}" class="percent">${percent}%</text>`;
  });
  return out;
}

const svg = `
<svg width="${cardWidth}"
     height="${cardHeight}"
     viewBox="0 0 ${cardWidth} ${cardHeight}"
     xmlns="http://www.w3.org/2000/svg">

  <defs>

    <linearGradient id="bgGradient"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%">

      <stop offset="0%"
            stop-color="#2f1d30"/>

      <stop offset="55%"
            stop-color="#241a2b"/>

      <stop offset="100%"
            stop-color="#171622"/>
    </linearGradient>

    <linearGradient id="barGradient"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="0%">

      <stop offset="0%"
            stop-color="#ffb7d5"/>

      <stop offset="100%"
            stop-color="#ffc8dd"/>
    </linearGradient>

    <filter id="shadow">
      <feDropShadow dx="0"
                    dy="8"
                    stdDeviation="18"
                    flood-color="#ffb7d5"
                    flood-opacity="0.18"/>
    </filter>

  </defs>

  <style>
    .title {
      fill: #ffe4ef;
      font-size: 30px;
      font-family: Inter, sans-serif;
      font-weight: 700;
      letter-spacing: 0.5px;
    }

    .text {
      fill: #f7c9dd;
      font-size: 17px;
      font-family: Inter, sans-serif;
    }

    .lang {
      fill: #fff0f6;
      font-size: 15px;
      font-family: Inter, sans-serif;
    }

    .percent {
      fill: #e7a9c4;
      font-size: 14px;
      font-family: Inter, sans-serif;
    }

    .small {
      fill: #d38ba8;
      font-size: 13px;
      font-family: Inter, sans-serif;
    }
  </style>

  <!-- background -->
  <rect width="100%"
        height="100%"
        rx="28"
        fill="url(#bgGradient)"
        filter="url(#shadow)"/>

  <!-- soft glow -->
  <circle cx="${cardWidth - 90}"
          cy="70"
          r="90"
          fill="#ffb7d5"
          opacity="0.08"/>

  <circle cx="120"
          cy="${cardHeight - 60}"
          r="70"
          fill="#ffc8dd"
          opacity="0.05"/>

  <!-- title -->
  <g class="title"
   transform="translate(36, 20) scale(0.9)"
   stroke="none">
  <path
  d="M 115.305 47.025 Q 115.08 48.3 112.38 48.3 Q 111.18 48.3 110.768 48.15 Q 110.355 48 110.355 47.775 Q 110.355 47.55 110.768 45.825 Q 111.18 44.1 111.48 42.15 L 114.555 25.425 Q 115.305 21.225 113.355 21.225 Q 112.53 21.225 111.255 22.088 Q 109.98 22.95 108.405 24.525 Q 108.18 24.825 107.88 24.488 Q 107.58 24.15 107.805 23.925 Q 110.43 20.925 112.568 19.5 Q 114.705 18.075 116.73 18.075 Q 118.755 18.075 119.318 19.725 Q 119.88 21.375 119.205 25.05 L 115.305 47.025 L 114.255 46.95 Q 115.83 38.175 118.418 31.613 Q 121.005 25.05 124.418 21.413 Q 127.83 17.775 131.58 17.775 Q 134.805 17.775 135.93 20.1 Q 137.055 22.425 136.08 27.675 L 133.605 41.025 Q 133.23 43.275 133.605 44.213 Q 133.98 45.15 134.805 45.15 Q 135.63 45.15 136.793 44.25 Q 137.955 43.35 139.455 41.925 Q 139.68 41.625 139.98 41.925 Q 140.28 42.225 140.055 42.525 Q 137.655 45.3 135.63 46.838 Q 133.605 48.375 131.505 48.375 Q 129.405 48.375 128.88 46.65 Q 128.355 44.925 129.03 41.025 L 131.205 29.1 Q 132.855 21.075 128.73 21.075 Q 126.405 21.075 123.855 24.113 Q 121.305 27.15 119.055 32.925 Q 116.805 38.7 115.305 47.025 Z M 0.03 44.625 L 1.53 34.5 Q 1.53 34.125 1.943 34.125 Q 2.355 34.125 2.43 34.5 Q 2.73 38.1 3.93 40.988 Q 5.13 43.875 7.305 45.525 Q 9.48 47.175 12.705 47.175 Q 14.955 47.175 16.905 46.313 Q 18.855 45.45 20.28 43.575 Q 21.705 41.7 22.155 38.775 Q 22.83 35.4 21.743 32.963 Q 20.655 30.525 18.555 28.688 Q 16.455 26.85 14.13 25.2 Q 11.805 23.475 9.743 21.675 Q 7.68 19.875 6.593 17.475 Q 5.505 15.075 6.105 11.625 Q 6.855 7.725 9.255 5.138 Q 11.655 2.55 14.993 1.275 Q 18.33 0 21.78 0 Q 23.73 0 25.83 0.413 Q 27.93 0.825 30.105 1.8 Q 31.08 2.325 31.005 3.075 L 29.955 11.85 Q 29.955 12.075 29.543 12.075 Q 29.13 12.075 29.13 11.85 Q 28.755 9.075 27.78 6.638 Q 26.805 4.2 25.005 2.738 Q 23.205 1.275 20.28 1.275 Q 17.58 1.275 15.818 2.475 Q 14.055 3.675 13.043 5.475 Q 12.03 7.275 11.655 9.15 Q 11.13 12.225 12.18 14.4 Q 13.23 16.575 15.255 18.263 Q 17.28 19.95 19.53 21.6 Q 22.005 23.325 24.218 25.238 Q 26.43 27.15 27.63 29.7 Q 28.83 32.25 28.23 35.85 Q 27.63 39.375 25.418 42.263 Q 23.205 45.15 19.568 46.875 Q 15.93 48.6 10.83 48.6 Q 8.28 48.6 5.768 48.038 Q 3.255 47.475 0.48 46.05 Q 0.18 45.825 0.068 45.488 Q -0.045 45.15 0.03 44.625 Z M 202.305 23.1 L 198.705 20.925 Q 199.755 20.775 201.03 19.688 Q 202.305 18.6 202.905 17.175 Q 203.055 16.95 203.468 17.063 Q 203.88 17.175 203.805 17.325 L 199.455 41.025 Q 198.705 45.15 200.43 45.15 Q 201.255 45.15 202.493 44.25 Q 203.73 43.35 205.155 41.925 Q 205.38 41.7 205.68 42 Q 205.98 42.3 205.755 42.525 Q 203.355 45.3 201.33 46.838 Q 199.305 48.375 197.355 48.375 Q 195.33 48.375 194.73 46.688 Q 194.13 45 194.805 41.025 L 196.605 30.525 L 197.955 29.25 Q 195.93 35.1 192.968 39.488 Q 190.005 43.875 186.743 46.275 Q 183.48 48.675 180.405 48.675 Q 177.93 48.675 176.618 46.875 Q 175.305 45.075 175.83 40.875 Q 176.43 36.9 178.455 32.85 Q 180.48 28.8 183.368 25.35 Q 186.255 21.9 189.555 19.838 Q 192.855 17.775 195.855 17.775 Q 197.28 17.775 198.705 18.3 Q 200.13 18.825 201.143 19.988 Q 202.155 21.15 202.305 23.1 Z M 183.78 44.4 Q 185.805 44.4 187.905 42.863 Q 190.005 41.325 191.918 38.775 Q 193.83 36.225 195.218 33.225 Q 196.605 30.225 197.13 27.525 Q 197.73 24.525 196.643 22.613 Q 195.555 20.7 192.93 20.775 Q 190.455 20.775 187.98 22.875 Q 185.505 24.975 183.555 28.538 Q 181.605 32.1 180.93 36.675 Q 180.33 40.725 181.08 42.563 Q 181.83 44.4 183.78 44.4 Z M 89.205 47.025 Q 88.98 48.3 86.28 48.3 Q 85.08 48.3 84.705 48.15 Q 84.33 48 84.33 47.775 Q 84.33 47.55 84.743 45.75 Q 85.155 43.95 85.455 42.15 L 88.155 27.375 Q 88.605 24.9 88.493 23.625 Q 88.38 22.35 87.93 21.788 Q 87.48 21.225 86.805 21.225 Q 85.905 21.225 84.743 22.088 Q 83.58 22.95 82.38 24.075 Q 82.155 24.3 81.855 24 Q 81.555 23.7 81.78 23.475 Q 84.18 20.7 86.205 19.388 Q 88.23 18.075 90.18 18.075 Q 91.605 18.075 92.393 18.9 Q 93.18 19.725 93.293 21.675 Q 93.405 23.625 92.805 27 L 89.205 47.025 L 88.455 46.95 Q 89.13 43.425 90.18 39.45 Q 91.23 35.475 92.58 31.688 Q 93.93 27.9 95.505 24.825 Q 97.08 21.75 98.768 19.913 Q 100.455 18.075 102.255 18.075 Q 103.305 18.075 104.393 18.638 Q 105.48 19.2 106.155 20.175 Q 106.83 21.15 106.605 22.35 Q 106.455 23.325 105.743 24 Q 105.03 24.675 103.905 24.675 Q 102.78 24.675 102.143 24.075 Q 101.505 23.475 101.018 22.875 Q 100.53 22.275 99.705 22.275 Q 98.73 22.275 97.53 24 Q 96.33 25.725 95.055 28.5 Q 93.78 31.275 92.618 34.613 Q 91.455 37.95 90.555 41.213 Q 89.655 44.475 89.205 47.025 Z M 140.055 68.775 Q 138.48 68.775 137.43 67.988 Q 136.38 67.2 136.605 65.25 Q 137.13 62.775 140.055 62.775 Q 141.63 62.775 143.093 62.963 Q 144.555 63.15 145.98 62.925 Q 147.405 62.7 148.83 61.725 Q 150.48 60.6 152.693 57.863 Q 154.905 55.125 157.305 51.6 Q 159.705 48.075 161.88 44.363 Q 164.055 40.65 165.593 37.463 Q 167.13 34.275 167.58 32.325 Q 168.105 30 167.918 28.275 Q 167.73 26.55 167.205 25.238 Q 166.68 23.925 166.193 22.913 Q 165.705 21.9 165.705 20.85 Q 165.705 19.575 166.605 18.788 Q 167.505 18 168.93 18 Q 170.58 18 171.368 19.2 Q 172.155 20.4 172.155 22.5 Q 172.155 25.05 170.955 28.8 Q 169.755 32.55 167.655 36.938 Q 165.555 41.325 162.855 45.788 Q 160.155 50.25 157.155 54.375 Q 154.155 58.5 151.043 61.725 Q 147.93 64.95 145.118 66.863 Q 142.305 68.775 140.055 68.775 Z M 159.03 49.875 Q 159.405 43.35 158.918 37.613 Q 158.43 31.875 157.155 27.488 Q 155.88 23.1 153.893 20.588 Q 151.905 18.075 149.355 18.075 Q 147.255 18.075 145.23 19.65 Q 143.205 21.225 141.855 24.075 Q 141.78 24.375 142.193 24.488 Q 142.605 24.6 142.755 24.3 Q 143.43 22.95 144.405 22.313 Q 145.38 21.675 146.355 21.675 Q 150.48 21.675 152.73 30.788 Q 154.98 39.9 154.605 56.7 L 159.03 49.875 Z M 37.38 41.025 L 40.455 25.425 Q 41.28 21.225 39.18 21.225 Q 38.355 21.225 37.08 22.088 Q 35.805 22.95 34.305 24.525 Q 34.08 24.825 33.743 24.488 Q 33.405 24.15 33.705 23.925 Q 36.33 20.925 38.43 19.5 Q 40.53 18.075 42.48 18.075 Q 44.58 18.075 45.18 19.725 Q 45.78 21.375 45.03 25.05 L 41.955 41.025 Q 41.505 43.275 41.88 44.213 Q 42.255 45.15 43.08 45.15 Q 43.905 45.15 45.143 44.288 Q 46.38 43.425 47.805 42 Q 48.105 41.7 48.405 42.038 Q 48.705 42.375 48.405 42.6 Q 46.005 45.45 43.943 46.913 Q 41.88 48.375 39.855 48.375 Q 37.83 48.375 37.193 46.688 Q 36.555 45 37.38 41.025 Z M 61.905 48.75 Q 58.155 48.75 55.793 46.65 Q 53.43 44.55 52.643 41.025 Q 51.855 37.5 52.605 33.225 Q 53.505 28.8 55.83 25.313 Q 58.155 21.825 61.493 19.8 Q 64.83 17.775 68.655 17.775 Q 72.63 17.775 75.03 19.875 Q 77.43 21.975 78.218 25.5 Q 79.005 29.025 78.18 33.225 Q 77.205 38.1 74.655 41.588 Q 72.105 45.075 68.73 46.913 Q 65.355 48.75 61.905 48.75 Z M 64.53 46.875 Q 67.38 46.875 69.705 44.138 Q 72.03 41.4 72.93 36.525 Q 73.455 33.525 73.343 30.563 Q 73.23 27.6 72.405 25.088 Q 71.58 22.575 70.08 21.075 Q 68.58 19.575 66.33 19.575 Q 63.555 19.575 61.193 22.275 Q 58.83 24.975 57.855 30 Q 57.255 33.075 57.405 36.038 Q 57.555 39 58.418 41.475 Q 59.28 43.95 60.818 45.413 Q 62.355 46.875 64.53 46.875 Z M 44.655 9.525 Q 43.005 9.525 42.068 8.625 Q 41.13 7.725 41.13 6 Q 41.13 4.425 42.068 3.525 Q 43.005 2.625 44.655 2.625 Q 46.38 2.625 47.28 3.525 Q 48.18 4.425 48.18 6 Q 48.18 9.525 44.655 9.525 Z"
    />
  <path
    d="M 8 3 C 8 1.5 6.5 0 4.5 0 C 2.5 0 0 1.8 0 4.5 C 0 7.5 4 11 8 14 C 12 11 16 7.5 16 4.5 C 16 1.8 13.5 0 11.5 0 C 9.5 0 8 1.5 8 3 Z"
    transform="translate(220, 24)"
    stroke="none"
    />
  </g>

  <text x="38"
        y="82"
        class="small">
    GitHub Statistics
  </text>

  <!-- stats -->
  <text x="40"
        y="130"
        class="text">
    ✦ Total Contributions: ${totalContributions}
  </text>

  <text x="40"
        y="164"
        class="text">
    ✦ Total Stars: ${totalStars}
  </text>

  <text x="40"
        y="198"
        class="text">
    ✦ Total Clones: ${totalClones}
  </text>

  <!-- contributions -->
  ${renderColumn(left, 40, "My Contributions")}

</svg>
`;

fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync("assets/github-stats.svg", svg);

