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

  const closes: number[] = result.indicators.quote[0].close.filter(
    (c: number | null | undefined) => typeof c === "number"
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

  return { symbol, currentPrice, sma200, ath, passes, dailyChangePct };
};

type SectorInfo = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  category: string | null;
  name: string | null;
  dailyChangePct: number | null;
};

const filterBySector = (sectorInfos: SectorInfo[]): SectorInfo[] => {
  return sectorInfos.filter(info => {
    if (!info.industry) return false;
    return ALLOWED_INDUSTRIES.includes(info.industry as typeof ALLOWED_INDUSTRIES[number]);
  });
};

const fetchSectorFromScreener = async (symbol: string, dailyChangePct: number | null): Promise<SectorInfo> => {
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

    return {
      symbol,
      sector,
      industry,
      category: industry ? getCategoryFromIndustry(industry) : (sector ? getCategoryFromIndustry(sector) : null),
      name,
      dailyChangePct,
    };
  } catch {
    return {
      symbol,
      sector: null,
      industry: null,
      category: null,
      name: null,
      dailyChangePct,
    };
  }
};

const applyFiltersWithSectorInfo = async (
  symbols: string[],
  onProgress?: (msg: string, current: number, total: number) => void
): Promise<{ filtered: string[]; allSectorInfo: SectorInfo[]; sectorFiltered: SectorInfo[] }> => {
  const filtered: string[] = [];
  const dailyChangeBySymbol = new Map<string, number | null>();
  const total = symbols.length;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    try {
      const result = await fetchMetrics(symbol);
      if (result.passes) {
        filtered.push(symbol);
        dailyChangeBySymbol.set(symbol, result.dailyChangePct);
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

    const sectorInfo = await fetchSectorFromScreener(symbol, dailyChangeBySymbol.get(symbol) ?? null);
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
