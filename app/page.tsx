'use client';

import { useState } from "react";

type SectorStock = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  category: string | null;
  name: string | null;
};

type FetchResponse = {
  batches: string[];
  total: number;
  source: string;
  filtered?: {
    batches: string[];
    total: number;
    stocks?: SectorStock[];
  };
  sectorFiltered?: {
    total: number;
    stocks: SectorStock[];
    batches: string[];
  };
};

type Progress = {
  stage: string;
  message: string;
  current: number;
  total: number;
};

export default function HomePage() {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [applyFilters, setApplyFilters] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setCopiedIndex(null);
    setProgress(null);

    try {
      const url = applyFilters ? "/api/fetch?filters=true" : "/api/fetch";
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Request failed");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "progress") {
              setProgress(data as Progress);
            } else if (eventType === "result") {
              setData(data as FetchResponse);
            } else if (eventType === "error") {
              setError(data.message);
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      setError("Could not fetch stocks. Please try again.");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-5xl rounded-2xl bg-white p-8 shadow-xl">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              Screener NSE Stocks
            </h1>
            <p className="text-sm text-slate-600">
              Fetch symbols from Screener and get TradingView-ready strings.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                checked={applyFilters}
                onChange={(e) => setApplyFilters(e.target.checked)}
                disabled={loading}
              />
              <span>Above 200DMA &amp; within 30% of ATH</span>
            </label>
            <button
              onClick={handleFetch}
              disabled={loading}
              className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? "Fetching..." : "Fetch Stocks"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && progress && (
          <div className="mt-6 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-indigo-900">
                {progress.stage === "screener" && "Fetching from Screener"}
                {progress.stage === "filter" && "Applying Filters"}
                {progress.stage === "sector" && "Fetching Sector Info"}
                {progress.stage === "complete" && "Complete"}
              </span>
              {progress.total > 0 && (
                <span className="text-xs text-indigo-600">
                  {progress.current} / {progress.total}
                </span>
              )}
            </div>
            <p className="text-sm text-indigo-700 mb-2">{progress.message}</p>
            {progress.total > 0 && (
              <div className="w-full bg-indigo-200 rounded-full h-2">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {data && (
          <div className="mt-8 space-y-6">
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
              <span className="font-semibold">
                Total: {data.total.toLocaleString()}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
                Source: {data.source}
              </span>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {data.batches.map((batch, index) => (
                <div key={index} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-slate-800">
                        Batch {index + 1}
                      </span>
                      <span className="text-xs text-slate-500">
                        {batch.split(",").length} symbols
                      </span>
                    </div>
                    <button
                      onClick={async () => {
                        await navigator.clipboard.writeText(batch);
                        setCopiedIndex(index);
                        setTimeout(() => setCopiedIndex(null), 1500);
                      }}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                    >
                      {copiedIndex === index ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={batch}
                    className="min-h-[140px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>

            {data.filtered && (
              <div className="mt-8 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold text-slate-900">
                      Step 1: Filtered Stocks (200DMA &amp; ATH)
                    </span>
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
                      {data.filtered.total} stocks
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      const allSymbols = data.filtered!.batches.join(",");
                      await navigator.clipboard.writeText(allSymbols);
                      setCopiedIndex(1999);
                      setTimeout(() => setCopiedIndex(null), 1500);
                    }}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    {copiedIndex === 1999 ? "Copied All" : "Copy All Symbols"}
                  </button>
                </div>

                {data.filtered.stocks && data.filtered.stocks.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200">
                      <thead className="bg-slate-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                            Symbol
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                            Name
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                            Sector
                          </th>
                          <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                            Industry
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {data.filtered.stocks.map((stock, index) => (
                          <tr key={index} className="hover:bg-slate-50">
                            <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-indigo-600">
                              {stock.symbol}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-700">
                              {stock.name || "-"}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-500">
                              {stock.sector || "-"}
                            </td>
                            <td className="px-4 py-3 text-sm text-slate-500">
                              {stock.industry || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="grid gap-6 md:grid-cols-2">
                  {data.filtered.batches.map((batch, index) => (
                    <div key={index} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-medium text-slate-800">
                            Filtered Batch {index + 1}
                          </span>
                          <span className="text-xs text-slate-500">
                            {batch.split(",").length} symbols
                          </span>
                        </div>
                        <button
                          onClick={async () => {
                            await navigator.clipboard.writeText(batch);
                            setCopiedIndex(index + 1000);
                            setTimeout(() => setCopiedIndex(null), 1500);
                          }}
                          className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                        >
                          {copiedIndex === index + 1000 ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <textarea
                        readOnly
                        value={batch}
                        className="min-h-[140px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.sectorFiltered && data.sectorFiltered.stocks.length > 0 && (
              <div className="mt-8 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold text-slate-900">
                      Step 2: Sector Filtered Stocks
                    </span>
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
                      {data.sectorFiltered.total} stocks
                    </span>
                  </div>
                  <button
                    onClick={async () => {
                      const allSymbols = data.sectorFiltered!.stocks
                        .map((s) => `NSE:${s.symbol}`)
                        .join(",");
                      await navigator.clipboard.writeText(allSymbols);
                      setCopiedIndex(2000);
                      setTimeout(() => setCopiedIndex(null), 1500);
                    }}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    {copiedIndex === 2000 ? "Copied All" : "Copy All Symbols"}
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Filtered by: Metals, Defense, PSU Banks, Auto, Capital Markets
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                          Symbol
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                          Name
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                          Category
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-600">
                          Industry
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {data.sectorFiltered.stocks.map((stock, index) => (
                        <tr key={index} className="hover:bg-slate-50">
                          <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-indigo-600">
                            {stock.symbol}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-700">
                            {stock.name || "-"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                              stock.category === "Metals" ? "bg-zinc-100 text-zinc-700" :
                              stock.category === "Defense" ? "bg-red-100 text-red-700" :
                              stock.category === "PSU Banks" ? "bg-blue-100 text-blue-700" :
                              stock.category === "Auto" ? "bg-green-100 text-green-700" :
                              stock.category === "Capital Markets" ? "bg-purple-100 text-purple-700" :
                              "bg-slate-100 text-slate-700"
                            }`}>
                              {stock.category || "-"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-500">
                            {stock.industry || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.sectorFiltered.batches.length > 0 && (
                  <div className="mt-4 grid gap-6 md:grid-cols-2">
                    {data.sectorFiltered.batches.map((batch, index) => (
                      <div key={index} className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-medium text-slate-800">
                              Sector Batch {index + 1}
                            </span>
                            <span className="text-xs text-slate-500">
                              {batch.split(",").length} symbols
                            </span>
                          </div>
                          <button
                            onClick={async () => {
                              await navigator.clipboard.writeText(batch);
                              setCopiedIndex(index + 3000);
                              setTimeout(() => setCopiedIndex(null), 1500);
                            }}
                            className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                          >
                            {copiedIndex === index + 3000 ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <textarea
                          readOnly
                          value={batch}
                          className="min-h-[100px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
