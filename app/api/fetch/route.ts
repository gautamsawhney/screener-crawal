import axios from "axios";
import * as cheerio from "cheerio";
import { ALLOWED_INDUSTRIES, getCategoryFromIndustry } from "../../config/sectors";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for long operations

const SCREEN_URL = "https://www.screener.in/screens/3193493/nse-top-stocks/";
const SCREENER_COMPANY_BASE = "https://www.screener.in/company";
const PAGE_LIMIT = 100; // safety guard
const FETCH_DELAY_MS = 800; // small delay to avoid rate limits
const RETRIES_PER_PAGE = 3;
const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const ATH_THRESHOLD = 0.5; // within 50% of all-time high
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NEWS_SEARCH_BASE = "https://news.google.com/rss/search";
const DUCKDUCKGO_SEARCH_BASE = "https://duckduckgo.com/html/";
const ADVERSE_NEWS_KEYWORDS = [
  "market manipulation",
  "insider trading",
  "front running",
  "price rigging",
  "pump and dump",
  "fraud",
];

const normalizeSymbol = (raw: string | undefined | null) => {
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase();
  return cleaned || null;
};

const extractFromHref = (href: string | undefined | null) => {
  if (!href) return null;
  const cleaned = href.trim();
  const segments = cleaned.split("/").filter(Boolean);
  const companyIndex = segments.indexOf("company");
  if (companyIndex !== -1 && segments.length > companyIndex + 1) {
    return normalizeSymbol(segments[companyIndex + 1]);
  }
  return null;
};

const splitIntoBatches = (symbols: string[], batchSize = 30) => {
  const batches: string[] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize).join(","));
  }
  return batches;
};

const parsePage = (html: string) => {
  const $ = cheerio.load(html);
  const symbols = new Set<string>();

  $("table tbody tr").each((_i, row) => {
    const link = $(row).find("a").first();
    const hrefSymbol = extractFromHref(link.attr("href"));

    if (hrefSymbol) {
      symbols.add(hrefSymbol);
      return;
    }

    const firstCellText = $(row).find("td").first().text();
    const directSymbol = normalizeSymbol(firstCellText);
    if (directSymbol) {
      symbols.add(directSymbol);
    }
  });

  const hasNext =
    $('a[rel="next"]').length > 0 ||
    $('li.next a').length > 0 ||
    $('a').filter((_i, el) => $(el).text().trim().startsWith("Next")).length > 0;

  return { symbols: Array.from(symbols), hasNext };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
};

const stdDev = (values: number[]) => {
  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
};

type WarningSignal = {
  id: string;
  category: "structure" | "news" | "regulatory";
  reason: string;
  details: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
};

type StructurePoint = {
  retPct: number;
  volume: number | null;
};

const formatCompactNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }
  return value.toFixed(0);
};

const buildStructurePoints = (
  closeRaw: Array<number | null | undefined>,
  volumeRaw: Array<number | null | undefined>
) => {
  const points: StructurePoint[] = [];

  for (let i = 1; i < closeRaw.length; i++) {
    const previousClose = closeRaw[i - 1];
    const close = closeRaw[i];

    if (typeof previousClose !== "number" || typeof close !== "number" || previousClose === 0) {
      continue;
    }

    const retPct = ((close - previousClose) / previousClose) * 100;
    const rawVolume = volumeRaw[i];
    const volume: number | null = typeof rawVolume === "number" ? rawVolume : null;
    points.push({ retPct, volume });
  }

  return points;
};

