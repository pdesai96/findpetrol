import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Fuel, Loader2, MapPin, Navigation, RefreshCw, Search, TrendingDown } from "lucide-react";

import { getFuelPrices, type FuelStation } from "../lib/fuel.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "findpetrol — Cheapest Petrol Near You" },
      {
        name: "description",
        content:
          "Find the cheapest petrol prices near you. Search by UK town or use your current location to compare live fuel prices.",
      },
      { property: "og:title", content: "findpetrol — Cheapest Petrol Near You" },
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
  const [lastInput, setLastInput] = useState<{ town?: string; lat?: number; lng?: number } | null>(
    null,
  );
  const [openStation, setOpenStation] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [sortBy, setSortBy] = useState<"price" | "distance">("price");
  const [locating, setLocating] = useState(false);

  // Auto-search with current location if the user has already granted permission
  useEffect(() => {
    if (!navigator.geolocation || !navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((p) => {
        if (p.state === "granted") useMyLocation();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  async function search(
    input: { town?: string; lat?: number; lng?: number },
    fresh = false,
  ) {
    setLastInput(input);
    setOpenStation(null);
    // Keep current results visible while refreshing so the user sees the update
    if (fresh) setRefreshing(true);
    else setResult({ status: "loading" });
    try {
      const res = await getFuelPrices({ data: { ...input, fresh } });
      if ("error" in res && res.error) {
        setResult({ status: "error", message: res.error });
      } else if ("stations" in res && res.stations) {
        setResult({ status: "done", stations: res.stations, placeLabel: res.placeLabel ?? null });
        setUpdatedAt(new Date());
      } else {
        setResult({ status: "error", message: "Something went wrong. Please try again." });
      }
    } catch {
      setResult({ status: "error", message: "Something went wrong. Please try again." });
    } finally {
      setRefreshing(false);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setResult({ status: "error", message: "Your browser doesn't support location access." });
      return;
    }
    setResult({ status: "loading" });
    setLocating(true);
    setTown("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        search({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        setLocating(false);
        setResult({
          status: "error",
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location access is blocked. On iPhone: Settings → Privacy → Location Services → Safari Websites → While Using. Or search by town instead."
              : "Couldn't get your location. Try again, or search by town instead.",
        });
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 },
    );
  }

  const visible = useMemo(() => {
    if (result.status !== "done") return [];
    const maxKm = radiusMiles * 1.609344;
    return result.stations
      .filter((s) => s.distanceKm <= maxKm)
      .sort((a, b) =>
        sortBy === "price" ? a.price - b.price || a.distanceKm - b.distanceKm : a.distanceKm - b.distanceKm,
      )
      .slice(0, 25);
  }, [result, radiusMiles, sortBy]);
  const cheapestPrice = visible.length ? Math.min(...visible.map((s) => s.price)) : null;
  const nearestKm = visible.length ? Math.min(...visible.map((s) => s.distanceKm)) : null;
  const fmtMiles = (km: number) => {
    const mi = km / 1.609344;
    return mi < 0.1 ? "< 0.1 mi" : `${mi.toFixed(1)} mi`;
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-12 sm:pt-20">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary">
            <Fuel className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">findpetrol</h1>
        </div>

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
            <span>{locating ? "Finding your location…" : "Fetching live prices…"}</span>
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
                {result.placeLabel?.split(",").slice(0, 2).join(",") ?? "Your current location"}
              </span>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => lastInput && search(lastInput, true)}
                className="ml-auto inline-flex shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {updatedAt && (
              <p className="mt-1 text-xs text-muted-foreground">
                Prices updated at{" "}
                {updatedAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Within</span>
              {[1, 3, 5, 10, 25].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setRadiusMiles(m)}
                  className={`h-9 touch-manipulation rounded-full px-3 text-sm font-semibold transition-colors ${
                    radiusMiles === m
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-foreground hover:bg-accent"
                  }`}
                >
                  {m} mi
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Sort</span>
              {(["price", "distance"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSortBy(k)}
                  className={`h-9 touch-manipulation rounded-full px-3 text-sm font-semibold transition-colors ${
                    sortBy === k
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-foreground hover:bg-accent"
                  }`}
                >
                  {k === "price" ? "Cheapest" : "Nearest"}
                </button>
              ))}
            </div>

            {visible.length === 0 && (
              <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                No stations within {radiusMiles} mi.{" "}
                {radiusMiles < 25 && (
                  <button
                    type="button"
                    className="font-semibold text-primary underline"
                    onClick={() => setRadiusMiles([1, 3, 5, 10, 25].find((m) => m > radiusMiles)!)}
                  >
                    Widen search
                  </button>
                )}
              </div>
            )}

            {cheapestPrice !== null && (
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3">
                <TrendingDown className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium text-foreground">
                  Cheapest within {radiusMiles} mi:{" "}
                  <span className="text-lg font-bold">{cheapestPrice.toFixed(1)}p</span> per litre
                </span>
              </div>
            )}

            <ul className="mt-4 space-y-3">
              {visible.map((s, i) => {
                const key = `${s.brand}-${s.postcode}-${i}`;
                const isOpen = openStation === key;
                const isCheapest = s.price === cheapestPrice;
                const isNearest = s.distanceKm === nearestKm;
                return (
                  <li
                    key={key}
                    className={`overflow-hidden rounded-xl border ${
                      isCheapest ? "border-primary/50 bg-primary/5" : "border-border bg-card"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenStation(isOpen ? null : key)}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-foreground">{s.brand}</span>
                          {isCheapest && (
                            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">
                              Cheapest
                            </span>
                          )}
                          {isNearest && (
                            <span className="rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                              Nearest
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">
                          {s.address}
                          {s.postcode ? `, ${s.postcode}` : ""}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {fmtMiles(s.distanceKm)} away
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-2xl font-bold tabular-nums text-foreground">
                          {s.price.toFixed(1)}
                          <span className="text-sm font-medium text-muted-foreground">p/L</span>
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="flex gap-2 border-t border-border px-4 py-3">
                        <a
                          href={`https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d`}
                          target="_top"
                          aria-label={`Open ${s.brand} in Apple Maps`}
                          className="inline-flex h-11 flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                        >
                          <Navigation className="h-4 w-4" />
                          Apple Maps
                        </a>
                        <a
                          href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`}
                          target="_top"
                          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-border text-sm font-semibold text-foreground transition-colors hover:bg-accent"
                        >
                          <MapPin className="h-4 w-4" />
                          Google Maps
                        </a>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="mt-12 text-center text-xs text-muted-foreground">
          Prices from UK retailer open-data feeds (Asda, Tesco, Morrisons, Shell, Esso, JET,
          Applegreen, MFG, Rontec, Moto, SGN and more), updated throughout the day.
        </p>
      </div>
    </div>
  );
}
