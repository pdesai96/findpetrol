import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Fuel, Loader2, MapPin, Moon, Navigation, RefreshCw, Search, Star, Sun, TrendingDown } from "lucide-react";

import { getFavouritePrices, getFuelPrices, warmPrices, type FuelStation } from "../lib/fuel.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "findfuel — Cheapest Fuel Near You" },
      {
        name: "description",
        content:
          "Find the cheapest fuel prices near you. Search by UK town or use your current location to compare live prices.",
      },
      { property: "og:title", content: "findfuel — Cheapest Fuel Near You" },
      {
        property: "og:description",
        content:
          "Find the cheapest fuel prices near you. Search by UK town or use your current location to compare live prices.",
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
  | {
      status: "done";
      stations: FuelStation[];
      placeLabel: string | null;
      missingRetailers: string[];
    };

const MAP_KINDS = ["apple", "google", "waze"] as const;
type MapKind = (typeof MAP_KINDS)[number];

const MAP_META: Record<MapKind, { label: string; short: string; primary: boolean }> = {
  apple: { label: "Apple Maps", short: "Apple Maps", primary: true },
  google: { label: "Google Maps", short: "Google", primary: false },
  waze: { label: "Waze", short: "Waze", primary: false },
};

function isAppleDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 0) ||
    navigator.platform === "MacIntel"
  );
}

// Each button carries the map app's own link plus the plain web version, which
// stays as the fallback for when the app isn't installed.
function stationMapLinks(s: FuelStation) {
  const q = encodeURIComponent(`${s.brand} ${s.address}`);
  return {
    apple: {
      app: `maps://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d&q=${q}`,
      web: `https://maps.apple.com/?daddr=${s.lat},${s.lng}&dirflg=d&q=${q}`,
    },
    google: {
      app: `comgooglemaps://?daddr=${s.lat},${s.lng}&directionsmode=driving&q=${q}`,
      web: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`,
    },
    waze: {
      app: `waze://?ll=${s.lat},${s.lng}&navigate=yes`,
      web: `https://www.waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`,
    },
  } satisfies Record<MapKind, { app: string; web: string }>;
}

