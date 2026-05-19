"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";

type Property = {
  customerName: string;
  address: string;
  coords: [number, number];
};

type StopOption = {
  customerName: string;
  address: string;
  coords: [number, number];
  isCustom?: boolean;
  isNursery?: boolean;
};

type SelectedStop = StopOption & {
  instanceId: string;
};

type RouteData = {
  route_order: string[];
  reason: string;
};

type RouteSegment = {
  steps?: {
    way_points?: number[];
  }[];
};

type AppRoute = {
  routes: {
    geometry?: string | [number, number][];
    segments?: RouteSegment[];
  }[];
};

type RouteApiResponse = {
  output?: RouteData;
  orsRoute?: AppRoute;
  error?: string;
};

const nurseryStop: StopOption & { isNursery?: boolean } = {
  customerName: "Nursery",
  address: "168 Heyers Mill Rd, Colts Neck, NJ 07722",
  coords: [-74.187268, 40.301599],
  isNursery: true,
};

const properties: Property[] = [
  {customerName: "Averbach Family", address: "3 Zachary Way, Tinton Falls, NJ 07724", coords: [-74.03599, 40.2774]},
  {customerName: "Colantoni Family", address: "11 Brandywine Ln, Colts Neck, NJ 07722", coords: [-74.139030, 40.311325]},
  {customerName: "Eilenberg Family 1", address: "20 Springhouse Rd, Ocean, NJ 08712", coords: [-74.061508, 40.242782]},
  {customerName: "Eilenberg Family 2", address: "39 Harvey Dr, Short Hills, NJ 07078", coords: [-74.340281, 40.743923]},
  {customerName: "Fisher Family", address: "103 The Terrace, Seagirt, NJ 08750", coords: [-74.028897, 40.138017]},
  {customerName: "Gerrity Family", address: "29 Clarksburg Rd, Millstone Township, NJ 08510", coords: [-74.293023, 40.316136]},
  {customerName: "Koenig Family", address: "217 Beacon Blvd, Seagirt, NJ 08750", coords: [-74.032463, 40.137463]},
  {customerName: "Laverda Family", address: "4 Polo Club Dr, Tinton Falls, NJ 07724", coords: [-74.075084, 40.313041,]},
  {customerName: "Lerner Family", address: "44 Glenwood Rd, Colts Neck, NJ 07722", coords: [-74.219300, 40.339825,]},
  {customerName: "MacDonald Family", address: "16 Bretwood Dr, Colts Neck, NJ 07722", coords: [-74.179607, 40.284531]},
  {customerName: "Maizel Family", address: "120 Davis Ln, Red Bank, NJ 07701", coords: [-74.091161, 40.3483229]},
  {customerName: "McKenna Family", address: "3 Williamsburg N, Colts Neck, NJ 07722", coords: [-74.185960, 40.291659,]},
  {customerName: "Peake Family", address: "25 Wardell Ave, Rumson, NJ 07760", coords: [-74.026324, 40.345205,]},
  {customerName: "Premtaj Family", address: "1058 Franklin Lakes Rd, Franklin Lakes, NJ 07417", coords: [-74.233561, 40.997836,]},
  {customerName: "Sessa Family", address: "83 Hazel Dr, Freehold, NJ 07728", coords: [-74.313458, 40.246766,]},
  {customerName: "Shannon Family", address: "6 Ocala Ct, Freehold, NJ 07728", coords: [-74.326666, 40.233590,]},
  {customerName: "Wolosow Family", address: "41 Heather Dr, Manalapn, NJ 07726", coords: [-74.293023, 40.316136,]},
  {customerName: "Centrastate Large Building", address: "901 West Main Street, Freehold, NJ 07728", coords: [-74.311356, 40.238205]},
  {customerName: "Centrastate Small Building", address: "1001 West Main Street, Freehold, NJ 07728", coords: [-74.314860, 40.234696]},
  {customerName: "Site One", address: "3 Industrial Ct, Freehold, NJ 07728", coords: [-74.232081, 40.230114]},
];

