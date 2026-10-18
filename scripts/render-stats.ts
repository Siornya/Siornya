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

const XML_ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" };
const escapeXml = (value: unknown): string => String(value).replace(/[<>&]/g, (character) => XML_ESCAPES[character]!);

interface RowsData { rows: Array<[string, number]>; total: number }

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

function renderColumn({ rows, total }: RowsData, colX: number, title: string): string {
	let out = `\n\t\t<text x="${colX}" y="82" class="text">${title}</text>`;
	rows.forEach(([name, size], i) => {
		const percent = ((size / total) * 100).toFixed(1);
		const barW = (size / total) * 140;
		const y = 126 + i * 32;
		const isOthers = name === "Others";
		const barFill = isOthers ? "#ffffff30" : "url(#barGradient)";
		out += `\n\t\t\t<text x="${colX}" y="${y}" class="lang"${isOthers ? ' opacity="0.7"' : ""}>${escapeXml(name)}</text>\n\t\t\t<rect x="${colX + 130}" y="${y - 14}" width="140" height="11" rx="5.5" fill="#ffffff18"/>\n\t\t\t<rect x="${colX + 130}" y="${y - 14}" width="${barW}" height="11" rx="5.5" fill="${barFill}"/>\n\t\t\t<text x="${colX + 280}" y="${y}" class="percent">${percent}%</text>`;
	});
	return out;
}

const formatCount = (value: number | null): string => value === null ? "—" : value.toLocaleString("en-US");

// Shrink long metric values so they fit in the template's fixed-width metric column.
function metricFontSize(value: string): number {
	if (value.length <= 5) return 18;
	if (value.length <= 7) return 16;
	if (value.length <= 9) return 14;
	return 12;
}

export function renderStats(data: StatsCardData): string {
	const contributions = buildRows(data.contribLangs);
	const cardWidth = 760;
	const cardHeight = Math.max(334, 142 + contributions.rows.length * 32);
	const totalContributions = formatCount(data.totalContributions);
	const totalStars = formatCount(data.totalStars);
	const totalPullRequests = formatCount(data.totalPullRequests);
	const totalIssues = formatCount(data.totalIssues);
	const totalClones = formatCount(data.totalClones);
	const commitLines = formatCount(data.commitLines);
	const values: Record<string, string | number> = {
		cardWidth, cardHeight, glowX: cardWidth - 90, glowY: cardHeight - 60, dividerBottom: cardHeight - 44,
		totalContributions, totalContributionsSize: metricFontSize(totalContributions),
		totalStars, totalStarsSize: metricFontSize(totalStars),
		totalPullRequests, totalPullRequestsSize: metricFontSize(totalPullRequests),
		totalIssues, totalIssuesSize: metricFontSize(totalIssues),
		totalClones, totalClonesSize: metricFontSize(totalClones),
		commitLines, commitLinesSize: metricFontSize(commitLines),
		contributions: renderColumn(contributions, 390, "My Contributions"),
	};
	return template.replace(/{{(\w+)}}/g, (_, key: string) => {
		if (!Object.hasOwn(values, key)) throw new Error(`Unknown SVG placeholder: ${key}`);
		return String(values[key]);
	});
}
