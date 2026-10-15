import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type FuelStation = {
  brand: string;
  address: string;
  postcode: string;
  lat: number;
  lng: number;
  price: number; // pence per litre, E10 petrol
  distanceKm: number;
  driveMins?: number; // live traffic-aware drive time, when available
  openNow?: boolean | undefined; // from TomTom's place directory, when known
};

type RawStation = {
  brand?: string;
  address?: string;
  postcode?: string;
  location?: { latitude?: number | string; longitude?: number | string };
  prices?: Record<string, number | string | undefined>;
};

const FEEDS: Array<{ url: string; retailer: string }> = [
  { url: "https://storelocator.asda.com/fuel_prices_data.json", retailer: "Asda" },
  { url: "https://www.morrisons.com/fuel-prices/fuel.json", retailer: "Morrisons" },
  { url: "https://jetlocal.co.uk/fuel_prices_data.json", retailer: "JET" },
  { url: "https://fuelprices.esso.co.uk/latestdata.json", retailer: "Esso" },
  { url: "https://applegreenstores.com/fuel-prices/data.json", retailer: "Applegreen" },
  { url: "https://www.tesco.com/fuel_prices/fuel_prices_data.json", retailer: "Tesco" },
  { url: "https://www.shell.co.uk/fuel-prices-data.html", retailer: "Shell" },
  { url: "https://fuel.motorfuelgroup.com/fuel_prices_data.json", retailer: "MFG" },
  {
    url: "https://www.rontec-servicestations.co.uk/fuel-prices/data/fuel_prices_data.json",
    retailer: "Rontec",
  },
  { url: "https://moto-way.com/fuel-price/fuel_prices.json", retailer: "Moto" },
  { url: "https://www.sgnretail.uk/files/data/SGN_daily_fuel_prices.json", retailer: "SGN" },
  // These currently block or time out from servers; kept so they're used if they come back
  {
    url: "https://api.sainsburys.co.uk/v1/exports/latest/fuel_prices_data.json",
    retailer: "Sainsbury's",
  },
  {
    url: "https://www.bp.com/en_gb/united-kingdom/home/fuelprices/fuel_prices_data.json",
    retailer: "BP",
  },
  { url: "https://fuelprices.asconagroup.co.uk/newfuel.json", retailer: "Ascona" },
  { url: "https://api2.krlmedia.com/integration/live_price/krl", retailer: "Karan" },
];

let cache: {
  at: number;
  stations: Omit<FuelStation, "distanceKm">[];
  missing: string[];
} | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Feeds that failed recently are skipped for a while so they don't slow every search
const deadUntil = new Map<string, number>();
const DEAD_TTL_MS = 30 * 60 * 1000;

type FeedResult = { stations: RawStation[]; failed: boolean };

async function fetchFeed(
  feed: { url: string; retailer: string },
  fresh = false,
): Promise<FeedResult> {
  const dead = deadUntil.get(feed.url);
  // A manual refresh retries every feed, even ones that failed recently
  if (!fresh && dead && dead > Date.now()) return { stations: [], failed: true };
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(4000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "application/json,*/*",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      deadUntil.set(feed.url, Date.now() + DEAD_TTL_MS);
      return { stations: [], failed: true };
    }
    const json = (await res.json()) as { stations?: RawStation[] };
    return { stations: json.stations ?? [], failed: false };
  } catch {
    deadUntil.set(feed.url, Date.now() + DEAD_TTL_MS);
    return { stations: [], failed: true };
  }
}

let inflight: Promise<{ stations: Omit<FuelStation, "distanceKm">[]; missing: string[] }> | null =
  null;

