'use strict';

const express = require('express');
const Parser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL = 60 * 60 * 1000; // 60 minutes

// RSS parser — browser UA required for Cloudflare-protected feeds (e.g. Oxford Academic)
const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
  customFields: {
    item: [
      ['dc:creator', 'dcCreator'],
      ['author', 'author'],
    ],
  },
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Household Finance keyword detection ──────────────────────────────────────

const HF_KEYWORDS = [
  'household', 'households', 'retail investor', 'retail investors',
  'individual investor', 'individual investors', 'personal finance', 'consumer finance',
  'household debt', 'household wealth', 'household savings', 'household portfolio',
  'household income', 'household consumption', 'household balance sheet',
  'stock market participation', 'stock ownership', 'portfolio choice', 'portfolio allocation',
  'wealth inequality', 'wealth distribution', 'wealth accumulation', 'financial literacy',
  'financial advice', 'robo-advisor', 'investment behavior', 'investor behavior',
  'mortgage', 'mortgages', 'student loan', 'student debt', 'credit card',
  'consumer credit', 'consumer debt', 'household borrowing', 'household leverage',
  'refinancing', 'foreclosure', 'payday loan', 'auto loan',
  // 'default' / 'delinquency' alone are too generic (sovereign default, youth
  // delinquency) — only count them in a household-debt context.
  'loan default', 'mortgage default', 'debt default', 'borrower default',
  'consumer default', 'household default', 'credit card default', 'payment default',
  'loan delinquency', 'mortgage delinquency', 'debt delinquency', 'payment delinquency',
  'consumer delinquency', 'household delinquency', 'credit card delinquency',
  'retirement saving', 'retirement savings', 'retirement wealth', 'pension', '401(k)', 'defined contribution',
  'annuity', 'social security', 'life insurance', 'consumption smoothing',
  'consumption inequality', 'buffer stock', 'precautionary savings', 'income risk',
  'income shocks', 'income uncertainty', 'earnings risk', 'financial fragility',
  'hand-to-mouth', 'liquid assets', 'illiquid assets', 'financial inclusion',
  'unbanked', 'underbanked', 'fintech', 'mental accounting', 'limited attention',
  'inattention', 'nudge', 'default option', 'borrowing constraints', 'credit constraints',
  'housing wealth', 'homeownership', 'home equity',
];

