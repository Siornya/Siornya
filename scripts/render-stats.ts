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

const LANGUAGE_COLORS: Record<string, string> = {
	"C++": "#c97f9f",
	Vue: "#9baa8d",
	TypeScript: "#a59bc7",
	Python: "#c5a56f",
	C: "#b38da9",
	Java: "#c49a84",
	"C#": "#8faf9e",
	JavaScript: "#d3b879",
	Others: "#cec1ca",
};

function renderColumn({ rows, total }: RowsData, colX: number, title: string): string {
	let out = `
		<text x="${colX}" y="56" class="section-title">${escapeXml(title)}</text>
		<text x="${colX}" y="82" class="small">Language mix</text>
		<rect x="${colX}" y="102" width="316" height="8" rx="4" fill="#eadfe5"/>
		<g clip-path="url(#mixClip)">`;
	let position = colX;
	for (const [name, size] of rows) {
		const width = size / total * 316;
		const color = LANGUAGE_COLORS[name] ?? "#b593ad";
		out += `<rect x="${position.toFixed(2)}" y="102" width="${width.toFixed(2)}" height="8" fill="${color}"/>`;
		position += width;
	}
	out += "</g>";
	rows.forEach(([name, size], index) => {
		const percent = (size / total * 100).toFixed(1);
		const width = (size / total * 140).toFixed(2);
		const y = 146 + index * 32;
		const color = LANGUAGE_COLORS[name] ?? "#b593ad";
		out += `
			<circle cx="${colX + 3}" cy="${y - 4}" r="3" fill="${color}"/>
			<text x="${colX + 15}" y="${y}" class="lang">${escapeXml(name)}</text>
			<rect x="${colX + 130}" y="${y - 9}" width="140" height="7" rx="3.5" fill="#eadfe5"/>
			<rect x="${colX + 130}" y="${y - 9}" width="${width}" height="7" rx="3.5" fill="${color}"/>
			<text x="${colX + 316}" y="${y}" text-anchor="end" class="percent">${percent}%</text>`;
	});
	return out;
}

const formatCount = (value: number | null): string => value === null ? "—" : value.toLocaleString("en-US");

export function renderStats(data: StatsCardData): string {
	const contributions = buildRows(data.contribLangs);
	const cardWidth = 760;
	const cardHeight = 352;
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
	for (const key of ["totalContributions", "totalStars", "totalPullRequests", "totalIssues", "totalClones", "commitLines"]) {
		const text = String(values[key]);
		const width = [...text].reduce((sum, character) => sum + (character === "," ? 0.32 : 0.65), 0);
		values[`${key}Size`] = Math.min(18, 118 / width).toFixed(1);
	}
	return template.replace(/{{(\w+)}}/g, (_, key: string) => {
		if (!Object.hasOwn(values, key)) throw new Error(`Unknown SVG placeholder: ${key}`);
		return String(values[key]);
	});
}