const getMarketStructureWarnings = (
  closes: number[],
  closeRaw: Array<number | null | undefined>,
  volumeRaw: Array<number | null | undefined>
) => {
  const warnings: WarningSignal[] = [];

  const structurePoints = buildStructurePoints(closeRaw, volumeRaw);
  const oneYearPoints = structurePoints.slice(-252);
  const oneYearCloses = closes.slice(-260);

  // Signal 1: cluster of extreme daily moves.
  const extremeMoveDays = oneYearPoints.filter((point) => Math.abs(point.retPct) >= 18).length;
  if (extremeMoveDays >= 3) {
    warnings.push({
      id: "structure-extreme-moves",
      category: "structure",
      reason: "Cluster of extreme daily moves",
      details: `Detected ${extremeMoveDays} sessions with absolute daily move >=18% in the last 1 year.`,
      sourceUrl: null,
      sourceLabel: null,
    });
  }

  // Signal 2: large return days with abnormal volume bursts.
  const oneYearVolumes = oneYearPoints
    .map((point) => point.volume)
    .filter((volume): volume is number => typeof volume === "number" && volume > 0);
  const volumeMedian = median(oneYearVolumes);

  if (volumeMedian && volumeMedian > 0) {
    const abnormalBurstDays = oneYearPoints.filter((point) => {
      return (
        typeof point.volume === "number" &&
        point.volume >= volumeMedian * 6 &&
        Math.abs(point.retPct) >= 10
      );
    }).length;

    if (abnormalBurstDays >= 2) {
      warnings.push({
        id: "structure-volume-burst",
        category: "structure",
        reason: "Abnormal volume-price burst pattern",
        details: `Found ${abnormalBurstDays} sessions with >=10% move and >=6x median volume (median volume ${formatCompactNumber(volumeMedian)}).`,
        sourceUrl: null,
        sourceLabel: null,
      });
    }
  }

  // Signal 3: pump then dump geometry inside a short window.
  let pumpDumpDetected = false;
  let maxPumpPct = 0;
  let maxDumpPct = 0;
  for (let i = 0; i + 24 < oneYearCloses.length; i++) {
    const startPrice = oneYearCloses[i];
    const pumpPeak = oneYearCloses[i + 10];
    if (startPrice <= 0 || pumpPeak <= 0) {
      continue;
    }

    const pumpPct = ((pumpPeak - startPrice) / startPrice) * 100;
    if (pumpPct > maxPumpPct) {
      maxPumpPct = pumpPct;
    }
    if (pumpPct < 80) {
      continue;
    }

    const postPumpWindow = oneYearCloses.slice(i + 11, i + 25);
    const postPumpMin = Math.min(...postPumpWindow);
    const dumpPct = ((pumpPeak - postPumpMin) / pumpPeak) * 100;
    if (dumpPct > maxDumpPct) {
      maxDumpPct = dumpPct;
    }

    if (dumpPct >= 35) {
      pumpDumpDetected = true;
      break;
    }
  }

  if (pumpDumpDetected) {
    warnings.push({
      id: "structure-pump-dump",
      category: "structure",
      reason: "Pump-then-dump price geometry",
      details: `Observed rapid rise (peak pump ~${maxPumpPct.toFixed(1)}%) followed by sharp drawdown (up to ${maxDumpPct.toFixed(1)}%) in short windows.`,
      sourceUrl: null,
      sourceLabel: null,
    });
  }

  // Signal 4: sharp spike followed by fast reversal.
  let spikeReversalEvents = 0;
  for (let i = 1; i + 5 < oneYearCloses.length; i++) {
    const previousClose = oneYearCloses[i - 1];
    const spikeClose = oneYearCloses[i];
    const futureClose = oneYearCloses[i + 5];

    if (previousClose <= 0 || spikeClose <= 0 || futureClose <= 0) {
      continue;
    }

    const spikePct = ((spikeClose - previousClose) / previousClose) * 100;
    const reversalPct = ((spikeClose - futureClose) / spikeClose) * 100;
    if (spikePct >= 22 && reversalPct >= 18) {
      spikeReversalEvents += 1;
    }
  }

  if (spikeReversalEvents >= 1) {
    warnings.push({
      id: "structure-spike-reversal",
      category: "structure",
      reason: "Spike-and-reversal behavior",
      details: `${spikeReversalEvents} events where a sharp up-spike was followed by a steep reversal within 5 sessions.`,
      sourceUrl: null,
      sourceLabel: null,
    });
  }

  // Signal 5: volatility regime shock vs earlier baseline.
  const oneYearReturns = oneYearPoints.map((point) => point.retPct);
  if (oneYearReturns.length >= 170) {
    const recentVol = stdDev(oneYearReturns.slice(-30));
    const baselineVol = stdDev(oneYearReturns.slice(-150, -30));

    if (baselineVol > 0 && recentVol >= baselineVol * 2.2 && recentVol >= 7) {
      warnings.push({
        id: "structure-vol-regime-shift",
        category: "structure",
        reason: "Volatility regime shift",
        details: `Recent 30-session volatility (${recentVol.toFixed(2)}%) is significantly above baseline (${baselineVol.toFixed(2)}%).`,
        sourceUrl: null,
        sourceLabel: null,
      });
    }
  }

  return warnings;
};