// A plain https link only hands off to the app when the browser recognises it
// as a universal link, which it won't when the page sits inside a frame. So on
// Apple devices we call the app's own link directly and only open the website
// if nothing took over.
function openMapApp(
  e: MouseEvent<HTMLAnchorElement>,
  link: { app: string; web: string },
  kind: MapKind,
) {
  if (!isAppleDevice()) return; // elsewhere the web link already opens the app
  e.preventDefault();
  const go = (url: string) => {
    try {
      (window.top ?? window).location.href = url;
    } catch {
      window.location.href = url;
    }
  };
  // Apple Maps: Safari hands maps.apple.com straight to the Maps app on a direct tap.
  if (kind === "apple") {
    go(link.web);
    return;
  }
  // Google/Waze: open the app directly from the tap (Safari blocks hidden-frame launches).
  go(link.app);
  const start = Date.now();
  const timer = window.setTimeout(() => {
    if (!document.hidden && Date.now() - start < 3000) go(link.web);
  }, 2500);
  const cancel = () => {
    if (document.hidden) window.clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", cancel, { once: true });
  window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
}

// Favourites are saved on the device so they survive between visits. We keep a
// snapshot of the station (brand, address, price, position) so they can be
// shown even before a search has run.
const FAV_KEY = "findpetrol-favs";

function favId(s: FuelStation) {
  return `${s.brand}|${s.postcode ?? ""}|${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
}

function loadFavs(): FuelStation[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// The three map buttons shared by result cards and favourite cards.
function MapButtons({ station }: { station: FuelStation }) {
  return (
    <div className="flex gap-2 border-t border-border px-4 py-3">
      {MAP_KINDS.map((kind) => {
        const link = stationMapLinks(station)[kind];
        const meta = MAP_META[kind];
        return (
          <a
            key={kind}
            href={link.web}
            target="_top"
            onClick={(e) => openMapApp(e, link, kind)}
            aria-label={`Open ${station.brand} in ${meta.label}`}
            className={
              meta.primary
                ? "inline-flex h-11 flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                : "inline-flex h-11 flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg border border-border text-sm font-semibold text-foreground transition-colors hover:bg-accent"
            }
          >
            {kind === "google" ? (
              <MapPin className="h-4 w-4" />
            ) : (
              <Navigation className="h-4 w-4" />
            )}
            {meta.short}
          </a>
        );
      })}
    </div>
  );
}

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
  const [dark, setDark] = useState(false);
  const [favs, setFavs] = useState<FuelStation[]>([]);
  const [openFav, setOpenFav] = useState<string | null>(null);

  // Restore saved theme, or fall back to the device preference, on first paint
  useEffect(() => {
    const saved = localStorage.getItem("findpetrol-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved ? saved === "dark" : prefersDark;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    const loaded = loadFavs();
    setFavs(loaded);
    refreshFavPrices();
    // Keep favourite prices live while the page stays open
    const interval = setInterval(refreshFavPrices, 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Favourite prices are always live: look up the latest price for each saved
  // station and update both the list and the saved copy.
  async function refreshFavPrices() {
    try {
      const current = loadFavs();
      if (current.length === 0) return;
      const res = await getFavouritePrices({
        data: {
          stations: current.map(({ brand, postcode, lat, lng }) => ({
            brand,
            postcode: postcode ?? "",
            lat,
            lng,
          })),
        },
      });
      if (!("updates" in res) || !res.updates) return;
      setFavs((prev) => {
        const next = prev.map((f) => {
          const u = res.updates.find(
            (u) => Math.abs(u.lat - f.lat) < 1e-4 && Math.abs(u.lng - f.lng) < 1e-4,
          );
          return u ? { ...f, price: u.price } : f;
        });
        try {
          localStorage.setItem(FAV_KEY, JSON.stringify(next));
        } catch {}
        return next;
      });
    } catch {
      // keep showing the saved prices if the refresh fails
    }
  }

  function toggleFav(s: FuelStation) {
    setFavs((prev) => {
      const id = favId(s);
      const next = prev.some((f) => favId(f) === id)
        ? prev.filter((f) => favId(f) !== id)
        : [...prev, s];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  // Show the three cheapest saved stations
  const topFavs = useMemo(
    () => [...favs].sort((a, b) => a.price - b.price).slice(0, 3),
    [favs],
  );

  function toggleDark() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("findpetrol-theme", next ? "dark" : "light");
  }

  // Tapping the logo always takes you back to the start: no results, just your
  // favourites and the search box.
  function goHome() {
    setResult({ status: "idle" });
    setLastInput(null);
    setTown("");
    setOpenStation(null);
    setOpenFav(null);
    setRefreshing(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }


  // Start loading all retailer prices as soon as the page opens, so the first
  // search is fast; auto-search with current location if permission was granted
  useEffect(() => {
    warmPrices().catch(() => {});
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
        setResult({
          status: "done",
          stations: res.stations,
          placeLabel: res.placeLabel ?? null,
          missingRetailers: res.missingRetailers ?? [],
        });
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
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            <button
              type="button"
              onClick={goHome}
              aria-label="findfuel — go to homepage"
              className="flex items-center gap-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary">
                <Fuel className="h-6 w-6 text-primary-foreground" />
              </span>
              <span>findfuel</span>
            </button>
          </h1>

          <button
            type="button"
            onClick={toggleDark}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="ml-auto flex h-11 w-11 touch-manipulation items-center justify-center rounded-xl border border-border bg-card text-foreground transition-colors hover:bg-accent"
          >
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
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

        {/* Favourites — the three cheapest stations you've starred */}
        {topFavs.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center gap-2">
              <Star className="h-4 w-4 fill-primary text-primary" />
              <h2 className="text-sm font-bold text-foreground">Your favourites</h2>
            </div>
            <ul className="mt-3 space-y-3">
              {topFavs.map((s) => {
                const id = favId(s);
                const isOpen = openFav === id;
                return (
                  <li
                    key={id}
                    className="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFav(isOpen ? null : id)}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50"
                    >
                      <div className="min-w-0">
                        <span className="font-semibold text-foreground">{s.brand}</span>
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">
                          {s.address}
                          {s.postcode ? `, ${s.postcode}` : ""}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-2xl font-bold tabular-nums text-foreground">
                          {s.price.toFixed(1)}
                          <span className="text-sm font-medium text-muted-foreground">p/L</span>
                        </div>
                      </div>
                    </button>
                    {isOpen && <MapButtons station={s} />}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Live prices, refreshed automatically every minute — tap the star on any station to add or remove it.
            </p>

          </div>
        )}

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

            {result.missingRetailers.length > 0 && (
              <div className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                Couldn't load prices from {result.missingRetailers.join(", ")} right now — their
                stations may be missing.{" "}
                <button
                  type="button"
                  disabled={refreshing}
                  className="font-semibold text-primary underline disabled:opacity-50"
                  onClick={() => lastInput && search(lastInput, true)}
                >
                  Retry them
                </button>
              </div>
            )}

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
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setOpenStation(isOpen ? null : key)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setOpenStation(isOpen ? null : key);
                        }
                      }}
                      className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50"
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
                          {s.driveMins != null && (
                            <span className="font-semibold text-foreground">
                              {" "}· ~{s.driveMins} min drive
                            </span>
                          )}
                        </p>
                        {s.openNow != null && (
                          <p
                            className={`mt-0.5 flex items-center gap-1 text-xs font-semibold ${
                              s.openNow ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${
                                s.openNow ? "bg-green-500" : "bg-red-500"
                              }`}
                            />
                            {s.openNow ? "Open now" : "Closed"}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="text-right">
                          <div className="text-2xl font-bold tabular-nums text-foreground">
                            {s.price.toFixed(1)}
                            <span className="text-sm font-medium text-muted-foreground">p/L</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={
                            favs.some((f) => favId(f) === favId(s))
                              ? `Remove ${s.brand} from favourites`
                              : `Save ${s.brand} to favourites`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFav(s);
                          }}
                          className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                        >
                          <Star
                            className={`h-5 w-5 ${
                              favs.some((f) => favId(f) === favId(s))
                                ? "fill-primary text-primary"
                                : ""
                            }`}
                          />
                        </button>
                      </div>
                    </div>
                    {isOpen && <MapButtons station={s} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
