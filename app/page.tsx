'use client';

import { useState } from "react";

type FetchResponse = {
  batches: string[];
  total: number;
  source: string;
  filtered?: {
    batches: string[];
    total: number;
  };
};

export default function HomePage() {
  const [data, setData] = useState<FetchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [applyFilters, setApplyFilters] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setCopiedIndex(null);
    try {
      const url = applyFilters ? "/api/fetch?filters=true" : "/api/fetch";
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error("Request failed");
      }
      const json = (await res.json()) as FetchResponse;
      setData(json);
    } catch (err) {
      console.error(err);
      setError("Could not fetch stocks. Please try again.");
    } finally {
      setLoading(false);
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
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
                  <span className="font-semibold">Filtered (200DMA &amp; ≤30% off ATH)</span>
                  <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs text-emerald-700">
                    {data.filtered.total} symbols
                  </span>
                </div>
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
                            setCopiedIndex(index + 1000); // avoid collision with main list
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
          </div>
        )}
      </div>
    </main>
  );
}
