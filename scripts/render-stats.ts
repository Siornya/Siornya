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
const escapeXml = (value: unknown): string =>
	String(value).replace(/[<>&]/g, (character) => XML_ESCAPES[character]!);

interface RowsData { rows: Array<[string, number]>; total: number }

const LANGUAGE_COLORS: Record<string, string> = {
	"C++": "#b45f82", "C": "#d28aab", "C#": "#9b83bd",
	"Python": "#6f9fc2", "TypeScript": "#5d8db8", "JavaScript": "#d6ad55",
	"Vue": "#63a995", "HTML": "#d78369", "CSS": "#9b8ac4",
	"Markdown": "#8e8a9e", "JSON": "#c18a57", "YAML": "#b97d91",
	"Shell": "#8ca66a", "Java": "#bd785d", "Go": "#65aeb5",
	"Rust": "#a8795d", "Ruby": "#bd737b", "PHP": "#898bc1",
	"Swift": "#d88c62", "Kotlin": "#9277bf", "SQL": "#6d9aab",
	"TeX": "#7c9d86", "QML": "#9d9a62", "Others": "#d9c3ce",
};
const FALLBACK_COLORS = ["#b45f82", "#6f9fc2", "#63a995", "#d6ad55", "#9b83bd", "#d78369"];

function languageColor(name: string, index = 0): string {
	return LANGUAGE_COLORS[name] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
}

// Select the five largest languages and group the remainder as Others.
function buildRows(map: Map<string, number>): RowsData {
	const sorted = [...map.entries()]
		.filter(([, value]) => Number.isFinite(value) && value > 0)
		.sort((a, b) => b[1] - a[1]);
	const actualTotal = sorted.reduce((sum, [, value]) => sum + value, 0);
	const top = sorted.slice(0, 5);
	const othersValue = actualTotal - top.reduce((sum, [, value]) => sum + value, 0);
	const rows = [...top];
	if (othersValue > 0) rows.push(["Others", othersValue]);
	return { rows, total: actualTotal || 1 };
}

function renderLanguageMix({ rows, total }: RowsData): string {
	if (!rows.length) return "";
	let x = 390;
	const width = 316;
	const segments = rows.map(([name, value], index) => {
		const segmentWidth = (value / total) * width;
		const rect = `<rect x="${x}" y="102" width="${segmentWidth}" height="8" fill="${languageColor(name, index)}"/>`;
		x += segmentWidth;
		return rect;
	});
	return `<g clip-path="url(#mixClip)">${segments.join("")}</g>`;
}

function renderColumn({ rows, total }: RowsData, colX: number, title: string): string {
	let out = `\n\t\t<text x="${colX}" y="82" class="section-title">${title}</text>`;
	rows.forEach(([name, size], index) => {
		const percent = ((size / total) * 100).toFixed(1);
		const barWidth = (size / total) * 140;
		const y = 126 + index * 32;
		const color = languageColor(name, index);
		const isOthers = name === "Others";
		out += `
			<circle cx="${colX - 8}" cy="${y - 4}" r="3.5" fill="${color}"${isOthers ? ' opacity="0.7"' : ""}/>
			<text x="${colX}" y="${y}" class="lang"${isOthers ? ' opacity="0.7"' : ""}>${escapeXml(name)}</text>
			<rect x="${colX + 130}" y="${y - 14}" width="140" height="11" rx="5.5" fill="#eadfe5"/>
			<rect x="${colX + 130}" y="${y - 14}" width="${barWidth}" height="11" rx="5.5" fill="${color}"${isOthers ? ' opacity="0.75"' : ""}/>
			<text x="${colX + 280}" y="${y}" class="percent">${percent}%</text>`;
	});
	return out;
}

const formatCount = (value: number | null): string =>
	value === null ? "—" : value.toLocaleString("en-US");

function metricFontSize(value: string): number {
	if (value.length <= 5) return 18;
	if (value.length <= 7) return 16;
	if (value.length <= 9) return 14;
	return 12;
}

export function renderStats(data: StatsCardData): string {
	const contributions = buildRows(data.contribLangs);
	// The left metric panel ends at y=333; preserve bottom whitespace.
	const cardWidth = 760;
	const cardHeight = Math.max(352, 142 + contributions.rows.length * 32);
	const totalContributions = formatCount(data.totalContributions);
	const totalStars = formatCount(data.totalStars);
	const totalPullRequests = formatCount(data.totalPullRequests);
	const totalIssues = formatCount(data.totalIssues);
	const totalClones = formatCount(data.totalClones);
	const commitLines = formatCount(data.commitLines);

	const values: Record<string, string | number> = {
		cardWidth, cardHeight,
		glowX: cardWidth - 90, glowY: cardHeight - 60, dividerBottom: cardHeight - 44,
		totalContributions, totalContributionsSize: metricFontSize(totalContributions),
		totalStars, totalStarsSize: metricFontSize(totalStars),
		totalPullRequests, totalPullRequestsSize: metricFontSize(totalPullRequests),
		totalIssues, totalIssuesSize: metricFontSize(totalIssues),
		totalClones, totalClonesSize: metricFontSize(totalClones),
		commitLines, commitLinesSize: metricFontSize(commitLines),
		contributions: renderColumn(contributions, 390, "My Contributions"),
	};

	let svg = template.replace(/{{(\w+)}}/g, (_, key: string) => {
		if (!Object.hasOwn(values, key)) throw new Error(`Unknown SVG placeholder: ${key}`);
		return String(values[key]);
	});

	// The template already defines mixClip; draw the segmented language overview bar.
	svg = svg.replace("</svg>", `${renderLanguageMix(contributions)}</svg>`);
	if (/{{\w+}}/.test(svg)) throw new Error("Unresolved SVG template placeholder");
	if (!svg.includes('id="mixClip"')) throw new Error("SVG template is missing mixClip");
	return svg;
}
