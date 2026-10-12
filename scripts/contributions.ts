import fs from "node:fs";
import path from "node:path";

export type NumberMap = Record<string, number>;

export interface CommitStats {
	add: NumberMap;
	del: NumberMap;
}

export interface ContributionCache {
	version: 2;
	login: string;
	initialized: boolean;
	// SHA 全局去重；同一提交出现在多个分支或 fork 时只计一次。
	commits: Record<string, CommitStats>;
	// 只有完整扫描过的 head 才记入；新增/移动/强推的分支会重新扫描。
	scannedHeads: string[];
}

export interface ApiPage<T> {
	data: T;
	next: string | null;
}

export type RequestPage = <T>(apiPath: string) => Promise<ApiPage<T> | null>;

interface Branch {
	name: string;
	commit: { sha: string };
}

interface Commit {
	sha: string;
}

interface CommitDetail {
	files?: Array<{ filename: string; additions?: number; deletions?: number }>;
}

export const CONTRIB_EXCLUDE = new Set(["Markdown", "MDX", "YAML", "JSON", "TOML", "TeX", "CSS"]);

export function createCache(login: string): ContributionCache {
	return { version: 2, login, initialized: false, commits: {}, scannedHeads: [] };
}

function isNumberMap(value: unknown): value is NumberMap {
	return typeof value === "object" && value !== null && !Array.isArray(value) &&
		Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0);
}

export function parseCache(value: unknown, login: string): ContributionCache {
	const cache = value as ContributionCache;
	if (
		cache?.version !== 2 || cache.login !== login ||
		typeof cache.initialized !== "boolean" ||
		!Array.isArray(cache.scannedHeads) ||
		!cache.scannedHeads.every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
		typeof cache.commits !== "object" || cache.commits === null || Array.isArray(cache.commits) ||
		!Object.entries(cache.commits).every(([sha, stats]) =>
			/^[a-f0-9]{40}$/.test(sha) && isNumberMap(stats?.add) && isNumberMap(stats?.del))
	) {
		throw new Error("Invalid contribution cache or cache belongs to a different account.");
	}
	return cache;
}

export function summarize(
	entries: Iterable<CommitStats>,
	mode: "churn" | "additions" = "churn",
): Map<string, number> {
	const languages = new Map<string, number>();
	for (const { add, del } of entries) {
		for (const language of new Set([...Object.keys(add), ...Object.keys(del)])) {
			if (CONTRIB_EXCLUDE.has(language)) continue;
			const weight = (add[language] || 0) + (mode === "churn" ? del[language] || 0 : 0);
			if (weight > 0) languages.set(language, (languages.get(language) || 0) + weight);
		}
	}
	return languages;
}

export function parseLegacyStats(value: unknown): CommitStats[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid legacy contribution cache.");
	}
	const entries = Object.values(value) as CommitStats[];
	if (!entries.every((entry) => isNumberMap(entry?.add) && isNumberMap(entry?.del))) {
		throw new Error("Invalid legacy contribution cache.");
	}
	return entries;
}

// GitHub 的日期过滤无法发现新分支上更早的提交，所以按不可变 head SHA 扫描完整历史。
// 已统计的提交永久保留：删除分支或强推不会扣除累计贡献。
export async function collectContributions(
	repositories: Iterable<string>,
	cache: ContributionCache,
	request: RequestPage,
	stopped: () => boolean,
): Promise<boolean> {
	const scannedHeads = new Set(cache.scannedHeads);
	let complete = true;
	for (const repository of new Set(repositories)) {
		let branchesPath: string | null = `/repos/${repository}/branches?per_page=100`;
		while (branchesPath) {
			if (stopped()) return false;
			const page: ApiPage<Branch[]> | null = await request<Branch[]>(branchesPath);
			if (!page) {
				complete = false;
				break;
			}
			for (const branch of page.data) {
				const head = branch.commit.sha;
				if (scannedHeads.has(head)) continue;
				if (!await collectHead(repository, head, cache, request, stopped)) {
					complete = false;
					continue;
				}
				scannedHeads.add(head);
				cache.scannedHeads.push(head);
			}
			branchesPath = page.next;
		}
	}
	return complete;
}

