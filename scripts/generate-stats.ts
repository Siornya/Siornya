import fs from "node:fs";
import path from "node:path";
import { graphql } from "@octokit/graphql";
import { getContributionStats } from "./contributions.ts";
import type { ApiPage, NumberMap } from "./contributions.ts";
import { getPrContributionStats } from "./pr-contributions.ts";
import { renderStats } from "./render-stats.ts";

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
const ORG_LOGIN = "LONETRAIL-Lab";
const COUNT_MODE = "churn" as const;
const DATA_DIR = process.env.STATS_DATA_DIR || path.resolve("..", "Siornya-profile-data");
const STAR_FILE = path.join(DATA_DIR,"star-cache.json");
const CLONE_FILE = path.join(DATA_DIR,"clone-cache.json");
const GH_API = "https://api.github.com";
const gql = graphql.defaults({ headers: { authorization: `token ${token}` } });
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface Repo { nameWithOwner: string; isFork: boolean; stargazerCount: number; owner: {login:string} }
interface StarCache { total:number; lastCount:number }
interface CloneCache { trackingStartedAt: string | null; total:number; lastCountedDate:string | null }
interface CloneTraffic { clones: Array<{timestamp:string;count:number}> }
let rateLimited = false;

async function ghRestPage<T>(apiPath:string):Promise<ApiPage<T> | null> {
  if (rateLimited) return null;
  const res = await fetch(`${GH_API}${apiPath}`, {
    headers:{authorization:`token ${token}`, accept:"application/vnd.github+json", "user-agent":"siornya-stats"}
  });
  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
  if (res.status === 429 || (res.status === 403 && (remaining === 0 || res.headers.has("retry-after")))) {
    rateLimited = true;
    console.warn("GitHub REST API rate limited");
    return null;
  }
  if (!res.ok) {
    if (res.status === 409 && /\/(branches|commits)\?/.test(apiPath)) return { data: [] as T, next:null };
    if (res.status === 404) return null;
    throw new Error(`GitHub API: ${res.status} ${res.statusText} for ${apiPath}`);
  }
  if (remaining > 0 && remaining < 40) rateLimited = true;
  const nextUrl = res.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1];
  let next: string | null = null;
  if (nextUrl) {
    const url = new URL(nextUrl);
    if (url.origin !== GH_API) throw new Error("Unexpected pagination origin");
    next = url.pathname + url.search;
  }
  return {data:await res.json() as T,next};
}
async function ghRest<T>(url:string):Promise<T|null> { return (await ghRestPage<T>(url))?.data ?? null; }
function save(filename:string, value:unknown) {
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  fs.writeFileSync(filename,JSON.stringify(value,null,2));
}
function nextUtcDate(date:string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}

const {viewer} = await gql<{viewer:{login:string;createdAt:string}}>(`query {viewer {login createdAt}}`);
const login = viewer.login;
const createdYear = new Date(viewer.createdAt).getUTCFullYear();
const nowYear = new Date().getUTCFullYear();

// Stars, Clones and own original repositories: OWNER only, never enumerate other people's private forks.
async function getOwnedRepositories():Promise<Repo[]> {
  const query = `query($cursor:String,$privacy:RepositoryPrivacy!) {
    viewer { repositories(first:100,after:$cursor,affiliations:[OWNER],privacy:$privacy) {
      nodes {nameWithOwner isFork stargazerCount owner {login}}
      pageInfo {hasNextPage endCursor}
    }}
  }`;
  const result:Repo[] = [];
  for (const privacy of ["PUBLIC","PRIVATE"] as const) {
    let cursor:string|null = null;
    do {
      const r: {viewer:{repositories:{nodes:Array<Repo|null>;pageInfo:PageInfo}}} = await gql(query,{cursor,privacy});
      const p = r.viewer.repositories;
      for (const repo of p.nodes) if (repo && repo.owner.login.toLowerCase() === login.toLowerCase() && !repo.isFork) result.push(repo);
      cursor = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null;
    } while (cursor);
  }
  return [...new Map(result.map(x=>[x.nameWithOwner,x])).values()];
}

// Only the explicitly selected organization. Its forks are excluded to keep the contribution rule consistent.
async function getOrganizationRepositories():Promise<string[]> {
  const q = `query($cursor:String,$login:String!) {
    organization(login:$login) { repositories(first:100,after:$cursor,isFork:false) {
      nodes {nameWithOwner}
      pageInfo {hasNextPage endCursor}
    }}
  }`;
  const result:string[]=[];
  let cursor:string|null=null;
  do {
    const r:{organization:null|{repositories:{nodes:Array<{nameWithOwner:string}|null>;pageInfo:PageInfo}}} = await gql(q,{cursor,login:ORG_LOGIN});
    if (!r.organization) throw new Error(`Organization ${ORG_LOGIN} is not accessible`);
    for(const node of r.organization.repositories.nodes) if(node) result.push(node.nameWithOwner);
    const p=r.organization.repositories.pageInfo;
    cursor=p.hasNextPage?p.endCursor:null;
  }while(cursor);
  return result;
}