const fetchPageHtml = async (page: number) => {
  const url = page === 1 ? SCREEN_URL : `${SCREEN_URL}?page=${page}`;
  let attempt = 0;

  while (attempt < RETRIES_PER_PAGE) {
    try {
      const response = await axios.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          Referer: SCREEN_URL
        },
        validateStatus: (status) => status >= 200 && status < 300
      });
      return response.data as string;
    } catch (err: unknown) {
      const isRateLimited =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        // @ts-expect-error axios typing shape
        err.response?.status === 429;

      attempt += 1;
      if (isRateLimited && attempt < RETRIES_PER_PAGE) {
        await sleep(FETCH_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Failed to fetch page after retries");
};

const fetchMetrics = async (symbol: string) => {
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}.NS`;
  const params = {
    range: "3y",
    interval: "1d"
  };

  const response = await axios.get(url, {
    params,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json"
    }
  });

  const result = response.data?.chart?.result?.[0];
  if (!result?.indicators?.quote?.[0]?.close) {
    throw new Error("No price data");
  }

  const closeRaw: Array<number | null | undefined> = result.indicators.quote[0].close ?? [];
  const volumeRaw: Array<number | null | undefined> = result.indicators.quote[0].volume ?? [];
  const closes: number[] = closeRaw.filter(
    (c: number | null | undefined): c is number => typeof c === "number"
  );

  if (!closes.length) {
    throw new Error("Empty prices");
  }

  const currentPrice = closes[closes.length - 1];
  const previousClose = closes.length > 1 ? closes[closes.length - 2] : null;
  const ath = closes.reduce((max, val) => (val > max ? val : max), closes[0]);

  const last200 = closes.slice(-200);
  if (last200.length < 50) {
    throw new Error("Insufficient history");
  }
  const sma200 =
    last200.reduce((sum, val) => sum + val, 0) / last200.length;

  const passes =
    currentPrice > sma200 && currentPrice >= ath * ATH_THRESHOLD;

  const dailyChangePct =
    previousClose && previousClose !== 0
      ? ((currentPrice - previousClose) / previousClose) * 100
      : null;

  const structureWarnings = getMarketStructureWarnings(closes, closeRaw, volumeRaw);

  return { symbol, currentPrice, sma200, ath, passes, dailyChangePct, structureWarnings };
};

type SectorInfo = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  category: string | null;
  name: string | null;
  dailyChangePct: number | null;
  hasRiskWarning: boolean;
  warningReasons: string[];
  warningSignals: WarningSignal[];
};

type SearchResult = {
  title: string;
  snippet: string;
  url: string;
};

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasBoundedTokenMatch = (haystack: string, token: string) => {
  if (!token) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(token.toLowerCase())}([^a-z0-9]|$)`);
  return pattern.test(haystack);
};

const decodeDuckDuckGoUrl = (href: string | undefined) => {
  if (!href) return "";
  if (!href.startsWith("/l/?")) return href;

  try {
    const params = new URLSearchParams(href.slice(4));
    const encoded = params.get("uddg");
    return encoded ? decodeURIComponent(encoded) : href;
  } catch {
    return href;
  }
};

