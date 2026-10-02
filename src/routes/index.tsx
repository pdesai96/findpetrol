import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Fuel, Loader2, MapPin, Navigation, Search, TrendingDown } from "lucide-react";

import { getFuelPrices, type FuelStation } from "../lib/fuel.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PumpWatch — Cheapest Petrol Near You" },
      {
        name: "description",
        content:
          "Find the cheapest petrol prices near you. Search by UK town or use your current location to compare live fuel prices.",
      },
      { property: "og:title", content: "PumpWatch — Cheapest Petrol Near You" },
      {
        property: "og:description",
        content:
          "Find the cheapest petrol prices near you. Search by UK town or use your current location to compare live fuel prices.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Result =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; stations: FuelStation[]; placeLabel: string | null };

function Index() {
  const [town, setTown] = useState("");
  const [result, setResult] = useState<Result>({ status: "idle" });

  async function search(input: { town?: string; lat?: number; lng?: number }) {
    setResult({ status: "loading" });
    try {
      const res = await getFuelPrices({ data: input });
      if ("error" in res && res.error) {
        setResult({ status: "error", message: res.error });
      } else if ("stations" in res && res.stations) {
        setResult({ status: "done", stations: res.stations, placeLabel: res.placeLabel ?? null });
      } else {
        setResult({ status: "error", message: "Something went wrong. Please try again." });
      }
    } catch {
      setResult({ status: "error", message: "Something went wrong. Please try again." });
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setResult({ status: "error", message: "Your browser doesn't support location access." });
      return;
    }
    setResult({ status: "loading" });
    navigator.geolocation.getCurrentPosition(
      (pos) => search({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () =>
        setResult({
          status: "error",
          message: "Couldn't get your location. Check browser permissions, or search by town instead.",
        }),
      { timeout: 10000 },
    );
  }

  const cheapest =
    result.status === "done" && result.stations.length > 0 ? result.stations[0]!.price : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-12 sm:pt-20">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary">
            <Fuel className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">PumpWatch</h1>
        </div>
        <p className="mt-3 text-muted-foreground">
          Live unleaded (E10) prices from UK forecourts. Find the cheapest fill-up near you.
        </p>

        {/* Search */}
        <form
          className="mt-8 flex flex-col gap-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (town.trim()) search({ town: town.trim() });
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={town}
              onChange={(e) => setTown(e.target.value)}
              placeholder="Enter a town or city, e.g. Leeds"
              className="h-12 w-full rounded-xl border border-input bg-card pl-10 pr-4 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="submit"
            disabled={result.status === "loading" || !town.trim()}
            className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            Search
          </button>
        </form>

        <button
          onClick={useMyLocation}
          disabled={result.status === "loading"}
          className="mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Navigation className="h-4 w-4" />
          Use my current location
        </button>

        {/* Status */}
        {result.status === "loading" && (
          <div className="mt-10 flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Fetching live prices…</span>
          </div>
        )}

        {result.status === "error" && (
          <div className="mt-8 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {result.message}
          </div>
        )}

        {/* Results */}
        {result.status === "done" && (
          <div className="mt-10">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4 shrink-0" />
              <span className="truncate">
                {result.placeLabel ?? "Your current location"} — within 25 km
              </span>
            </div>

            {cheapest !== null && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3">
                <TrendingDown className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium text-foreground">
                  Cheapest: <span className="text-lg font-bold">{cheapest.toFixed(1)}p</span> per
                  litre
                </span>
              </div>
            )}

            <ul className="mt-4 space-y-3">
              {result.stations.map((s, i) => (
                <li
                  key={`${s.brand}-${s.postcode}-${i}`}
                  className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
                    i === 0
                      ? "border-primary/50 bg-primary/5"
                      : "border-border bg-card"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">{s.brand}</span>
                      {i === 0 && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                          Cheapest
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {s.address}
                      {s.postcode ? `, ${s.postcode}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {s.distanceKm < 1
                        ? `${Math.round(s.distanceKm * 1000)} m away`
                        : `${s.distanceKm.toFixed(1)} km away`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-2xl font-bold tabular-nums text-foreground">
                      {s.price.toFixed(1)}
                      <span className="text-sm font-medium text-muted-foreground">p/L</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-12 text-center text-xs text-muted-foreground">
          Prices from retailer open-data feeds (Asda, Morrisons, JET, Esso, Applegreen), updated
          throughout the day.
        </p>
      </div>
    </div>
  );
}