function isHouseholdFinance(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  return HF_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Source definitions ────────────────────────────────────────────────────────

// RSS sources: only feeds confirmed working with browser UA headers
const RSS_SOURCES = [
  {
    key: 'econometrica',
    journal: 'Econometrica',
    journalFull: 'Econometrica',
    abs: '4*',
    category: 'economics',
    type: 'issue',
    rss: 'https://onlinelibrary.wiley.com/feed/14680262/most-recent',
  },
  {
    key: 'qje',
    journal: 'QJE',
    journalFull: 'Quarterly Journal of Economics',
    abs: '4*',
    category: 'economics',
    type: 'advance',
    rss: 'https://academic.oup.com/rss/site_5504/advanceAccess_3365.xml',
  },
  {
    key: 'jpe',
    journal: 'JPE',
    journalFull: 'Journal of Political Economy',
    abs: '4*',
    category: 'economics',
    type: 'issue',
    rss: 'https://www.journals.uchicago.edu/action/showFeed?type=etoc&feed=rss&jc=jpe',
  },
  {
    key: 'jf',
    journal: 'JF',
    journalFull: 'Journal of Finance',
    abs: '4*',
    category: 'finance',
    type: 'issue',
    rss: 'https://onlinelibrary.wiley.com/feed/15406261/most-recent',
  },
  {
    key: 'jfe',
    journal: 'JFE',
    journalFull: 'Journal of Financial Economics',
    abs: '4*',
    category: 'finance',
    type: 'issue',
    rss: 'https://rss.sciencedirect.com/publication/science/0304405X',
  },
  {
    key: 'jpubec',
    journal: 'JPubEc',
    journalFull: 'Journal of Public Economics',
    abs: '4',
    category: 'economics',
    type: 'issue',
    rss: 'https://rss.sciencedirect.com/publication/science/00472727',
  },
];

// CrossRef sources: journals whose RSS feeds are dead or JS-blocked
// CrossRef Polite Pool: include mailto in User-Agent for better rate limits
const CROSSREF_UA = 'EconFinanceTracker/1.0 (mailto:research@tracker.local)';
const CROSSREF_ROWS = 50;
const NBER_ROWS = 500;

const CROSSREF_JOURNAL_SOURCES = [
  {
    key: 'aer',
    journal: 'AER',
    journalFull: 'American Economic Review',
    abs: '4*',
    category: 'economics',
    type: 'issue',
    issn: '0002-8282',
  },
  {
    key: 'restud',
    journal: 'REStud',
    journalFull: 'Review of Economic Studies',
    abs: '4*',
    category: 'economics',
    type: 'advance',
    issn: '0034-6527',
  },
  {
    key: 'rfs',
    journal: 'RFS',
    journalFull: 'Review of Financial Studies',
    abs: '4*',
    category: 'finance',
    type: 'advance',
    issn: '0893-9454',
  },
  {
    key: 'econj',
    journal: 'Econ Journal',
    journalFull: 'Economic Journal',
    abs: '4',
    category: 'economics',
    type: 'advance',
    issn: '0013-0133',
  },
  {
    key: 'aejapp',
    journal: 'AEJ:Applied',
    journalFull: 'American Economic Journal: Applied Economics',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '1945-7782',
  },
  {
    key: 'restat',
    journal: 'ReStat',
    journalFull: 'Review of Economics and Statistics',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '0034-6535',
  },
  {
    key: 'jfqa',
    journal: 'JFQA',
    journalFull: 'Journal of Financial and Quantitative Analysis',
    abs: '4',
    category: 'finance',
    type: 'issue',
    issn: '0022-1090',
  },
  {
    key: 'jel',
    journal: 'JEL',
    journalFull: 'Journal of Economic Literature',
    abs: '4*',
    category: 'economics',
    type: 'issue',
    issn: '0022-0515',
  },
  {
    key: 'jep',
    journal: 'JEP',
    journalFull: 'Journal of Economic Perspectives',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '0895-3309',
  },
  {
    key: 'aejpol',
    journal: 'AEJ:Policy',
    journalFull: 'American Economic Journal: Economic Policy',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '1945-774X',
  },
  {
    key: 'aejmacro',
    journal: 'AEJ:Macro',
    journalFull: 'American Economic Journal: Macroeconomics',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '1945-7707',
  },
  {
    key: 'aejmicro',
    journal: 'AEJ:Micro',
    journalFull: 'American Economic Journal: Microeconomics',
    abs: '4',
    category: 'economics',
    type: 'issue',
    issn: '1945-7669',
  },
];

// NBER: RSS dead (redirects to 404). Use CrossRef DOI prefix 10.3386.
const NBER_CROSSREF = {
  key: 'nber',
  journal: 'NBER',
  journalFull: 'NBER Working Papers',
  abs: null,
  category: 'nber',
  type: 'working-paper',
  prefix: '10.3386',
};

const ARXIV_SOURCE = {
  key: 'arxiv',
  journal: 'arXiv',
  journalFull: 'arXiv Economics',
  abs: null,
  category: 'arxiv',
  type: 'working-paper',
};

const ARXIV_ROWS = 200;

// ── Cache ─────────────────────────────────────────────────────────────────────

let cache = {
  papers: null,
  papersTimestamp: null,
  workingPapers: null,
  workingPapersTimestamp: null,
};

const sourceErrors = {};

// Per-source stale cache: stores last successful result so a transient failure
// (e.g. CrossRef 429) never shows an error — we silently serve stale data.
const staleSourceCache = {};

function isCacheValid(timestamp) {
  return timestamp !== null && Date.now() - timestamp < CACHE_TTL;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function formatDate(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Elsevier's ScienceDirect RSS feeds (JFE, JPubEc) carry no <pubDate>/<dc:date>
// at all -- the issue date only shows up as plain text in the description,
// e.g. "Publication date: October 2026". Without this every item from those
// two feeds gets date: null, which silently drops them from date filters,
// sorting, and the This Week tab. Built as an explicit Y-M-01 string (not a
// Date round-trip) to avoid local-timezone rollover on "Month Year" parsing.
function extractElsevierDate(text) {
  if (!text) return null;
  // Advance/in-press articles carry a full date: "Available online 31 July 2026"
  const online = /Available online\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text);
  if (online) {
    const month = MONTH_NAMES[online[2].toLowerCase()];
    if (month) return `${online[3]}-${String(month).padStart(2, '0')}-${online[1].padStart(2, '0')}`;
  }
  // Issue-assigned articles only carry "Publication date: October 2026"
  const issue = /Publication date:\s*([A-Za-z]+)\s+(\d{4})/.exec(text);
  if (issue) {
    const month = MONTH_NAMES[issue[1].toLowerCase()];
    if (month) return `${issue[2]}-${String(month).padStart(2, '0')}-01`;
  }
  return null;
}

function extractAuthors(item) {
  return (
    item.dcCreator ||
    item['dc:creator'] ||
    item.creator ||
    item.author ||
    ''
  );
}

// Strip outer curly/straight quotes that arXiv RSS wraps titles in
function cleanTitle(raw) {
  return (raw || '').trim().replace(/^[\u2018\u2019'"]+|[\u2018\u2019'"]+$/g, '').trim();
}

// Journal issue feeds (both RSS and CrossRef) include boilerplate entries
// alongside real articles -- front/back matter, editorial boards, issue index
// pages. These aren't papers; filter them out. Corrigenda/errata are kept
// since they reference real content.
const NON_ARTICLE_TITLE = /^(front|back)\s*matter\b|^issue information\b|^editorial board\b|^table of contents\b|^cover image\b|^volume information\b|^submission of manuscripts\b|^announcements?\b|^author index\b|^subject index\b|^in this issue\b/i;
function isNonArticle(title) {
  return NON_ARTICLE_TITLE.test((title || '').trim());
}

// Extract plain-text abstract from RSS item description/content fields
function extractAbstract(item) {
  // Prefer full-content fields; avoid contentSnippet which rss-parser truncates to ~200 chars
  const raw = item['content:encoded'] || item.content || item.summary || item.description || item.contentSnippet || '';
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000) || null;
}

// Strip JATS XML tags from CrossRef abstracts
function stripJATS(text) {
  if (!text) return null;
  return text
    .replace(/<\/?jats:[^>]*>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200) || null;
}

async function fetchRSS(src) {
  try {
    const feed = await rssParser.parseURL(src.rss);
    delete sourceErrors[src.key];
    const results = feed.items
      .filter(item => !isNonArticle(cleanTitle(item.title)))
      .map(item => ({
        title: cleanTitle(item.title),
        url: item.link || '',
        journal: src.journal,
        journalFull: src.journalFull,
        abs: src.abs,
        category: src.category,
        authors: extractAuthors(item),
        date: formatDate(item.pubDate || item.isoDate) || extractElsevierDate(item.content),
        type: src.type,
        abstract: extractAbstract(item),
        subCategory: src.key === 'arxiv'
          ? ((item.categories || []).find(c => /^econ\.[A-Z]{2}$/.test(c)) || null)
          : null,
        householdFinance: isHouseholdFinance(cleanTitle(item.title)),
      }));
    staleSourceCache[src.key] = results;
    return results;
  } catch (err) {
    console.error(`[${src.key}] RSS error: ${err.message}`);
    if (staleSourceCache[src.key]) {
      console.warn(`[${src.key}] Serving stale cache due to RSS failure`);
      return staleSourceCache[src.key];
    }
    sourceErrors[src.key] = err.message;
    return [];
  }
}

// CrossRef: format author list from API response
function formatCrossRefAuthors(authors) {
  if (!authors || authors.length === 0) return '';
  return authors
    .slice(0, 6)
    .map(a => [a.given, a.family].filter(Boolean).join(' '))
    .join(', ');
}

// CrossRef: convert date-parts array [[YYYY, M, D]] to ISO string
function formatCrossRefDate(dateParts) {
  if (!dateParts || !dateParts[0] || !dateParts[0][0]) return null;
  const [year, month = 1, day = 1] = dateParts[0];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Fetch a journal via CrossRef API (by ISSN)
// Retries up to 3 times on 429, with exponential backoff.
// Falls back to stale data on persistent failure — no error surfaced to UI.
async function fetchCrossRefJournal(src) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const url = `https://api.crossref.org/journals/${src.issn}/works?rows=${CROSSREF_ROWS}&sort=published&order=desc&select=title,author,URL,published,abstract`;
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': CROSSREF_UA },
        timeout: 20000,
      });
      const items = data.message.items || [];
      delete sourceErrors[src.key];
      console.log(`[${src.key}] CrossRef: fetched ${items.length} papers`);
      const results = items
        .filter(item => item.title && item.title[0] && item.URL)
        .filter(item => !isNonArticle(item.title[0]))
        .map(item => ({
          title: item.title[0].trim(),
          url: item.URL,
          journal: src.journal,
          journalFull: src.journalFull,
          abs: src.abs,
          category: src.category,
          authors: formatCrossRefAuthors(item.author),
          date: formatCrossRefDate(item.published && item.published['date-parts']),
          type: src.type,
          abstract: stripJATS(item.abstract),
          subCategory: null,
          householdFinance: isHouseholdFinance(item.title[0]),
        }));
      staleSourceCache[src.key] = results;
      return results;
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429 && attempt < maxRetries - 1) {
        const wait = (attempt + 1) * 3000; // 3s, 6s backoff
        console.warn(`[${src.key}] CrossRef 429 rate-limited. Retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries - 1})...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`[${src.key}] CrossRef error: ${err.message}`);
      // Use stale data silently if available — avoids surfacing UI errors for transient failures
      if (staleSourceCache[src.key]) {
        console.warn(`[${src.key}] Serving stale cache due to fetch failure`);
        return staleSourceCache[src.key];
      }
      sourceErrors[src.key] = err.message;
      return [];
    }
  }
  return [];
}

// NBER links to a paper's abstract/landing page rather than straight to the PDF.
// NBER gates PDF downloads for recent papers (free accounts get 3/year; older
// papers become ungated after the embargo period) — a direct PDF link 403s once
// that quota is used. The landing page always loads and still shows the abstract,
// with NBER's own registration/access options if the PDF itself is gated.
function nberLandingUrl(doi, fallbackUrl) {
  const m = /^10\.3386\/(w\d+)$/.exec(doi || '');
  return m ? `https://www.nber.org/papers/${m[1]}` : fallbackUrl;
}

// Fetch NBER working papers via CrossRef DOI prefix 10.3386
// Same retry + stale-fallback pattern as fetchCrossRefJournal.
async function fetchNBER() {
  const src = NBER_CROSSREF;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // sort=created (not deposited): NBER periodically re-deposits metadata for
      // old papers, which bumps decades-old papers to the top of a deposited-desc
      // sort and mislabels them as brand new. `created` (DOI first-registered date)
      // is set once and never touched again, so it doesn't get disturbed by that —
      // and unlike `published`, it carries day-level granularity, not just month.
      const url = `https://api.crossref.org/prefixes/${src.prefix}/works?rows=${NBER_ROWS}&sort=created&order=desc&select=title,author,URL,DOI,published,deposited,created,abstract`;
      const { data } = await axios.get(url, {
        headers: { 'User-Agent': CROSSREF_UA },
        timeout: 20000,
      });
      const items = data.message.items || [];
      delete sourceErrors[src.key];
      console.log(`[nber] CrossRef: fetched ${items.length} papers`);
      const results = items
        .filter(item => item.title && item.title[0] && item.URL)
        .map(item => ({
          title: item.title[0].trim(),
          url: nberLandingUrl(item.DOI, item.URL),
          journal: src.journal,
          journalFull: src.journalFull,
          abs: src.abs,
          category: src.category,
          authors: formatCrossRefAuthors(item.author),
          date: formatCrossRefDate((item.created && item.created['date-parts']) || (item.published && item.published['date-parts']) || (item.deposited && item.deposited['date-parts'])),
          type: src.type,
          abstract: stripJATS(item.abstract),
          subCategory: null,
          householdFinance: isHouseholdFinance(item.title[0]),
        }));
      staleSourceCache[src.key] = results;
      return results;
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429 && attempt < maxRetries - 1) {
        const wait = (attempt + 1) * 3000;
        console.warn(`[nber] CrossRef 429. Retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`[nber] CrossRef error: ${err.message}`);
      if (staleSourceCache[src.key]) {
        console.warn(`[nber] Serving stale cache due to fetch failure`);
        return staleSourceCache[src.key];
      }
      sourceErrors[src.key] = err.message;
      return [];
    }
  }
  return [];
}

// Fetch arXiv econ papers via arXiv API (Atom XML), replacing the RSS feed.
async function fetchArxiv() {
  const src = ARXIV_SOURCE;
  try {
    const url = `https://export.arxiv.org/api/query?search_query=cat:econ.*&max_results=${ARXIV_ROWS}&sortBy=submittedDate&sortOrder=descending`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': CROSSREF_UA },
      timeout: 30000,
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const results = [];
    $('entry').each((_, el) => {
      const title = cleanTitle($(el).find('title').first().text());
      const id    = $(el).find('id').first().text().trim().replace('http://', 'https://');
      const published = $(el).find('published').first().text().trim();
      const abstract  = $(el).find('summary').first().text().replace(/\s+/g, ' ').trim().slice(0, 3000);
      const authors   = $(el).find('author name').map((_, a) => $(a).text()).get().slice(0, 6).join(', ');
      const cats      = $(el).find('category').map((_, c) => $(c).attr('term')).get();
      const subCategory = cats.find(c => /^econ\.[A-Z]{2}$/.test(c)) || null;
      results.push({
        title,
        url: id,
        journal: src.journal,
        journalFull: src.journalFull,
        abs: src.abs,
        category: src.category,
        authors,
        date: formatDate(published),
        type: src.type,
        abstract,
        subCategory,
        householdFinance: isHouseholdFinance(title),
      });
    });
    staleSourceCache[src.key] = results;
    delete sourceErrors[src.key];
    console.log(`[arxiv] API: fetched ${results.length} papers`);
    return results;
  } catch (err) {
    console.error(`[arxiv] API error: ${err.message}`);
    if (staleSourceCache[src.key]) {
      console.warn(`[arxiv] Serving stale cache due to API failure`);
      return staleSourceCache[src.key];
    }
    sourceErrors[src.key] = err.message;
    return [];
  }
}

// ── Aggregate fetchers ────────────────────────────────────────────────────────

async function fetchAllPapers() {
  // RSS feeds: fire in parallel (separate domains, no rate-limit concern)
  const rssResults = await Promise.all(RSS_SOURCES.map(fetchRSS));

  // CrossRef: stagger requests 500ms apart to stay within polite-pool rate limits
  const crossrefResults = [];
  for (const src of CROSSREF_JOURNAL_SOURCES) {
    if (crossrefResults.length > 0) {
      await new Promise(r => setTimeout(r, 500));
    }
    crossrefResults.push(await fetchCrossRefJournal(src));
  }

  return [...rssResults.flat(), ...crossrefResults.flat()];
}

async function fetchAllWorkingPapers() {
  const results = await Promise.all([
    fetchNBER(),
    fetchArxiv(),
  ]);
  return results.flat();
}

// ── API routes ────────────────────────────────────────────────────────────────

// Each endpoint only reports errors relevant to its own sources,
// so a NBER fetch failure never leaks into the published-papers error list.
const PUBLISHED_KEYS = new Set(
  ['aer', 'econometrica', 'qje', 'restud', 'jpe', 'econj', 'jf', 'jfe', 'rfs', 'jpubec', 'aejapp', 'jfqa', 'restat', 'jel', 'jep', 'aejpol', 'aejmacro', 'aejmicro']
);
const WORKING_KEYS = new Set(['nber', 'arxiv']);

function pickErrors(keys) {
  return Object.fromEntries(
    Object.entries(sourceErrors).filter(([k, v]) => keys.has(k) && v)
  );
}

app.get('/api/papers', async (req, res) => {
  try {
    if (!isCacheValid(cache.papersTimestamp)) {
      cache.papers = await fetchAllPapers();
      cache.papersTimestamp = Date.now();
    }
    res.json({
      papers: cache.papers,
      lastUpdated: new Date(cache.papersTimestamp).toISOString(),
      errors: pickErrors(PUBLISHED_KEYS),
    });
  } catch (err) {
    console.error('/api/papers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/working-papers', async (req, res) => {
  try {
    if (!isCacheValid(cache.workingPapersTimestamp)) {
      cache.workingPapers = await fetchAllWorkingPapers();
      cache.workingPapersTimestamp = Date.now();
    }
    res.json({
      papers: cache.workingPapers,
      lastUpdated: new Date(cache.workingPapersTimestamp).toISOString(),
      errors: pickErrors(WORKING_KEYS),
    });
  } catch (err) {
    console.error('/api/working-papers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Refreshes the shared cache. Used by the server's own hourly timer and by the
// manual "Refresh" button — never by per-client polling (see REFRESH_COOLDOWN_MS).
async function refreshCache() {
  const [papers, workingPapers] = await Promise.all([
    fetchAllPapers(),
    fetchAllWorkingPapers(),
  ]);
  cache.papers = papers;
  cache.papersTimestamp = Date.now();
  cache.workingPapers = workingPapers;
  cache.workingPapersTimestamp = Date.now();
  return { papers, workingPapers };
}

// Floor on how often /api/refresh may hit upstream, regardless of caller —
// protects CrossRef/Wiley/Elsevier from being hammered if the endpoint is
// called repeatedly (it's unauthenticated and publicly reachable).
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
let lastManualRefresh = 0;

app.get('/api/refresh', async (req, res) => {
  const sinceLast = Date.now() - lastManualRefresh;
  if (sinceLast < REFRESH_COOLDOWN_MS) {
    return res.status(429).json({
      error: 'Refreshed too recently',
      retryAfterMs: REFRESH_COOLDOWN_MS - sinceLast,
    });
  }
  lastManualRefresh = Date.now();
  Object.keys(sourceErrors).forEach(k => delete sourceErrors[k]);

  try {
    const { papers, workingPapers } = await refreshCache();
    res.json({
      success: true,
      papersCount: papers.length,
      workingPapersCount: workingPapers.length,
      lastUpdated: new Date().toISOString(),
      errors: { ...sourceErrors },
    });
  } catch (err) {
    console.error('/api/refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }
  console.log(`EconFinance Tracker running at:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}  ← 其他设备用这个地址`);
});

// Server-side refresh timer: keeps the cache warm on its own schedule so clients
// never need to trigger a fetch themselves. Without this, each open browser tab
// used to call /api/refresh every hour independently — with several tabs open
// that meant redundant full re-fetches across ~18 journal sources hitting
// CrossRef/Wiley/Elsevier concurrently.
setInterval(() => {
  refreshCache().catch(err => console.error('Scheduled refresh failed:', err.message));
}, CACHE_TTL);