const hasCompanyReference = (haystack: string, symbol: string, name: string | null) => {
  const normalized = normalizeText(haystack);
  if (symbol.length >= 3 && hasBoundedTokenMatch(normalized, symbol.toLowerCase())) {
    return true;
  }
  if (!name) {
    return false;
  }

  if (normalized.includes(name.toLowerCase())) {
    return true;
  }

  const compactName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compactName.length < 4) {
    return false;
  }

  const compactText = normalized.replace(/[^a-z0-9]/g, "");
  return compactText.includes(compactName);
};

const fetchDuckDuckGoResults = async (query: string): Promise<SearchResult[]> => {
  try {
    const response = await axios.get(DUCKDUCKGO_SEARCH_BASE, {
      params: { q: query, kl: "in-en" },
      timeout: 7000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const $ = cheerio.load(response.data);
    const results: SearchResult[] = [];

    $(".result").each((_index, el) => {
      const anchor = $(el).find("a.result__a").first();
      const title = anchor.text().trim();
      const snippet = $(el).find(".result__snippet").first().text().trim();
      const url = decodeDuckDuckGoUrl(anchor.attr("href"));

      if (title || snippet) {
        results.push({ title, snippet, url });
      }
    });

    return results;
  } catch {
    return [];
  }
};

const fetchAdverseNewsSignal = async (symbol: string, name: string | null) => {
  try {
    const identity = name ? `"${name}"` : symbol;
    const query = `${identity} ("market manipulation" OR "insider trading" OR "front running" OR "price rigging" OR "pump and dump" OR fraud)`;

    const response = await axios.get(NEWS_SEARCH_BASE, {
      params: {
        q: query,
        hl: "en-IN",
        gl: "IN",
        ceid: "IN:en",
      },
      timeout: 7000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      },
    });

    const $ = cheerio.load(response.data, { xmlMode: true });
    const cutoff = Date.now() - ONE_YEAR_MS;
    let matchedItem: { title: string; link: string; publishedText: string } | null = null;

    $("item").each((_idx, item) => {
      if (matchedItem) {
        return;
      }

      const title = $(item).find("title").first().text().trim();
      const description = $(item).find("description").first().text().trim();
      const link = $(item).find("link").first().text().trim();
      const publishedText = $(item).find("pubDate").first().text().trim();
      const publishedAt = Date.parse(publishedText);
      if (Number.isNaN(publishedAt) || publishedAt < cutoff) {
        return;
      }

      const text = normalizeText(`${title} ${description}`);
      const hasKeyword = ADVERSE_NEWS_KEYWORDS.some((keyword) => text.includes(keyword));
      if (!hasKeyword) {
        return;
      }

      if (!hasCompanyReference(text, symbol, name)) {
        return;
      }

      matchedItem = { title, link, publishedText };
    });

    const selectedItem = matchedItem as { title: string; link: string; publishedText: string } | null;
    if (selectedItem) {
      return {
        flagged: true,
        signal: {
          id: "news-adverse-coverage",
          category: "news" as const,
          reason: "Adverse news coverage in last 1 year",
          details: `${selectedItem.title} (${selectedItem.publishedText})`,
          sourceUrl: selectedItem.link || null,
          sourceLabel: "News article",
        }
      };
    }

    return { flagged: false as const };
  } catch {
    return { flagged: false as const };
  }
};

const fetchSebiAdjudicationSignal = async (symbol: string, name: string | null) => {
  const query = `site:sebi.gov.in ${name ?? symbol} "adjudication order"`;
  const results = await fetchDuckDuckGoResults(query);

  const match = results.find((result) => {
    const text = normalizeText(`${result.title} ${result.snippet} ${result.url}`);
    const hasAdjudicationMention =
      text.includes("adjudication") || text.includes("adjudicating officer");
    const hasOrderMention = text.includes("order");
    const isSebiSource = text.includes("sebi.gov.in");

    if (!(isSebiSource && hasAdjudicationMention && hasOrderMention)) {
      return false;
    }

    // Reduce false positives by requiring some company identifier in the matched text.
    return hasCompanyReference(text, symbol, name);
  });

  if (!match) {
    return { flagged: false as const };
  }

  return {
    flagged: true,
    signal: {
      id: "regulatory-sebi-adjudication",
      category: "regulatory" as const,
      reason: "SEBI adjudication order reference",
      details: match.title || symbol,
      sourceUrl: match.url || null,
      sourceLabel: "SEBI/Index source",
    }
  };
};

const fetchRiskSignals = async (
  symbol: string,
  name: string | null,
  structureWarnings: WarningSignal[] = []
) => {
  const signals: WarningSignal[] = [...structureWarnings];

  const adverseNewsSignal = await fetchAdverseNewsSignal(symbol, name);
  if (adverseNewsSignal.flagged) {
    signals.push(adverseNewsSignal.signal);
  }

  const sebiSignal = await fetchSebiAdjudicationSignal(symbol, name);
  if (sebiSignal.flagged) {
    signals.push(sebiSignal.signal);
  }

  const dedupedSignals = Array.from(
    new Map(signals.map((signal) => [`${signal.id}:${signal.details}:${signal.sourceUrl ?? ""}`, signal])).values()
  );
  const dedupedReasons = dedupedSignals.map((signal) => signal.reason);
  return {
    hasRiskWarning: dedupedReasons.length > 0,
    warningReasons: dedupedReasons,
    warningSignals: dedupedSignals,
  };
};

const filterBySector = (sectorInfos: SectorInfo[]): SectorInfo[] => {
  return sectorInfos.filter(info => {
    if (!info.industry) return false;
    return ALLOWED_INDUSTRIES.includes(info.industry as typeof ALLOWED_INDUSTRIES[number]);
  });
};

const fetchSectorFromScreener = async (
  symbol: string,
  dailyChangePct: number | null,
  structureWarnings: WarningSignal[] = []
): Promise<SectorInfo> => {
  try {
    const url = `${SCREENER_COMPANY_BASE}/${symbol}/`;
    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
        Referer: SCREEN_URL
      }
    });

    const $ = cheerio.load(response.data);

    // Get company name from title
    const name = $("h1").first().text().trim() || null;

    // Get sector and industry from the company info section
    const sector = $('a[title="Sector"]').text().trim() || null;
    const industry = $('a[title="Industry"]').text().trim() || null;
    const riskSignal = await fetchRiskSignals(symbol, name, structureWarnings);

    return {
      symbol,
      sector,
      industry,
      category: industry ? getCategoryFromIndustry(industry) : (sector ? getCategoryFromIndustry(sector) : null),
      name,
      dailyChangePct,
      hasRiskWarning: riskSignal.hasRiskWarning,
      warningReasons: riskSignal.warningReasons,
      warningSignals: riskSignal.warningSignals,
    };
  } catch {
    const riskSignal = await fetchRiskSignals(symbol, null, structureWarnings);

    return {
      symbol,
      sector: null,
      industry: null,
      category: null,
      name: null,
      dailyChangePct,
      hasRiskWarning: riskSignal.hasRiskWarning,
      warningReasons: riskSignal.warningReasons,
      warningSignals: riskSignal.warningSignals,
    };
  }
};

