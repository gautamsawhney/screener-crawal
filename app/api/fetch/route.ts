import axios from "axios";
import * as cheerio from "cheerio";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SCREEN_URL = "https://www.screener.in/screens/3193493/nse-top-stocks/";
const PAGE_LIMIT = 100; // safety guard
const FETCH_DELAY_MS = 800; // small delay to avoid rate limits
const RETRIES_PER_PAGE = 3;
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const ATH_THRESHOLD = 0.7; // within 30% of all-time high

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
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}.NS`;
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
  const ath = closes.reduce((max, val) => (val > max ? val : max), closes[0]);

  const last200 = closes.slice(-200);
  if (last200.length < 50) {
    throw new Error("Insufficient history");
  }
  const sma200 =
    last200.reduce((sum, val) => sum + val, 0) / last200.length;

  const passes =
    currentPrice > sma200 && currentPrice >= ath * ATH_THRESHOLD;

  return { symbol, currentPrice, sma200, ath, passes };
};

const applyFilters = async (symbols: string[]) => {
  const filtered: string[] = [];

  for (const symbol of symbols) {
    try {
      const result = await fetchMetrics(symbol);
      if (result.passes) {
        filtered.push(symbol);
      }
      await sleep(250);
    } catch (err) {
      // Skip symbols with missing data or errors.
      continue;
    }
  }

  return filtered;
};

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const withFilters = searchParams.get("filters") === "true";

    const symbols = new Set<string>();
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= PAGE_LIMIT) {
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

    let filteredFormatted: string[] | undefined;
    let filteredBatches: string[] | undefined;

    if (withFilters) {
      const passingRaw = await applyFilters(rawSymbols);
      filteredFormatted = passingRaw.map((s) => `NSE:${s}`);
      filteredBatches = splitIntoBatches(filteredFormatted);
    }

    return NextResponse.json({
      source: SCREEN_URL,
      total: formatted.length,
      batches,
      filtered: filteredFormatted
        ? {
            total: filteredFormatted.length,
            batches: filteredBatches
          }
        : undefined
    });
  } catch (error) {
    console.error("Failed to fetch symbols", error);
    return NextResponse.json(
      {
        error:
          "Unable to fetch symbols right now. Screener may be rate limiting; please retry in a moment."
      },
      { status: 500 }
    );
  }
}