async function getAllStations(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  // Stale data: serve instantly, refresh in the background
  if (!fresh && cache) {
    if (!inflight)
      inflight = loadStations().finally(() => {
        inflight = null;
      });
    return cache;
  }
  if (!inflight)
    inflight = loadStations(fresh).finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---- Official government Fuel Finder API (covers every UK forecourt) ----
const FF_BASE = "https://www.fuel-finder.service.gov.uk/api/v1";
let ffToken: { value: string; exp: number } | null = null;

async function getFuelFinderToken(): Promise<string | null> {
  if (ffToken && ffToken.exp > Date.now()) return ffToken.value;
  const id = process.env["FUEL_FINDER_CLIENT_ID"];
  const secret = process.env["FUEL_FINDER_CLIENT_SECRET"];
  if (!id || !secret) return null;
  const res = await fetch(`${FF_BASE}/oauth/generate_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    console.error("Fuel Finder token failed", res.status);
    return null;
  }
  const json = (await res.json()) as any;
  const d = json?.data ?? json;
  const value = d?.access_token as string | undefined;
  if (!value) return null;
  const expiresIn = Number(d?.expires_in) || 3600;
  ffToken = { value, exp: Date.now() + (expiresIn - 60) * 1000 };
  return value;
}

async function ffFetchAll(path: string, token: string): Promise<any[]> {
  const out: any[] = [];
  const BATCH_GROUP = 4;
  for (let start = 1; start <= 60; start += BATCH_GROUP) {
    const pages = await Promise.all(
      Array.from({ length: BATCH_GROUP }, async (_, i) => {
        const res = await fetch(`${FF_BASE}/${path}?batch-number=${start + i}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404) return [];
        if (!res.ok) throw new Error(`Fuel Finder ${path} ${res.status}`);
        const j = (await res.json()) as any;
        return (Array.isArray(j) ? j : (j?.data ?? j?.results ?? [])) as any[];
      }),
    );
    let done = false;
    for (const p of pages) {
      out.push(...p);
      if (p.length === 0) done = true;
    }
    if (done) break;
  }
  return out;
}

const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null && o[k] !== "") return o[k];
  return undefined;
};

async function fetchFuelFinder(): Promise<FeedResult & { configured: boolean }> {
  if (!process.env["FUEL_FINDER_CLIENT_ID"]) return { stations: [], failed: false, configured: false };
  try {
    const token = await getFuelFinderToken();
    if (!token) return { stations: [], failed: true, configured: true };
    const [sites, prices] = await Promise.all([
      ffFetchAll("pfs", token),
      ffFetchAll("pfs/fuel-prices", token),
    ]);
    const priceById = new Map<string, number>();
    for (const p of prices) {
      const id = String(pick(p, "node_id", "nodeId", "id") ?? "");
      const list = (pick(p, "fuel_prices", "prices") ?? []) as any[];
      const e10 = Array.isArray(list)
        ? list.find((f) => String(pick(f, "fuel_type", "fuelType") ?? "").toUpperCase() === "E10")
        : undefined;
      const price = Number(pick(e10, "price", "value"));
      if (id && Number.isFinite(price)) priceById.set(id, price);
    }
    const stations: RawStation[] = [];
    for (const s of sites) {
      const id = String(pick(s, "node_id", "nodeId", "id") ?? "");
      const price = priceById.get(id);
      if (price == null) continue;
      const loc = s.location ?? s;
      const address = [pick(loc, "address_line_1", "address"), pick(loc, "address_line_2"), pick(loc, "city", "town")]
        .filter(Boolean)
        .join(", ");
      stations.push({
        brand: pick(s, "brand_name", "brand", "trading_name") ?? "Unknown",
        address,
        postcode: pick(loc, "postcode", "post_code") ?? "",
        location: { latitude: pick(loc, "latitude", "lat"), longitude: pick(loc, "longitude", "lng", "lon") },
        prices: { E10: price },
      });
    }
    return { stations, failed: stations.length === 0, configured: true };
  } catch (e) {
    console.error("Fuel Finder fetch failed", e);
    return { stations: [], failed: true, configured: true };
  }
}

