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
  'refinancing', 'foreclosure', 'default', 'delinquency', 'payday loan', 'auto loan',
  'retirement savings', 'retirement wealth', 'pension', '401(k)', 'defined contribution',
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
const NBER_ROWS = 200;

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
  rss: 'https://rss.arxiv.org/rss/econ',
};

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
    const results = feed.items.map(item => ({
      title: cleanTitle(item.title),
      url: item.link || '',
      journal: src.journal,
      journalFull: src.journalFull,
      abs: src.abs,
      category: src.category,
      authors: extractAuthors(item),
      date: formatDate(item.pubDate || item.isoDate),
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
        .filter(item => !/^front matter$/i.test(item.title[0]))
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

// Fetch NBER working papers via CrossRef DOI prefix 10.3386
// Same retry + stale-fallback pattern as fetchCrossRefJournal.
async function fetchNBER() {
  const src = NBER_CROSSREF;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const url = `https://api.crossref.org/prefixes/${src.prefix}/works?rows=${NBER_ROWS}&sort=published&order=desc&select=title,author,URL,published,abstract`;
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
    fetchRSS(ARXIV_SOURCE),
  ]);
  return results.flat();
}

// ── API routes ────────────────────────────────────────────────────────────────

// Each endpoint only reports errors relevant to its own sources,
// so a NBER fetch failure never leaks into the published-papers error list.
const PUBLISHED_KEYS = new Set(
  ['aer', 'econometrica', 'qje', 'restud', 'jpe', 'econj', 'jf', 'jfe', 'rfs', 'jpubec', 'aejapp', 'jfqa', 'restat']
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

app.get('/api/refresh', async (req, res) => {
  // Clear cache and errors
  cache = { papers: null, papersTimestamp: null, workingPapers: null, workingPapersTimestamp: null };
  Object.keys(sourceErrors).forEach(k => delete sourceErrors[k]);

  try {
    const [papers, workingPapers] = await Promise.all([
      fetchAllPapers(),
      fetchAllWorkingPapers(),
    ]);
    cache.papers = papers;
    cache.papersTimestamp = Date.now();
    cache.workingPapers = workingPapers;
    cache.workingPapersTimestamp = Date.now();

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
