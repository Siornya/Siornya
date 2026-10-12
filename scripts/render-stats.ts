import fs from "node:fs";

const template = fs.readFileSync(new URL("../templates/github-stats.svg", import.meta.url), "utf8");

export interface StatsCardData {
	totalContributions: number;
	totalStars: number;
	totalPullRequests: number | null;
	totalIssues: number | null;
	commitLines: number | null;
	totalClones: number;
	contribLangs: Map<string, number>;
}

const XML_ESCAPES: Record<string, string> = {
	"<": "&lt;",
	">": "&gt;",
	"&": "&amp;",
};

const escapeXml = (value: unknown): string =>
	String(value).replace(/[<>&]/g, (character) => XML_ESCAPES[character]!);

// 取前 5，其余汇总成 Others
interface RowsData {
	rows: Array<[string, number]>;
	total: number;
}

function buildRows(map: Map<string, number>): RowsData {
	const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
	const actualTotal = sorted.reduce((s, [, v]) => s + v, 0);
	const total = actualTotal || 1;
	const top = sorted.slice(0, 5);
	const othersVal = actualTotal - top.reduce((s, [, v]) => s + v, 0);
	const rows = [...top];
	if (othersVal > 0.5) rows.push(["Others", othersVal]);
	return { rows, total };
}

function renderColumn(
	{ rows, total }: RowsData,
	colX: number,
	title: string,
): string {
	let out = `
		<text x="${colX}" y="82" class="text">${title}</text>`;
	rows.forEach(([name, size], i) => {
		const percent = ((size / total) * 100).toFixed(1);
		const barW = (size / total) * 140;
		const y = 126 + i * 32;
		const isOthers = name === "Others";
		const barFill = isOthers ? "#ffffff30" : "url(#barGradient)";
		out += `
			<text x="${colX}" y="${y}" class="lang"${isOthers ? ' opacity="0.7"' : ""}>${escapeXml(name)}</text>
			<rect x="${colX + 130}" y="${y - 14}" width="140" height="11" rx="5.5" fill="#ffffff18"/>
			<rect x="${colX + 130}" y="${y - 14}" width="${barW}" height="11" rx="5.5" fill="${barFill}"/>
			<text x="${colX + 280}" y="${y}" class="percent">${percent}%</text>`;
	});
	return out;
}

const formatCount = (value: number | null): string => value === null ? "—" : value.toLocaleString("en-US");

export function renderStats(data: StatsCardData): string {
	const contributions = buildRows(data.contribLangs);
	const cardWidth = 760;
	const cardHeight = Math.max(334, 142 + contributions.rows.length * 32);
	const values: Record<string, string | number> = {
		cardWidth,
		cardHeight,
		glowX: cardWidth - 90,
		glowY: cardHeight - 60,
		dividerBottom: cardHeight - 44,
		totalContributions: formatCount(data.totalContributions),
		totalStars: formatCount(data.totalStars),
		totalPullRequests: formatCount(data.totalPullRequests),
		totalIssues: formatCount(data.totalIssues),
		totalClones: formatCount(data.totalClones),
		commitLines: formatCount(data.commitLines),
		contributions: renderColumn(contributions, 390, "My Contributions"),
	};
	return template.replace(/{{(\w+)}}/g, (_, key: string) => {
		if (!Object.hasOwn(values, key)) throw new Error(`Unknown SVG placeholder: ${key}`);
		return String(values[key]);
	});
}