const applyFiltersWithSectorInfo = async (
  symbols: string[],
  onProgress?: (msg: string, current: number, total: number) => void
): Promise<{ filtered: string[]; allSectorInfo: SectorInfo[]; sectorFiltered: SectorInfo[] }> => {
  const filtered: string[] = [];
  const dailyChangeBySymbol = new Map<string, number | null>();
  const structureWarningsBySymbol = new Map<string, WarningSignal[]>();
  const total = symbols.length;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    try {
      const result = await fetchMetrics(symbol);
      if (result.passes) {
        filtered.push(symbol);
        dailyChangeBySymbol.set(symbol, result.dailyChangePct);
        structureWarningsBySymbol.set(symbol, result.structureWarnings);
        onProgress?.(`✓ ${symbol} passed`, i + 1, total);
      } else {
        onProgress?.(`✗ ${symbol} failed`, i + 1, total);
      }
      await sleep(250);
    } catch {
      onProgress?.(`⚠ ${symbol} skipped`, i + 1, total);
      continue;
    }
  }

  // Now fetch sector info from Screener.in
  onProgress?.(`Fetching sector info for ${filtered.length} stocks...`, 0, filtered.length);

  const sectorResults: SectorInfo[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const symbol = filtered[i];
    onProgress?.(`Fetching sector: ${symbol} (${i + 1}/${filtered.length})`, i + 1, filtered.length);

    const sectorInfo = await fetchSectorFromScreener(
      symbol,
      dailyChangeBySymbol.get(symbol) ?? null,
      structureWarningsBySymbol.get(symbol) ?? []
    );
    sectorResults.push(sectorInfo);

    await sleep(300); // Rate limit for Screener.in
  }

  const sectorFiltered = filterBySector(sectorResults);
  return { filtered, allSectorInfo: sectorResults, sectorFiltered };
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const withFilters = searchParams.get("filters") === "true";

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  // Process in background
  (async () => {
    try {
      await sendEvent("progress", { stage: "screener", message: "Fetching stocks from Screener...", current: 0, total: 0 });

      const symbols = new Set<string>();
      let page = 1;
      let hasNext = true;

      while (hasNext && page <= PAGE_LIMIT) {
        await sendEvent("progress", { stage: "screener", message: `Fetching page ${page}...`, current: page, total: 0 });

        const html = await fetchPageHtml(page);
        const { symbols: pageSymbols, hasNext: pageHasNext } = parsePage(html);
        pageSymbols.forEach((s) => symbols.add(s));

        hasNext = pageHasNext && pageSymbols.length > 0;
        page += 1;
        if (hasNext) {
          await sleep(FETCH_DELAY_MS);
        }
      }

      const rawSymbols = Array.from(symbols);
      const formatted = rawSymbols.map((symbol) => `NSE:${symbol}`);
      const batches = splitIntoBatches(formatted);

      await sendEvent("progress", { stage: "screener", message: `Found ${rawSymbols.length} symbols`, current: page - 1, total: page - 1 });

      let filteredFormatted: string[] | undefined;
      let filteredBatches: string[] | undefined;
      let allSectorInfo: SectorInfo[] | undefined;
      let sectorFiltered: SectorInfo[] | undefined;

      if (withFilters) {
        await sendEvent("progress", { stage: "filter", message: `Starting filter for ${rawSymbols.length} symbols...`, current: 0, total: rawSymbols.length });

        const result = await applyFiltersWithSectorInfo(rawSymbols, (msg, current, total) => {
          sendEvent("progress", { stage: "filter", message: msg, current, total });
        });

        filteredFormatted = result.filtered.map((s) => `NSE:${s}`);
        filteredBatches = splitIntoBatches(filteredFormatted);
        allSectorInfo = result.allSectorInfo;
        sectorFiltered = result.sectorFiltered;

        await sendEvent("progress", { stage: "complete", message: `Done! ${result.filtered.length} passed filters, ${sectorFiltered.length} in target sectors`, current: rawSymbols.length, total: rawSymbols.length });
      }

      await sendEvent("result", {
        source: SCREEN_URL,
        total: formatted.length,
        batches,
        filtered: filteredFormatted
          ? {
              total: filteredFormatted.length,
              batches: filteredBatches,
              stocks: allSectorInfo
            }
          : undefined,
        sectorFiltered: sectorFiltered
          ? {
              total: sectorFiltered.length,
              stocks: sectorFiltered,
              batches: splitIntoBatches(sectorFiltered.map(s => `NSE:${s.symbol}`))
            }
          : undefined
      });

    } catch (error) {
      console.error("Failed to fetch symbols", error);
      await sendEvent("error", { message: "Unable to fetch symbols right now. Screener may be rate limiting; please retry in a moment." });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