async function collectHead(
	repository: string,
	head: string,
	cache: ContributionCache,
	request: RequestPage,
	stopped: () => boolean,
): Promise<boolean> {
	let commitsPath: string | null = `/repos/${repository}/commits?sha=${encodeURIComponent(head)}&author=${encodeURIComponent(cache.login)}&per_page=100`;
	while (commitsPath) {
		if (stopped()) return false;
		const page: ApiPage<Commit[]> | null = await request<Commit[]>(commitsPath);
		if (!page) return false;
		for (const { sha } of page.data) {
			if (Object.hasOwn(cache.commits, sha)) continue;
			const stats: CommitStats = { add: {}, del: {} };
			let filesPath: string | null = `/repos/${repository}/commits/${sha}?per_page=100`;
			let fileCount = 0;
			while (filesPath) {
				if (stopped()) return false;
				const detail: ApiPage<CommitDetail> | null = await request<CommitDetail>(filesPath);
				if (!detail?.data.files) return false;
				fileCount += detail.data.files.length;
				// GitHub 只提供最多 3000 个文件；达到上限时拒绝保存不确定的结果。
				if (fileCount >= 3000) throw new Error(`Commit ${sha} reaches GitHub's 3000-file limit.`);
				for (const file of detail.data.files) {
					const language = languageOf(file.filename);
					if (!language) continue;
					stats.add[language] = (stats.add[language] || 0) + (file.additions || 0);
					stats.del[language] = (stats.del[language] || 0) + (file.deletions || 0);
				}
				filesPath = detail.next;
			}
			// 单个提交的所有文件齐全后才保存，限流/失败后可从未完成的提交续跑。
			cache.commits[sha] = stats;
		}
		commitsPath = page.next;
	}
	return true;
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
	qml: "QML",
};

const IGNORED_FILES = new Set([
	"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
	"cargo.lock", "poetry.lock", "go.sum",
]);

export function languageOf(filename: string): string | null {
	const base = filename.split("/").pop()?.toLowerCase() ?? "";
	if (IGNORED_FILES.has(base)) return null;
	if (base.endsWith(".min.js") || base.endsWith(".min.css")) return null;
	if (base === "dockerfile") return "Dockerfile";
	const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
	return EXT_LANGUAGE[ext] ?? null;
}

export async function getContributionStats(
	repositoryNames: Iterable<string>,
	login: string,
	dataDir: string,
	request: RequestPage,
	stopped: () => boolean,
	mode: "churn" | "additions",
): Promise<Map<string, number> | null> {
	const CACHE_PATH = path.join(dataDir, "contrib-cache-v2.json");
	const LEGACY_CACHE_PATH = path.join(dataDir, "contrib-cache.json");
	let cache: ContributionCache;
	try {
		cache = parseCache(JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")), login);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		cache = createCache(login);
	}

	let legacyStats: CommitStats[] | null = null;
	if (!cache.initialized) {
		try {
			legacyStats = parseLegacyStats(JSON.parse(fs.readFileSync(LEGACY_CACHE_PATH, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	try {
		const complete = await collectContributions(repositoryNames, cache, request, stopped);
		if (complete) cache.initialized = true;
		else console.warn("Contribution collection incomplete — saved progress for the next run.");
	} finally {
		// 完整提交立即记入缓存，失败/限流后也可续跑；旧汇总缓存不覆盖、不累加。
		fs.mkdirSync(dataDir, { recursive: true });
		const temporaryPath = `${CACHE_PATH}.tmp`;
		fs.writeFileSync(temporaryPath, JSON.stringify(cache, null, "\t"));
		fs.renameSync(temporaryPath, CACHE_PATH);
	}

	if (cache.initialized || legacyStats !== null) {
		return summarize(cache.initialized ? Object.values(cache.commits) : legacyStats!, mode);
	}
	console.warn("Initial rebuild incomplete and no legacy totals — keeping the existing SVG.");
	return null;
}