async function loadStations(fresh = false) {
  const [ff, ...results] = await Promise.all([
    fetchFuelFinder(),
    ...FEEDS.map((feed) => fetchFeed(feed, fresh)),
  ]);
  // When the official feed works it covers every retailer, so nothing is missing
  const missing =
    ff.configured && !ff.failed
      ? []
      : FEEDS.filter((_, i) => results[i]?.failed).map((f) => f.retailer);
  const stations: Omit<FuelStation, "distanceKm">[] = [];
  const seen = new Set<string>();

  // Official data first so it wins de-duplication
  for (const raw of [ff, ...results].flatMap((r) => r.stations)) {
    const lat = Number(raw.location?.latitude);
    const lng = Number(raw.location?.longitude);
    let price = Number(raw.prices?.["E10"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (price < 10) price *= 100; // some feeds report pounds
    if (price < 80 || price > 300) continue; // discard obviously bad data
    // UK mainland + Northern Ireland bounds (excludes Gibraltar etc.)
    if (lat < 49.8 || lat > 60.9 || lng < -8.7 || lng > 1.9) continue;
    const dedupeKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    stations.push({
      brand: raw.brand ?? "Unknown",
      address: raw.address ?? "",
      postcode: raw.postcode ?? "",
      lat,
      lng,
      price,
    });
  }

  cache = { at: Date.now(), stations, missing };
  return { stations, missing };
}

async function geocodeTown(town: string): Promise<{ lat: number; lng: number; label: string } | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=${encodeURIComponent(town)}`,
      { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "fuel-price-finder/1.0" } },
    );
    if (!res.ok) return null;
    const results = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    const first = results[0];
    if (!first) return null;
    return { lat: Number(first.lat), lng: Number(first.lon), label: first.display_name };
  } catch {
    return null;
  }
}

// ---- TomTom live drive times (traffic-aware) ----
// Round the origin so identical searches share one cached set of drive times
const driveCache = new Map<string, { at: number; times: Map<string, number> }>();
const DRIVE_CACHE_TTL_MS = 5 * 60 * 1000;

async function addDriveTimes(stations: FuelStation[], lat: number, lng: number) {
  const key = process.env["TOMTOM_API_KEY"];
  if (!key || stations.length === 0) return;
  const originKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = driveCache.get(originKey);
  const times = cached && Date.now() - cached.at < DRIVE_CACHE_TTL_MS ? cached.times : new Map<string, number>();

  const missing = stations.filter((s) => !times.has(`${s.lat.toFixed(4)},${s.lng.toFixed(4)}`));
  // Small batches with one retry: TomTom's free tier rate-limits bursts
  const fetchOne = async (s: FuelStation, attempt = 0): Promise<void> => {
    try {
      const res = await fetch(
        `https://api.tomtom.com/routing/1/calculateRoute/${lat},${lng}:${s.lat},${s.lng}/json?key=${key}&traffic=true&travelMode=car&routeType=fastest`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (res.status === 429 && attempt < 1) {
        await new Promise((r) => setTimeout(r, 800));
        return fetchOne(s, attempt + 1);
      }
      if (!res.ok) {
        console.error("TomTom route failed", res.status);
        return;
      }
      const json = (await res.json()) as any;
      const secs = json?.routes?.[0]?.summary?.travelTimeInSeconds;
      if (Number.isFinite(secs)) {
        times.set(`${s.lat.toFixed(4)},${s.lng.toFixed(4)}`, Math.max(1, Math.round(secs / 60)));
      }
    } catch {
      // no drive time for this one; the card just shows distance
    }
  };
  const BATCH = 5;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.all(missing.slice(i, i + BATCH).map((s) => fetchOne(s)));
  }
  driveCache.set(originKey, { at: Date.now(), times });
  for (const s of stations) {
    const t = times.get(`${s.lat.toFixed(4)},${s.lng.toFixed(4)}`);
    if (t != null) s.driveMins = t;
  }
}

// ---- TomTom open/closed status (from its place directory) ----
const openCache = new Map<string, { at: number; open: boolean }>();
const OPEN_CACHE_TTL_MS = 30 * 60 * 1000;

function londonNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function isOpenNow(openingHours: any): boolean | undefined {
  const ranges = openingHours?.timeRanges;
  if (!Array.isArray(ranges) || ranges.length === 0) return undefined;
  const { date, minutes } = londonNow();
  for (const r of ranges) {
    const st = r?.startTime;
    const et = r?.endTime;
    if (!st?.date || !et?.date) continue;
    const startM = (st.hour ?? 0) * 60 + (st.minute ?? 0);
    const endM = (et.hour ?? 0) * 60 + (et.minute ?? 0);
    if (st.date === date && et.date === date && minutes >= startM && minutes < endM) return true;
    // Overnight range that started yesterday and ends today
    if (et.date === date && st.date < date && minutes < endM) return true;
    // Overnight range starting today
    if (st.date === date && et.date > date && minutes >= startM) return true;
  }
  return false;
}

