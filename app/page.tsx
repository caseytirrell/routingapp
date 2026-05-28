"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import { decodePolyline, getClosestPathIndex } from "@/lib/geo";
import { nurseryStop, properties, startCoordsMap } from "@/lib/stops";
import type {
  AppRoute,
  Coordinate,
  RouteApiResponse,
  RouteData,
  StopOption,
  TrafficAssessment,
} from "@/lib/route-types";

type SelectedStop = StopOption & {
  instanceId: string;
};

type RouteMode = "single" | "full";

export default function Home() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [rebuildingRoute, setRebuildingRoute] = useState(false);
  const [start, setStart] = useState("168 Heyers Mill Rd, Colts Neck, NJ 07722");
  const [followTruck, setFollowTruck] = useState(false);
  const [routeMode, setRouteMode] = useState<RouteMode>("single");
  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
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
  const [trafficAssessment, setTrafficAssessment] = useState<TrafficAssessment | null>(null);
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

    const map = new maplibregl.Map({
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

    mapRef.current = map;

    map.on("load", () => map.resize());

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lngLat: [number, number] = [
          position.coords.longitude,
          position.coords.latitude,
        ];

        setCurrentLocation(lngLat);

        if (currentLegPath.length > 1) {
          setCurrentLegProgressIndex(getClosestPathIndex(lngLat, currentLegPath));
        }

        if (!mapRef.current) return;

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

    const startCoords = routeMode === "full" ? startCoordsMap.get(start) : null;

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
  }, [orsRoute, routeData, start, routeMode, currentLegIndex, currentLegPath, currentLegProgressIndex, followTruck, stopMap]);

  useEffect(() => {
    const savedState = localStorage.getItem("crewRouteState");
    if (!savedState) return;

    try {
      const parsed = JSON.parse(savedState);

      if (parsed.start) setStart(parsed.start);
      if (parsed.routeData) setRouteData(parsed.routeData);
      if (parsed.orsRoute) setOrsRoute(parsed.orsRoute);
      if (parsed.trafficAssessment) setTrafficAssessment(parsed.trafficAssessment);
      if (typeof parsed.currentLegIndex === "number") {
        setCurrentLegIndex(parsed.currentLegIndex);
      }
      if (typeof parsed.followTruck === "boolean") {
        setFollowTruck(parsed.followTruck);
      }
      if (Array.isArray(parsed.customStops)) {
        setCustomStops(parsed.customStops);
      }
      if (parsed.routeMode === "single" || parsed.routeMode === "full") {
        setRouteMode(parsed.routeMode);
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
      trafficAssessment,
      currentLegIndex,
      followTruck,
      customStops,
      routeMode,
    };

    console.log("SAVING crewRouteState:", navigationState);
    localStorage.setItem("crewRouteState", JSON.stringify(navigationState));
  }, [start, routeData, orsRoute, trafficAssessment, currentLegIndex, followTruck, customStops, routeMode]);

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
    if (selectedStops.length === 0) {
      setError(routeMode === "single" ? "Select a destination before creating a route." : "Select at least one stop before optimizing.");
      return;
    }

    if (routeMode === "single" && selectedStops.length !== 1) {
      setError("Single stop mode routes to one destination at a time.");
      return;
    }

    setLoading(true);
    setFollowTruck(false);
    setCurrentLegIndex(0);
    setCurrentLegProgressIndex(0);
    setCurrentLegPath([]);
    setRouteData(null);
    setOrsRoute(null);
    setTrafficAssessment(null);
    setRouteNeedsRebuild(false);
    setError("");

    if (routeMode === "single" && !currentLocation) {
      setLoading(false);
      setError("Waiting for the iPad location before creating a route.");
      return;
    }

    const parsedStops = selectedStops.map((stop) => ({
      address: stop.address,
      coords: stop.coords,
    }));

    const payload = {
      date: date,
      time: time,
      start,
      stops: parsedStops,
      preserveOrder: routeMode === "single",
      originCoords: routeMode === "single" ? currentLocation : undefined,
      returnToStart: routeMode === "full",
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

      setRouteData({
        ...data.output,
        reason:
          routeMode === "single"
            ? "Single stop route from current iPad location."
            : data.output.reason,
      });
      setOrsRoute(data.orsRoute);
      setTrafficAssessment(data.trafficAssessment ?? null);
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
      setTrafficAssessment(data.trafficAssessment ?? null);
      setRouteNeedsRebuild(false);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setRebuildingRoute(false);
    }
  };

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

  const setStopSelection = (stop: StopOption) => {
    setRouteData(null);
    setOrsRoute(null);
    setRouteNeedsRebuild(false);
    setError("");

    if (routeMode === "single") {
      setSelectedStops((prev) => {
        const selected = prev[0]?.address === stop.address;
        return selected ? [] : [createSelectedStop(stop)];
      });
      return;
    }

    setSelectedStops((prev) => {
      const lastStop = prev[prev.length - 1];

      if (lastStop?.address === stop.address) {
        const lastMatchingIndex = [...prev]
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.address === stop.address)
          .pop()?.index;

        if (lastMatchingIndex !== undefined) {
          return prev.filter((_, index) => index !== lastMatchingIndex);
        }

        return prev;
      }

      return [...prev, createSelectedStop(stop)];
    });
  };

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 rounded-2xl bg-gradient-to-r from-slate-900 to-slate-700 p-6 text-white shadow-lg">
          <h1 className="text-3xl font-bold tracking-tight">Crew Route Optimizer</h1>
          <p className="mt-2 text-sm text-slate-200">
            Route from the current iPad location or plan a full stop sequence.
          </p>

          <div className="mt-6 grid gap-4 md:grid-cols-4">
            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">Route Mode</p>
              <p className="mt-1 text-sm font-semibold text-white">
                {routeMode === "single" ? "Single Stop" : "Full Route"}
              </p>
            </div>

            {routeMode === "full" && (
              <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
                <p className="text-xs uppercase tracking-wide text-slate-300">
                  Start Location
                </p>
                <p className="mt-1 text-sm font-semibold text-white">{start}</p>
              </div>
            )}

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
                Route Type
              </label>
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
                {(["single", "full"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setRouteMode(mode);
                      setSelectedStops([]);
                      setRouteData(null);
                      setOrsRoute(null);
                      setRouteNeedsRebuild(false);
                      setError("");
                    }}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                      routeMode === mode
                        ? "bg-slate-900 text-white shadow-sm"
                        : "bg-transparent text-slate-700 hover:bg-white"
                    }`}
                  >
                    {mode === "single" ? "Single Stop" : "Full Route"}
                  </button>
                ))}
              </div>

              {routeMode === "full" && (
                <>
                  <label className="mt-6 mb-2 block text-sm font-semibold text-slate-700">
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
                </>
              )}

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
                          setStopSelection(suggestion);

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
                              setStopSelection(stop);
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
                {routeMode === "single" ? "Choose Destination" : "Select Properties"}
              </label>
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setStopSelection(nurseryStop)}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-100"
                >
                  {routeMode === "single"
                    ? selectedStops[0]?.address === nurseryStop.address
                      ? "Nursery Selected"
                      : "Route to Nursery"
                    : `Add Nursery Stop${nurserySelectedCount > 0 ? ` (${nurserySelectedCount})` : ""}`}
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
                      onClick={() => setStopSelection(property)}
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
                <h2 className="text-lg font-semibold text-slate-900">
                  {routeMode === "single" ? "Destination" : "Selected Stops"}
                </h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {selectedStops.length}
                </span>
              </div>

              {selectedStops.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  {routeMode === "single"
                    ? "Choose one destination to route from the current iPad location."
                    : "No stops selected yet."}
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
                {routeMode === "single"
                  ? "Create a route from the current iPad location to the chosen destination."
                  : "Optimize your selected stops and open turn by turn navigation."}
              </p>

              <div className="mt-6 flex flex-col gap-3">
                <button
                  onClick={testRoute}
                  disabled={loading || selectedStops.length === 0}
                  className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading
                    ? routeMode === "single"
                      ? "Creating Route..."
                      : "Optimizing..."
                    : routeMode === "single"
                      ? "Create Route"
                      : "Optimize Route"}
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
                  {routeMode === "single" ? "Current Route" : "Optimized Route"}
                </h2>
                {routeMode === "full" && routeNeedsRebuild && (
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
                        {routeMode === "full" && (
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
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 rounded-xl bg-slate-50 p-4">
                  <p className="text-sm text-slate-700">
                    <strong>Reason:</strong> {routeData.reason}
                  </p>
                </div>
                {trafficAssessment && (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-900">
                        TomTom Traffic
                      </p>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          trafficAssessment.status === "accepted"
                            ? "bg-emerald-100 text-emerald-700"
                            : trafficAssessment.status === "rejected"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {trafficAssessment.status}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-slate-600">
                      {trafficAssessment.reason}
                    </p>
                    {trafficAssessment.delayRatio !== null && (
                      <p className="mt-1 text-xs text-slate-500">
                        Delay: {Math.round((trafficAssessment.delaySeconds ?? 0) / 60)} min,
                        {" "}
                        {Math.round(trafficAssessment.delayRatio * 100)}% over no-traffic time
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </main>
  );
}
