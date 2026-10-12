import fs from "fs";
import path from "path";
import { graphql } from "@octokit/graphql";
import { getContributionStats } from "./contributions.ts";
import type { ApiPage, NumberMap } from "./contributions.ts";
import { renderStats } from "./render-stats.ts";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required.");

interface StarCache {
	total: number;
	lastCount: number;
}

interface CloneCache {
	trackingStartedAt: string | null;
	total: number;
	lastCountedDate: string | null;
}

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

interface Repository {
	nameWithOwner: string;
	isFork: boolean;
	owner: { login: string };
}

interface RepositoriesResponse {
	viewer: {
		repositories: {
			nodes: Array<Repository & { stargazerCount: number }>;
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

// “我的贡献”统计方法：
//   "additions" -> 新增的行
//   "churn"     -> 新增 + 删除
const COUNT_MODE = "churn";

// 组织：填 "all" 统计你所属的全部组织；或填某个组织 login 只统计该组织
const ORG_LOGIN = "all";

// Actions 会显式传入 stats-data；本地默认使用旁边的私有仓库。
const DATA_DIR =
	process.env.STATS_DATA_DIR ||
	path.resolve("..", "Siornya-profile-data");
const CLONE_CACHE_PATH = path.join(DATA_DIR, "clone-cache.json");
const STAR_CACHE_PATH = path.join(DATA_DIR, "star-cache.json");

const gql = graphql.defaults({
	headers: { authorization: `token ${token}` },
});

const GH_API = "https://api.github.com";

let rateLimited = false;

async function ghRestPage<T>(apiPath: string): Promise<ApiPage<T> | null> {
	if (rateLimited) return null;

	const res = await fetch(`${GH_API}${apiPath}`, {
		headers: {
			authorization: `token ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "siornya-stats",
		},
	});

	const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");

	if (res.status === 429 || (res.status === 403 && (remaining === 0 || res.headers.has("retry-after")))) {
		console.warn("Rate limit reached — stopping with partial data.");
		rateLimited = true;
		return null;
	}

	if (!res.ok) {
		if (res.status === 409 && /\/(branches|commits)\?/.test(apiPath)) {
			return { data: [] as T, next: null }; // 空仓库，没有可扫描的分支/提交
		}
		if (res.status === 404) return null; // 无权限等，不标记为已完整扫描
		throw new Error(`GitHub REST request failed: ${res.status} ${res.statusText}`);
	}

	if (remaining > 0 && remaining < 40) {
		console.warn(`Rate limit low (${remaining} left) — stopping early.`);
		rateLimited = true;
	}

	const nextUrl = res.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
	let next: string | null = null;
	if (nextUrl) {
		const url = new URL(nextUrl);
		if (url.origin !== GH_API) throw new Error("Unexpected GitHub pagination origin.");
		next = url.pathname + url.search;
	}
	return { data: await res.json() as T, next };
}

async function ghRest<T>(apiPath: string): Promise<T | null> {
	return (await ghRestPage<T>(apiPath))?.data ?? null;
}

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
// 2) 仓库列表（含 fork）和 Total Stars（你拥有的非 fork 仓库）
// =====================================================================
async function getRepositories(): Promise<{
	repositories: Repository[];
	stars: number;
}> {
	let stars = 0;
	const repositories: Repository[] = [];

	const repositoriesQuery = `
		query($cursor: String, $privacy: RepositoryPrivacy!) {
			viewer {
				repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], privacy: $privacy) {
					nodes { nameWithOwner stargazerCount isFork owner { login } }
					pageInfo { hasNextPage endCursor }
				}
			}
		}
	`;
	for (const privacy of ["PUBLIC", "PRIVATE"] as const) {
		let cursor: string | null = null;
		do {
			const r: RepositoriesResponse =
				await gql<RepositoriesResponse>(repositoriesQuery, { cursor, privacy });
			const page: RepositoriesResponse["viewer"]["repositories"] =
				r.viewer.repositories;
			for (const n of page.nodes) {
				if (n.owner.login === login && !n.isFork) stars += n.stargazerCount;
				if (n.owner.login === login || orgSet.has(n.owner.login)) repositories.push(n);
			}
			cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
		} while (cursor);
	}

	return { repositories, stars };
}

const { repositories: contributionRepositories, stars: currentStars } =
	await getRepositories();

let starCache: StarCache = { total: 0, lastCount: 0 };
try {
	const parsed = JSON.parse(
		fs.readFileSync(STAR_CACHE_PATH, "utf8"),
	) as StarCache;
	if (
		!Number.isSafeInteger(parsed?.total) || parsed.total < 0 ||
		!Number.isSafeInteger(parsed?.lastCount) || parsed.lastCount < 0
	) {
		throw new Error("Invalid star cache: total and lastCount must be non-negative integers.");
	}
	starCache = parsed;
} catch (error) {
	// 只有缓存不存在时才初始化，避免读取失败或损坏导致累计值归零。
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

// 仅累加两次快照间的正向差值；下降时也更新基准，下次从新基准计算。
starCache.total += Math.max(0, currentStars - starCache.lastCount);
starCache.lastCount = currentStars;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(STAR_CACHE_PATH, JSON.stringify(starCache, null, "\t"));

const totalStars = starCache.total;

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

for (const repository of contributionRepositories.filter((repo) => repo.owner.login === login && !repo.isFork)) {
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
// 3) 沿用原总贡献数，并累加本人开启的 PR / Issue，补充历史仓库
// =====================================================================
const contribQuery = `
	query($from: DateTime!, $to: DateTime!) {
		viewer {
			contributionsCollection(from: $from, to: $to) {
				contributionCalendar { totalContributions }
				totalPullRequestContributions
				totalIssueContributions
				commitContributionsByRepository(maxRepositories: 100) {
					repository { nameWithOwner owner { login } }
				}
			}
		}
	}
`;

let totalContributions = 0;
let totalPullRequests = 0;
let totalIssues = 0;
const repositoryNames = new Set(contributionRepositories.map((repo) => repo.nameWithOwner));

for (let year = createdYear; year <= nowYear; year++) {
	const from = new Date(Date.UTC(year, 0, 1)).toISOString();
	const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();

	const { viewer: v } = await gql<{
		viewer: {
			contributionsCollection: {
				contributionCalendar: { totalContributions: number };
				totalPullRequestContributions: number;
				totalIssueContributions: number;
				commitContributionsByRepository: Array<{
					repository: Repository & { owner: { login: string } };
				}>;
			};
		};
	}>(contribQuery, { from, to });
	const cc = v.contributionsCollection;
	totalContributions += cc.contributionCalendar.totalContributions;
	totalPullRequests += cc.totalPullRequestContributions;
	totalIssues += cc.totalIssueContributions;

	for (const { repository } of cc.commitContributionsByRepository) {
		const owner = repository.owner.login;
		if (owner === login || orgSet.has(owner))
			repositoryNames.add(repository.nameWithOwner);
	}
}

// =====================================================================
// 4) 所有分支的个人提交，按 SHA 全局去重
// =====================================================================
const contribLangs = await getContributionStats(
	repositoryNames,
	login,
	DATA_DIR,
	ghRestPage,
	() => rateLimited,
	COUNT_MODE,
);

// =====================================================================
// 5) 渲染 SVG
// =====================================================================
if (contribLangs !== null) {
	// 使用右列相同的语言过滤与 COUNT_MODE，排除 CONTRIB_EXCLUDE 的行数。
	const commitLines = [...contribLangs.values()].reduce((total, lines) => total + lines, 0);
	const svg = renderStats({ totalContributions, totalStars, totalPullRequests, totalIssues, totalClones, commitLines, contribLangs });
	fs.mkdirSync("assets", { recursive: true });
	fs.writeFileSync("assets/github-stats.svg", svg);
}