async function addOpenStatus(stations: Array<Pick<FuelStation, "brand" | "lat" | "lng"> & { openNow?: boolean | undefined }>) {
  const key = process.env["TOMTOM_API_KEY"];
  if (!key || stations.length === 0) return;
  const fetchOne = async (s: FuelStation): Promise<void> => {
    const cacheKey = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
    const cached = openCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPEN_CACHE_TTL_MS) {
      s.openNow = cached.open;
      return;
    }
    try {
      const res = await fetch(
        `https://api.tomtom.com/search/2/poiSearch/${encodeURIComponent(s.brand)}.json?key=${key}&lat=${s.lat}&lon=${s.lng}&radius=150&categorySet=7311&limit=1&openingHours=nextSevenDays`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (!res.ok) return;
      const json = (await res.json()) as any;
      const poi = json?.results?.[0]?.poi;
      const open = isOpenNow(poi?.openingHours);
      if (open != null) {
        openCache.set(cacheKey, { at: Date.now(), open });
        s.openNow = open;
      }
    } catch {
      // unknown hours; the card just shows no badge
    }
  };
  const BATCH = 5;
  for (let i = 0; i < stations.length; i += BATCH) {
    await Promise.all(stations.slice(i, i + BATCH).map((s) => fetchOne(s)));
  }
}

const inputSchema = z.object({
  town: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  fresh: z.boolean().optional(),
});

export const getFuelPrices = createServerFn({ method: "GET" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    let lat = data.lat;
    let lng = data.lng;
    let placeLabel: string | null = null;
    // Start loading prices while the town is being looked up
    const stationsPromise = getAllStations(data.fresh === true);
    stationsPromise.catch(() => {});

    if (data.town && data.town.trim()) {
      const geo = await geocodeTown(data.town.trim());
      if (!geo) {
        return { error: `Couldn't find "${data.town}". Try a nearby town or city name.` };
      }
      lat = geo.lat;
      lng = geo.lng;
      placeLabel = geo.label;
    }

    if (typeof lat !== "number" || typeof lng !== "number") {
      return { error: "Enter a town name or use your current location." };
    }

    const { stations, missing } = await stationsPromise;
    const RADIUS_KM = 25 * 1.609344; // 25 miles

    const nearby: FuelStation[] = stations
      .map((s) => ({ ...s, distanceKm: haversineKm(lat!, lng!, s.lat, s.lng) }))
      .filter((s) => s.distanceKm <= RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 150);

    if (nearby.length === 0) {
      return { error: "No stations with live prices found within 25 miles of that location." };
    }

    // Live traffic-aware drive times for the closest 25 (the most anyone browses)
    await addDriveTimes(nearby.slice(0, 25), lat!, lng!);
    await addOpenStatus(nearby.slice(0, 15));

    return { stations: nearby, placeLabel, center: { lat, lng }, missingRetailers: missing };
  });

// Called when the page opens so prices are already loading before the user searches
export const warmPrices = createServerFn({ method: "GET" }).handler(async () => {
  await getAllStations();
  return { ok: true };
});

// Latest prices for the user's saved (favourite) stations, matched by position
const favsSchema = z.object({
  stations: z
    .array(
      z.object({
        brand: z.string(),
        postcode: z.string(),
        lat: z.number(),
        lng: z.number(),
      }),
    )
    .max(50),
});

export const getFavouritePrices = createServerFn({ method: "GET" })
  .inputValidator((data) => favsSchema.parse(data))
  .handler(async ({ data }) => {
    const { stations } = await getAllStations();
    const matched: Array<{ lat: number; lng: number; station: FuelStation }> = [];
    for (const fav of data.stations) {
      let best: { station: FuelStation; d: number } | null = null;
      for (const s of stations) {
        const d = haversineKm(fav.lat, fav.lng, s.lat, s.lng);
        if (d < 0.15 && (!best || d < best.d)) best = { station: s, d };
      }
      if (best) matched.push({ lat: fav.lat, lng: fav.lng, station: best.station });
    }
    // Open/closed status for the matched stations, same lookup the search uses
    await addOpenStatus(matched.map((m) => m.station));
    const updates = matched.map(({ lat, lng, station }) => ({
      lat,
      lng,
      price: station.price,
      ...(station.openNow != null ? { openNow: station.openNow } : {}),
    }));
    return { updates };
  });