const startCoordsMap = new Map<string, [number, number]>([
  ["168 Heyers Mill Rd, Colts Neck, NJ 07722", [-74.187268, 40.301599]],
  ["475 South St, Morristown, NJ 07960", [-74.480619, 40.781894]],
]);

function getDistanceInFeet(
  coord1: [number, number],
  coord2: [number, number]
): number {
  const toRad = (value: number) => (value * Math.PI) / 180;

  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const meters = R * c;

  return meters * 3.28084;
}

function getClosestPathIndex(
  point: [number, number],
  path: [number, number][]
): number {
  if (path.length === 0) return 0;

  let closestIndex = 0;
  let minDistance = Infinity;

  for (let i = 0; i < path.length; i++) {
    const distance = getDistanceInFeet(point, path[i]);
    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = i;
    }
  }

  return closestIndex;
}

export default function Home() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rebuildingRoute, setRebuildingRoute] = useState(false);
  const [start, setStart] = useState("168 Heyers Mill Rd, Colts Neck, NJ 07722");
  const [followTruck, setFollowTruck] = useState(false);
  const truckAnimationRef = useRef<[number, number] | null>(null);
  const [currentLegIndex, setCurrentLegIndex] = useState(0);
  const [currentLegPath, setCurrentLegPath] = useState <[number, number][]>([]);
  const [currentLegProgressIndex, setCurrentLegProgressIndex] = useState(0);
  const [currentDateTime, setCurrentDateTime] = useState<Date | null>(null);
  const [selectedStops, setSelectedStops] = useState<SelectedStop[]>([]);
  const [customStops, setCustomStops] = useState<StopOption[]>([]);
  const [propertySearch] = useState("");
  const [customAddressSearch, setCustomAddressSearch] = useState("");
  const [customAddressSuggestions, setCustomAddressSuggestions] = useState<StopOption[]>([]);
  const [isSearchingAddresses, setIsSearchingAddresses] = useState(false);
  const [orsRoute, setOrsRoute] = useState<AppRoute | null>(null);
  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [routeNeedsRebuild, setRouteNeedsRebuild] = useState(false);

  const stopMap = useMemo(
    () =>
      new Map(
        [...properties, ...customStops].map((stop) => [
          stop.address,
          stop.coords as [number, number],
        ])
      ),
    [customStops]
  );

  const createSelectedStop = (stop: StopOption): SelectedStop => ({
    ...stop,
    instanceId: `${stop.address}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });

  useEffect(() => {
    setCurrentDateTime(new Date());

    const interval = setInterval(() => {
      setCurrentDateTime(new Date());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const truckMarkerRef = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    const query = customAddressSearch.trim();

    if (query.length < 3) {
      setCustomAddressSuggestions([]);
      setIsSearchingAddresses(false);
      return;
    }

    let isCancelled = false;

    const timeout = setTimeout(async () => {
      try {
        setIsSearchingAddresses(true);

        const res = await fetch(
          `/api/search-addresses?q=${encodeURIComponent(query)}`
        );

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Address search failed");
        }

        if (isCancelled) return;

        const existingAddresses = new Set(
          properties.map((property) => property.address.toLowerCase())
        );

        const filteredResults = (data.results || []).filter(
          (item: StopOption) => !existingAddresses.has(item.address.toLowerCase())
        );

        if (isCancelled) return;

        setCustomAddressSuggestions(filteredResults);
      } catch {
        if (isCancelled) return;
        setCustomAddressSuggestions([]);
      } finally {
        if (!isCancelled) {
          setIsSearchingAddresses(false);
        }
      }
    }, 350);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [customAddressSearch]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
          },
        ],
      },
      center: [-74.185936, 40.296313],
      zoom: 9,
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lngLat: [number, number] = [
          position.coords.longitude,
          position.coords.latitude,
        ];

        if (currentLegPath.length > 1) {
          setCurrentLegProgressIndex(getClosestPathIndex(lngLat, currentLegPath));
        }

        if (!truckMarkerRef.current) {
          truckMarkerRef.current = new maplibregl.Marker({ color: "blue" })
            .setLngLat(lngLat)
            .setPopup(new maplibregl.Popup().setText("Truck Location"))
            .addTo(mapRef.current!);

          truckAnimationRef.current = lngLat;
        } else {
          const start = truckAnimationRef.current ?? lngLat;
          const end = lngLat;
          const duration = 800;
          const startTime = performance.now();

          const animate = (now: number) => {
            const progress = Math.min((now - startTime) / duration, 1);

            const interpolated: [number, number] = [
              start[0] + (end[0] - start[0]) * progress,
              start[1] + (end[1] - start[1]) * progress,
            ];

            truckMarkerRef.current?.setLngLat(interpolated);

            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              truckAnimationRef.current = end;
            }
          };

          requestAnimationFrame(animate);
        }

        if (followTruck) {
          mapRef.current?.flyTo({
            center: lngLat,
            zoom: 14,
          });
        }
      },
      (error) => {
        console.error("Geolocation error:", error);
        console.error("Geolocation Error Message:", error.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 30000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [orsRoute, followTruck, currentLegPath]);

  useEffect(() => {
    if (!orsRoute?.routes?.[0]?.geometry) return;

    const fullRouteGeometry =
      typeof orsRoute.routes[0].geometry === "string"
        ? decodePolyline(orsRoute.routes[0].geometry)
        : orsRoute.routes[0].geometry;
    const currentSegment = orsRoute.routes[0].segments?.[currentLegIndex];
    if (!currentSegment) return;

    const startIndex = currentSegment.steps?.[0]?.way_points?.[0] ?? 0;
    const endIndex =
      currentSegment.steps?.[currentSegment.steps.length - 1]?.way_points?.[1] ??
      fullRouteGeometry.length - 1;

    const defaultCurrentLegGeometry = fullRouteGeometry.slice(startIndex, endIndex + 1);

    setCurrentLegPath(defaultCurrentLegGeometry);
    setCurrentLegProgressIndex(0);
  }, [orsRoute, currentLegIndex]);

  useEffect(() => {
    if (!mapRef.current || !orsRoute?.routes?.[0]?.geometry) return;

    const map = mapRef.current;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    const fullRouteGeometry =
      typeof orsRoute.routes[0].geometry === "string"
        ? decodePolyline(orsRoute.routes[0].geometry)
        : orsRoute.routes[0].geometry;
    const currentSegment = orsRoute.routes[0].segments?.[currentLegIndex];
    if (!currentSegment) return;

    const currentLegGeometry = currentLegPath;
    if (currentLegGeometry.length < 2) return;
    const drivenGeometry = currentLegGeometry.slice(0, currentLegProgressIndex + 1);
    const remainingGeometry = currentLegGeometry.slice(currentLegProgressIndex);
   
    const fullRouteGeoJson = {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: fullRouteGeometry,
      },
      properties: {},
    };

    const existingFullSource = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    const existingDrivenSource = map.getSource("driven-leg") as maplibregl.GeoJSONSource | undefined;
    const existingRemainingSource = map.getSource("remaining-leg") as maplibregl.GeoJSONSource | undefined;

    if (existingFullSource) {
      existingFullSource.setData(fullRouteGeoJson);
    } else {
      map.addSource("route", {
        type: "geojson",
        data: fullRouteGeoJson,
      });

      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": "#cbd5e1",
          "line-width": 4,
        },
      });
    }

    const drivenGeoJson = {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: drivenGeometry,
      },
      properties: {},
    };

    const remainingGeoJson = {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: remainingGeometry,
      },
      properties: {},
    };

    if (existingDrivenSource) {
      existingDrivenSource.setData(drivenGeoJson);
    } else {
      map.addSource("driven-leg", {
        type: "geojson",
        data: drivenGeoJson,
      });

      map.addLayer({
        id: "driven-leg-line",
        type: "line",
        source: "driven-leg",
        paint: {
          "line-color": "#22c55e",
          "line-width": 7,
        },
      });
    }

    if (existingRemainingSource) {
      existingRemainingSource.setData(remainingGeoJson);
    } else {
      map.addSource("remaining-leg", {
        type: "geojson",
        data: remainingGeoJson,
      });

      map.addLayer({
        id: "remaining-leg-line",
        type: "line",
        source: "remaining-leg",
        paint: {
          "line-color": "#2563eb",
          "line-width": 7,
        },
      });
    }

    if (map.getLayer("driven-leg-line")) {
      map.moveLayer("driven-leg-line");
    }

    if (map.getLayer("remaining-leg-line")) {
      map.moveLayer("remaining-leg-line");
    }

    const bounds = new maplibregl.LngLatBounds();
    fullRouteGeometry.forEach((coord: [number, number]) => bounds.extend(coord));

    if (!followTruck && currentLegIndex === 0) {
      map.fitBounds(bounds, {
        padding: 40,
      });
    }

    const startCoords = startCoordsMap.get(start);

    if (startCoords) {
      const startMarker = new maplibregl.Marker({ color: "green" })
        .setLngLat(startCoords)
        .setPopup(new maplibregl.Popup().setText("Start / End"))
        .addTo(map);

      markersRef.current.push(startMarker);
    }


    routeData?.route_order?.forEach((address: string, index: number) => {
      const coords = stopMap.get(address);

      if (!coords) return;

      const el = document.createElement("div");
      el.className =
        "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-red-600 text-sm font-bold text-white shadow";
      el.textContent = String(index + 1);

      const stopMarker = new maplibregl.Marker({ element: el })
        .setLngLat(coords)
        .setPopup(
          new maplibregl.Popup().setText(`Stop ${index + 1}: ${address}`)
        )
        .addTo(map);

      markersRef.current.push(stopMarker);
    });
  }, [orsRoute, routeData, start, currentLegIndex, currentLegPath, currentLegProgressIndex, followTruck, stopMap]);

  useEffect(() => {
    const savedState = localStorage.getItem("crewRouteState");
    if (!savedState) return;

    try {
      const parsed = JSON.parse(savedState);

      if (parsed.start) setStart(parsed.start);
      if (parsed.routeData) setRouteData(parsed.routeData);
      if (parsed.orsRoute) setOrsRoute(parsed.orsRoute);
      if (typeof parsed.currentLegIndex === "number") {
        setCurrentLegIndex(parsed.currentLegIndex);
      }
      if (typeof parsed.followTruck === "boolean") {
        setFollowTruck(parsed.followTruck);
      }
      if (Array.isArray(parsed.customStops)) {
        setCustomStops(parsed.customStops);
      }
    } catch (error) {
      console.error("Failed to restore route state:", error);
    }
  }, []);

  useEffect(() => {
    const navigationState = {
      start,
      routeData,
      orsRoute,
      currentLegIndex,
      followTruck,
      customStops,
    };

    console.log("SAVING crewRouteState:", navigationState);
    localStorage.setItem("crewRouteState", JSON.stringify(navigationState));
  }, [start, routeData, orsRoute, currentLegIndex, followTruck, customStops]);

  const date = currentDateTime
    ? currentDateTime.toLocaleDateString()
    : "";

  const time = currentDateTime
    ? currentDateTime.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  useEffect(() => {
    if (!mapRef.current) return;

    const resizeOnce = () => mapRef.current?.resize();

    const t1 = setTimeout(resizeOnce, 50);
    const t2 = setTimeout(resizeOnce, 200);
    const t3 = setTimeout(resizeOnce, 500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  const testRoute = async () => {
    setLoading(true);
    setFollowTruck(false);
    setCurrentLegIndex(0);
    setCurrentLegProgressIndex(0);
    setCurrentLegPath([]);
    setRouteData(null);
    setOrsRoute(null);
    setRouteNeedsRebuild(false);
    setError("");

    const parsedStops = selectedStops.map((stop) => ({
      address: stop.address,
      coords: stop.coords,
    }));

    const payload = {
      date: date,
      time: time,
      start,
      stops: parsedStops,
    };

    try {
      const res = await fetch("/api/test-openai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as RouteApiResponse;
      console.log("API RESPONSE:", data);

      if(!res.ok || !data.output || !data.orsRoute) {
        throw new Error(data.error || "API request failed.");
      }

      setRouteData(data.output);
      setOrsRoute(data.orsRoute);
      setRouteNeedsRebuild(false);
      setSelectedStops([]);
      console.log("ROUTE DATA BEING SET:", data.output);
      console.log("ORS Route Data:", data.orsRoute);
      setSelectedStops([]);
    } catch (error: unknown) {
      setError(getErrorMessage(error))
    } finally {
      setLoading(false);
    }
  };

  const rebuildRouteFromCurrentOrder = async () => {
    if (!routeData?.route_order.length) return;

    setRebuildingRoute(true);
    setError("");

    const orderedStops = routeData.route_order
      .map((address) => {
        const coords = stopMap.get(address);

        if (!coords) {
          return null;
        }

        return { address, coords };
      })
      .filter(Boolean) as { address: string; coords: [number, number] }[];

    if (orderedStops.length !== routeData.route_order.length) {
      setError("Could not rebuild route because one or more stops are missing coordinates.");
      setRebuildingRoute(false);
      return;
    }

    try {
      const res = await fetch("/api/test-openai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date,
          time,
          start,
          stops: orderedStops,
          preserveOrder: true,
        }),
      });

      const data = (await res.json()) as RouteApiResponse;

      if (!res.ok || !data.output || !data.orsRoute) {
        throw new Error(data.error || "Failed to rebuild route.");
      }

      setRouteData(data.output);
      setOrsRoute(data.orsRoute);
      setRouteNeedsRebuild(false);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setRebuildingRoute(false);
    }
  };


  function decodePolyline(encoded: string): [number, number][] {
    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates: [number, number][] = [];

    while (index < encoded.length) {
      let shift = 0;
      let result = 0;

      while (true) {
        const byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
        if (byte < 0x20) break;
      }

      const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
      lat += deltaLat;

      shift = 0;
      result = 0;

      while (true) {
        const byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
        if (byte < 0x20) break;
      }

      const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
      lng += deltaLng;

      coordinates.push([lng / 1e5, lat / 1e5]);
    }

    return coordinates;
  }

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong...";
  }

  const filteredProperties = properties.filter((property) => {
    const search = propertySearch.trim().toLowerCase();

    if (!search) return true;

    return (
      property.customerName.toLowerCase().includes(search) ||
      property.address.toLowerCase().includes(search)
    );
  });

  const nurserySelectedCount = selectedStops.filter(
    (stop) => stop.address === nurseryStop.address
  ).length;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 rounded-2xl bg-gradient-to-r from-slate-900 to-slate-700 p-6 text-white shadow-lg">
          <h1 className="text-3xl font-bold tracking-tight">Crew Route Optimizer</h1>
          <p className="mt-2 text-sm text-slate-200">
            Build routes, add custom stops, and launch navigation.
          </p>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">Start Location</p>
              <p className="mt-1 text-sm font-semibold text-white">{start}</p>
            </div>

            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">Current Date</p>
              <p className="mt-1 text-sm font-semibold text-white">{date}</p>
            </div>

            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">Current Time</p>
              <p className="mt-1 text-sm font-semibold text-white">{time}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                Start Location
              </label>
              <select
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-800 shadow-sm"
              >
                <option value="168 Heyers Mill Rd, Colts Neck, NJ 07722">
                  Nursery
                </option>
                <option value="475 South St, Morristown, NJ 07960">
                  Morristown
                </option>
              </select>

              <label className="mt-6 mb-3 block text-sm font-semibold text-slate-700">
                Add Custom Address
              </label>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <input
                  type="text"
                  value={customAddressSearch}
                  onChange={(e) => setCustomAddressSearch(e.target.value)}
                  placeholder="Search for a new address"
                  className="mb-3 w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-800"
                />

                {isSearchingAddresses && (
                  <p className="mb-3 text-sm text-slate-500">Searching addresses...</p>
                )}

                {!isSearchingAddresses &&
                  customAddressSearch.trim().length >= 3 &&
                  customAddressSuggestions.length === 0 && (
                    <p className="mb-3 text-sm text-slate-500">No address matches found.</p>
                  )}

                {customAddressSuggestions.length > 0 && (
                  <div className="space-y-2">
                    {customAddressSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.address}
                        type="button"
                        onClick={() => {
                          setCustomStops((prev) =>
                            prev.some((stop) => stop.address === suggestion.address)
                              ? prev
                              : [...prev, suggestion]
                          );
                          setSelectedStops((prev) => {
                            const lastStop = prev[prev.length - 1];

                            if (lastStop?.address === suggestion.address) {
                              return prev;
                            }

                            return [...prev, createSelectedStop(suggestion)];
                          });

                          setCustomAddressSearch("");
                          setCustomAddressSuggestions([]);
                        }}
                        className="block w-full rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:bg-slate-100"
                      >
                        <div className="font-semibold text-slate-800">Custom Address</div>
                        <div className="text-sm text-slate-500">{suggestion.address}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {customStops.length > 0 && (
                <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <label className="mb-3 block text-sm font-semibold text-slate-700">
                    Custom Stops Added
                  </label>

                  <div className="space-y-2">
                    {customStops.map((stop) => (
                      <div
                        key={stop.address}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
                      >
                        <div>
                          <div className="font-semibold text-slate-800">Custom Address</div>
                          <div className="text-sm text-slate-500">{stop.address}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedStops((prev) => [...prev, createSelectedStop(stop)]);
                            }}
                            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
                          >
                            Add
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setCustomStops((prev) =>
                                prev.filter((item) => item.address !== stop.address)
                              );

                              setSelectedStops((prev) =>
                                prev.filter((item) => item.address !== stop.address)
                              );
                            }}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <label className="mt-6 mb-3 block text-sm font-semibold text-slate-700">
                Select Properties
              </label>
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedStops((prev) => {
                      const lastStop = prev[prev.length - 1];

                      if (lastStop?.address === nurseryStop.address) {
                        const lastMatchingIndex = [...prev]
                          .map((stop, index) => ({ stop, index }))
                          .filter(({ stop }) => stop.address === nurseryStop.address)
                          .pop()?.index;

                        if (lastMatchingIndex !== undefined) {
                          return prev.filter((_, index) => index !== lastMatchingIndex);
                        }

                        return prev;
                      }

                      return [...prev, createSelectedStop(nurseryStop)];
                    });
                  }}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-100"
                >
                  {`Add Nursery Stop${nurserySelectedCount > 0 ? ` (${nurserySelectedCount})` : ""}`}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredProperties.map((property) => {
                  const selectedCount = selectedStops.filter(
                    (stop) => stop.address === property.address
                  ).length;

                  const isSelected = selectedCount > 0;
                  return (
                    <button
                      key={property.address}
                      type="button"
                      onClick={() => {
                        setSelectedStops((prev) => {
                          const lastStop = prev[prev.length - 1];

                          if (lastStop?.address === property.address) {
                            const lastMatchingIndex = [...prev]
                              .map((stop, index) => ({ stop, index }))
                              .filter(({ stop }) => stop.address === property.address)
                              .pop()?.index;

                            if (lastMatchingIndex !== undefined) {
                              return prev.filter((_, index) => index !== lastMatchingIndex);
                            }

                            return prev;
                          }

                          return [...prev, createSelectedStop(property)];
                        });
                      }}
                      className={`rounded-xl border p-4 text-left shadow-sm transition ${
                        isSelected
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"
                      }`}
                    >
                      <div className="font-semibold">
                        {property.customerName}
                        {selectedCount > 0 ? ` (${selectedCount})` : ""}
                      </div>
                      <div
                        className={`mt-1 text-sm ${
                          isSelected ? "text-slate-200" : "text-slate-500"
                        }`}
                      >
                        {property.address}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Selected Stops</h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {selectedStops.length}
                </span>
              </div>

              {selectedStops.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  No stops selected yet.
                </p>
              ) : (
                <div className="mt-4 space-y-2">
                  {selectedStops.map((stop, index) => (
                    <div
                      key={stop.instanceId}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                          {index + 1}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-900">
                            {stop.customerName}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {stop.address}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedStops((prev) =>
                              prev.filter((item) => item.instanceId !== stop.instanceId)
                            );
                          }}
                          className="shrink-0 rounded-lg border border-red-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Route Actions</h2>
              <p className="mt-1 text-sm text-slate-500">
                Optimize your selected stops and open turn by turn navigation.
              </p>

              <div className="mt-6 flex flex-col gap-3">
                <button
                  onClick={testRoute}
                  disabled={loading}
                  className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading ? "Optimizing..." : "Optimize Route"}
                </button>

                <button
                  onClick={() => router.push("/nav")}
                  disabled={!routeData || !orsRoute || routeNeedsRebuild}
                  className="rounded-xl bg-blue-700 px-4 py-3 font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Open Navigation
                </button>
              </div>

              {error && (
                <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </p>
              )}
            </div>
            {routeData && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="mb-3 text-lg font-semibold text-slate-900">
                  Optimized Route
                </h2>
                {routeNeedsRebuild && (
                  <div className = "mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3">
                  <p className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    Route order changed. Rebuild the route before opening navigation.
                  </p>
                  <button
                    type="button"
                    onClick={rebuildRouteFromCurrentOrder}
                    disabled={rebuildingRoute}
                    className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {rebuildingRoute ? "Rebuilding..." : "Rebuild Route"}
                  </button>
                </div>
                )}
                <div className="space-y-2">
                  {routeData.route_order.map((stop: string, index: number) => {
                    const isNursery = stop === nurseryStop.address;
                    return (
                      <div
                        key={`${stop}-${index}`}
                        className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                            {index + 1}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div
                              className={`text-sm font-semibold ${
                                isNursery ? "text-emerald-700" : "text-slate-900"
                              }`}
                            >
                              {isNursery ? "Nursery Stop" : "Stop"}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500">
                              {stop}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => {
                              setRouteData((prev) => {
                                if (!prev || index === 0) return prev;

                                const nextOrder = [...prev.route_order];
                                [nextOrder[index - 1], nextOrder[index]] = [
                                  nextOrder[index],
                                  nextOrder[index - 1],
                                ];

                                return {
                                  ...prev,
                                  route_order: nextOrder,
                                };
                              });

                              setRouteNeedsRebuild(true);
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            disabled={index === routeData.route_order.length - 1}
                            onClick={() => {
                              setRouteData((prev) => {
                                if (!prev || index === prev.route_order.length - 1) return prev;

                                const nextOrder = [...prev.route_order];
                                [nextOrder[index], nextOrder[index + 1]] = [
                                  nextOrder[index + 1],
                                  nextOrder[index],
                                ];

                                return {
                                  ...prev,
                                  route_order: nextOrder,
                                };
                              });

                              setRouteNeedsRebuild(true);
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRouteData((prev) => {
                                if (!prev) return prev;

                                return {
                                  ...prev,
                                  route_order: prev.route_order.filter(
                                    (_, stopIndex) => stopIndex !== index
                                  ),
                                };
                              });

                              setRouteNeedsRebuild(true);
                            }}
                            className="rounded-lg border border-red-300 bg-white px-2 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 rounded-xl bg-slate-50 p-4">
                  <p className="text-sm text-slate-700">
                    <strong>Reason:</strong> {routeData.reason}
                  </p>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </main>
  );
}