const owned=await getOwnedRepositories();
const orgRepos=await getOrganizationRepositories();
console.log(`Scanning ${owned.length} owned original repos and ${orgRepos.length} selected organization repos`);

// Maintain original cumulative Stars behavior.
const currentStars=owned.reduce((sum,r)=>sum+r.stargazerCount,0);
let starCache:StarCache={total:0,lastCount:0};
try {
  const c=JSON.parse(fs.readFileSync(STAR_FILE,"utf8")) as StarCache;
  if(!Number.isSafeInteger(c.total)||c.total<0||!Number.isSafeInteger(c.lastCount)||c.lastCount<0) throw new Error("Invalid Stars cache");
  starCache=c;
}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
starCache.total+=Math.max(0,currentStars-starCache.lastCount);
starCache.lastCount=currentStars;
save(STAR_FILE,starCache);

// Maintain original date-deduplicated Clones behavior.
let cloneCache:CloneCache={trackingStartedAt:null,total:0,lastCountedDate:null};
try {
  const c=JSON.parse(fs.readFileSync(CLONE_FILE,"utf8")) as CloneCache;
  if(typeof c.total==="number")cloneCache=c;
}catch{}
cloneCache.trackingStartedAt??=new Date().toISOString().slice(0,10);
const daily:NumberMap={};
let cloneComplete=true;
for(const r of owned){
  if(rateLimited){cloneComplete=false;break;}
  const traffic=await ghRest<CloneTraffic>(`/repos/${r.nameWithOwner}/traffic/clones?per=day`);
  if(!traffic?.clones){cloneComplete=false;continue;}
  for(const row of traffic.clones){const date=row.timestamp.slice(0,10);daily[date]=(daily[date]??0)+row.count;}
}
if(cloneComplete){
  const today=new Date().toISOString().slice(0,10);
  const dates=Object.keys(daily).filter(d=>d<today).sort();
  if(dates.length){
    const fresh=dates.filter(d=>!cloneCache.lastCountedDate||d>cloneCache.lastCountedDate);
    if(cloneCache.lastCountedDate&&fresh.length&&dates[0]!>nextUtcDate(cloneCache.lastCountedDate)) console.warn("Clone history has a gap");
    for(const d of fresh)cloneCache.total+=daily[d]??0;
    const last=dates.at(-1)!;
    if(!cloneCache.lastCountedDate||last>cloneCache.lastCountedDate)cloneCache.lastCountedDate=last;
  }
}else console.warn("Incomplete clone scan: keeping old total");
save(CLONE_FILE,cloneCache);

// GitHub account-wide contribution counts; no repository discovery is performed here.
const contribQuery=`query($from:DateTime!,$to:DateTime!) {
  viewer { contributionsCollection(from:$from,to:$to) {
    contributionCalendar {totalContributions}
    totalPullRequestContributions
    totalIssueContributions
  }}
}`;
let totalContributions=0,totalPullRequests=0,totalIssues=0;
for(let year=createdYear;year<=nowYear;year++){
  const from=new Date(Date.UTC(year,0,1)).toISOString();
  const to=new Date(Date.UTC(year,11,31,23,59,59)).toISOString();
  const r:{viewer:{contributionsCollection:{contributionCalendar:{totalContributions:number};totalPullRequestContributions:number;totalIssueContributions:number}}}=await gql(contribQuery,{from,to});
  const c=r.viewer.contributionsCollection;
  totalContributions+=c.contributionCalendar.totalContributions;
  totalPullRequests+=c.totalPullRequestContributions;
  totalIssues+=c.totalIssueContributions;
}

// The two sources are disjoint by owner: Commit scans own original + selected org;
// PR scan skips these owners and only counts accepted contributions elsewhere.
const repoNames = new Set([...owned.map(r=>r.nameWithOwner),...orgRepos]);
const commitLangs=await getContributionStats(repoNames,login,DATA_DIR,ghRestPage,()=>rateLimited,COUNT_MODE);
const prLangs=await getPrContributionStats(login,viewer.createdAt,DATA_DIR,ghRestPage,
  new Set([login.toLowerCase(),ORG_LOGIN.toLowerCase()]),()=>rateLimited,COUNT_MODE);
if(commitLangs!==null&&prLangs!==null){
  const langs=new Map(commitLangs);
  for(const [language,count] of prLangs)langs.set(language,(langs.get(language)??0)+count);
  const commitLines=[...langs.values()].reduce((s,n)=>s+n,0);
  const svg=renderStats({totalContributions,totalStars:starCache.total,totalPullRequests,totalIssues,totalClones:cloneCache.total,commitLines,contribLangs:langs});
  fs.mkdirSync("assets",{recursive:true});
  fs.writeFileSync("assets/github-stats.svg",svg);
  console.log("Statistics generated",{commitLines,owned:owned.length,orgRepos:orgRepos.length});
}else console.warn("Contribution baseline incomplete: SVG left unchanged");
