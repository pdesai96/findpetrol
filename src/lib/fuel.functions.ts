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

async function loadStations(fresh = false) {
  const results = await Promise.all(FEEDS.map((feed) => fetchFeed(feed, fresh)));
  const missing = FEEDS.filter((_, i) => results[i].failed).map((f) => f.retailer);
  const stations: Omit<FuelStation, "distanceKm">[] = [];
  const seen = new Set<string>();

  for (const raw of results.flatMap((r) => r.stations)) {
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

    const stations = await stationsPromise;
    const RADIUS_KM = 25 * 1.609344; // 25 miles

    const nearby: FuelStation[] = stations
      .map((s) => ({ ...s, distanceKm: haversineKm(lat!, lng!, s.lat, s.lng) }))
      .filter((s) => s.distanceKm <= RADIUS_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 150);

    if (nearby.length === 0) {
      return { error: "No stations with live prices found within 25 miles of that location." };
    }

    return { stations: nearby, placeLabel, center: { lat, lng } };
  });
