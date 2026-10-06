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
  prices?: Record<string, number | undefined>;
};

const FEEDS = [
  "https://storelocator.asda.com/fuel_prices_data.json",
  "https://www.morrisons.com/fuel-prices/fuel.json",
  "https://jetlocal.co.uk/fuel_prices_data.json",
  "https://fuelprices.esso.co.uk/latestdata.json",
  "https://applegreenstores.com/fuel-prices/data.json",
];

let cache: { at: number; stations: Omit<FuelStation, "distanceKm">[] } | null = null;
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

async function fetchFeed(url: string): Promise<RawStation[]> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "fuel-price-finder/1.0" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { stations?: RawStation[] };
    return json.stations ?? [];
  } catch {
    return [];
  }
}

async function getAllStations(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.stations;

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const stations: Omit<FuelStation, "distanceKm">[] = [];

  for (const raw of results.flat()) {
    const lat = Number(raw.location?.latitude);
    const lng = Number(raw.location?.longitude);
    const price = raw.prices?.["E10"];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (typeof price !== "number" || price <= 0) continue;
    // UK mainland + Northern Ireland bounds (excludes Gibraltar etc.)
    if (lat < 49.8 || lat > 60.9 || lng < -8.7 || lng > 1.9) continue;
    stations.push({
      brand: raw.brand ?? "Unknown",
      address: raw.address ?? "",
      postcode: raw.postcode ?? "",
      lat,
      lng,
      price,
    });
  }

  cache = { at: Date.now(), stations };
  return stations;
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

    const stations = await getAllStations();
    const RADIUS_KM = 25;

    const nearby: FuelStation[] = stations
      .map((s) => ({ ...s, distanceKm: haversineKm(lat!, lng!, s.lat, s.lng) }))
      .filter((s) => s.distanceKm <= RADIUS_KM)
      .sort((a, b) => a.price - b.price)
      .slice(0, 20);

    if (nearby.length === 0) {
      return { error: "No stations with live prices found within 25 km of that location." };
    }

    return { stations: nearby, placeLabel, center: { lat, lng } };
  });
