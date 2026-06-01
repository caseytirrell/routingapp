"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import { decodePolyline, getClosestPathIndex } from "@/lib/geo";
import {
  LANGUAGE_CHANGE_EVENT,
  LANGUAGE_STORAGE_KEY,
  languageLabels,
  normalizeLanguage,
  pageText,
  saveAppLanguage,
  type AppLanguage,
} from "@/lib/i18n";
import { nurseryStop, properties, startCoordsMap } from "@/lib/stops";
import type {
  AppRoute,
  Coordinate,
  DayPlanState,
  RouteApiResponse,
  RouteData,
  RouteDecisionReport,
  StopOption,
  TrafficAssessment,
} from "@/lib/route-types";

type SelectedStop = StopOption & {
  instanceId: string;
};

type RouteMode = "single" | "full";

const DAY_PLAN_STORAGE_KEY = "crewDayPlanState";

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
  const [dayPlan, setDayPlan] = useState<RouteData | null>(null);
  const [dayPlanNeedsReoptimization, setDayPlanNeedsReoptimization] = useState(false);
  const [startingDayPlanAddress, setStartingDayPlanAddress] = useState<string | null>(null);
  const [showAddDayPlanStopMenu, setShowAddDayPlanStopMenu] = useState(false);
  const [dayPlanAddressSearch, setDayPlanAddressSearch] = useState("");
  const [dayPlanAddressSuggestions, setDayPlanAddressSuggestions] = useState<StopOption[]>([]);
  const [isSearchingDayPlanAddresses, setIsSearchingDayPlanAddresses] = useState(false);
  const [trafficAssessment, setTrafficAssessment] = useState<TrafficAssessment | null>(null);
  const [routeDecision, setRouteDecision] = useState<RouteDecisionReport | null>(null);
  const [showDecisionDetails, setShowDecisionDetails] = useState(false);
  const [routeNeedsRebuild, setRouteNeedsRebuild] = useState(false);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const t = pageText[language];

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
  const availableDayPlanStops = useMemo(() => {
    const scheduledAddresses = new Set(dayPlan?.route_order ?? []);

    return [nurseryStop, ...properties, ...customStops].filter(
      (stop, index, stops) =>
        !scheduledAddresses.has(stop.address) &&
        stops.findIndex((candidate) => candidate.address === stop.address) === index
    );
  }, [customStops, dayPlan]);

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

  useEffect(() => {
    setLanguage(normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY)));

    const handleLanguageChange = (event: Event) => {
      const nextLanguage = normalizeLanguage(
        event instanceof CustomEvent ? event.detail : localStorage.getItem(LANGUAGE_STORAGE_KEY)
      );
      setLanguage(nextLanguage);
    };

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    window.addEventListener("storage", handleLanguageChange);

    return () => {
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
      window.removeEventListener("storage", handleLanguageChange);
    };
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
    const query = dayPlanAddressSearch.trim();

    if (query.length < 3) {
      setDayPlanAddressSuggestions([]);
      setIsSearchingDayPlanAddresses(false);
      return;
    }

    let isCancelled = false;

    const timeout = setTimeout(async () => {
      try {
        setIsSearchingDayPlanAddresses(true);

        const res = await fetch(
          `/api/search-addresses?q=${encodeURIComponent(query)}`
        );
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Address search failed");
        }

        if (isCancelled) return;

        const existingAddresses = new Set([
          ...properties.map((property) => property.address.toLowerCase()),
          ...customStops.map((stop) => stop.address.toLowerCase()),
          ...(dayPlan?.route_order ?? []).map((address) => address.toLowerCase()),
        ]);

        setDayPlanAddressSuggestions(
          (data.results || []).filter(
            (item: StopOption) => !existingAddresses.has(item.address.toLowerCase())
          )
        );
      } catch {
        if (!isCancelled) {
          setDayPlanAddressSuggestions([]);
        }
      } finally {
        if (!isCancelled) {
          setIsSearchingDayPlanAddresses(false);
        }
      }
    }, 350);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [customStops, dayPlan, dayPlanAddressSearch]);

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
      if (parsed.routeDecision) setRouteDecision(parsed.routeDecision);
      if (typeof parsed.showDecisionDetails === "boolean") {
        setShowDecisionDetails(parsed.showDecisionDetails);
      }
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
    const savedState = localStorage.getItem(DAY_PLAN_STORAGE_KEY);
    if (!savedState) return;

    try {
      const parsed = JSON.parse(savedState) as DayPlanState;

      if (!parsed.routeData?.route_order?.length) return;

      setStart(parsed.start);
      setDayPlan(parsed.routeData);
      setDayPlanNeedsReoptimization(Boolean(parsed.needsReoptimization));
      setRouteMode("full");

      if (Array.isArray(parsed.customStops)) {
        setCustomStops(parsed.customStops);
      }
    } catch (error) {
      console.error("Failed to restore day plan:", error);
    }
  }, []);

  useEffect(() => {
    if (!dayPlan?.route_order.length) {
      localStorage.removeItem(DAY_PLAN_STORAGE_KEY);
      return;
    }

    const dayPlanState: DayPlanState = {
      start,
      routeData: dayPlan,
      customStops,
      needsReoptimization: dayPlanNeedsReoptimization,
    };

    localStorage.setItem(DAY_PLAN_STORAGE_KEY, JSON.stringify(dayPlanState));
  }, [customStops, dayPlan, dayPlanNeedsReoptimization, start]);

  useEffect(() => {
    const navigationState = {
      start,
      routeData,
      orsRoute,
      trafficAssessment,
      routeDecision,
      showDecisionDetails,
      currentLegIndex,
      followTruck,
      customStops,
      routeMode,
    };

    console.log("SAVING crewRouteState:", navigationState);
    localStorage.setItem("crewRouteState", JSON.stringify(navigationState));
  }, [start, routeData, orsRoute, trafficAssessment, routeDecision, showDecisionDetails, currentLegIndex, followTruck, customStops, routeMode]);

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
      setError(routeMode === "single" ? t.selectDestinationError : t.selectStopError);
      return;
    }

    if (routeMode === "single" && selectedStops.length !== 1) {
      setError(t.singleStopOnlyError);
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
    setRouteDecision(null);
    setRouteNeedsRebuild(false);
    setError("");

    if (routeMode === "single" && !currentLocation) {
      setLoading(false);
      setError(t.waitingForLocation);
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
      includeDecisionReport: showDecisionDetails,
      language,
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

      const nextRouteData = {
        ...data.output,
        reason:
          routeMode === "single"
            ? t.singleStopReason
            : data.output.reason,
      };

      if (routeMode === "full") {
        setDayPlan(nextRouteData);
        setDayPlanNeedsReoptimization(false);
        setRouteData(null);
        setOrsRoute(null);
        setTrafficAssessment(null);
        setRouteDecision(null);
      } else {
        setRouteData(nextRouteData);
        setOrsRoute(data.orsRoute);
        setTrafficAssessment(data.trafficAssessment ?? null);
        setRouteDecision(data.routeDecision ?? null);
      }
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

  const startDayPlanDrive = async (address: string) => {
    const coords = stopMap.get(address);

    if (!currentLocation) {
      setError(t.waitingForLocation);
      return;
    }

    if (!coords) {
      setError(t.missingStopCoordinates);
      return;
    }

    try {
      setStartingDayPlanAddress(address);
      setError("");

      const res = await fetch("/api/test-openai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date,
          time,
          start,
          stops: [{ address, coords }],
          preserveOrder: true,
          originCoords: currentLocation,
          returnToStart: false,
          includeDecisionReport: showDecisionDetails,
          language,
        }),
      });

      const data = (await res.json()) as RouteApiResponse;

      if (!res.ok || !data.output || !data.orsRoute) {
        throw new Error(data.error || "Failed to create the next drive.");
      }

      const navigationState = {
        start,
        routeData: data.output,
        orsRoute: data.orsRoute,
        trafficAssessment: data.trafficAssessment ?? null,
        routeDecision: data.routeDecision ?? null,
        currentLegIndex: 0,
        followTruck: true,
        customStops,
        routeMode: "single" as const,
        dayPlanStopAddress: address,
      };

      const dayPlanState: DayPlanState = {
        start,
        routeData: dayPlan ?? { route_order: [address], reason: "" },
        customStops,
        activeStopAddress: address,
        needsReoptimization: false,
      };

      localStorage.setItem("crewRouteState", JSON.stringify(navigationState));
      localStorage.setItem(DAY_PLAN_STORAGE_KEY, JSON.stringify(dayPlanState));
      router.push("/nav");
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setStartingDayPlanAddress(null);
    }
  };

  const reOptimizeDayPlan = useCallback(async () => {
    if (!dayPlan?.route_order.length) return;

    setRebuildingRoute(true);
    setDayPlanNeedsReoptimization(false);
    setError("");

    const remainingStops = dayPlan.route_order
      .map((address) => {
        const coords = stopMap.get(address);

        if (!coords) {
          return null;
        }

        return { address, coords };
      })
      .filter(Boolean) as { address: string; coords: [number, number] }[];

    if (remainingStops.length !== dayPlan.route_order.length) {
      setError(t.missingStopCoordinates);
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
          stops: remainingStops,
          originCoords: currentLocation ?? undefined,
          returnToStart: true,
          includeDecisionReport: showDecisionDetails,
          language,
        }),
      });

      const data = (await res.json()) as RouteApiResponse;

      if (!res.ok || !data.output || !data.orsRoute) {
        throw new Error(data.error || "Failed to re-optimize the day plan.");
      }

      setDayPlan(data.output);
      setRouteNeedsRebuild(false);
    } catch (error: unknown) {
      setError(getErrorMessage(error));
    } finally {
      setRebuildingRoute(false);
    }
  }, [currentLocation, date, dayPlan, language, showDecisionDetails, start, stopMap, t.missingStopCoordinates, time]);

  useEffect(() => {
    if (!dayPlanNeedsReoptimization || rebuildingRoute) return;

    reOptimizeDayPlan();
  }, [dayPlanNeedsReoptimization, reOptimizeDayPlan, rebuildingRoute]);

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Something went wrong...";
  }

  const formatMinutes = (seconds: number | null) => {
    if (seconds === null) return "N/A";

    return `${Math.round(seconds / 60)} min`;
  };

  const formatDistance = (meters: number | null) => {
    if (meters === null) return "N/A";

    const miles = meters / 1609.344;

    return `${miles.toFixed(1)} mi`;
  };

  const selectedDecisionCandidate =
    routeDecision?.candidates.find((candidate) => candidate.selected) ?? null;
  const selectedEtaSeconds =
    selectedDecisionCandidate?.routeDurationSeconds ??
    trafficAssessment?.travelTimeSeconds ??
    null;
  const selectedDelayMinutes =
    trafficAssessment?.delaySeconds === null ||
    trafficAssessment?.delaySeconds === undefined
      ? null
      : Math.round(trafficAssessment.delaySeconds / 60);
  const trafficLabel =
    selectedDelayMinutes === null
      ? t.checking
      : selectedDelayMinutes <= 3
        ? t.light
        : selectedDelayMinutes <= 10
          ? t.moderate
          : t.heavy;

  const filteredProperties = properties.filter((property) => {
    const search = propertySearch.trim().toLowerCase();

    if (!search) return true;

    return (
      property.customerName.toLowerCase().includes(search) ||
      property.address.toLowerCase().includes(search)
    );
  });
  const displayedRouteData = routeMode === "full" ? dayPlan : routeData;

  const addStopToDayPlan = (stop: StopOption) => {
    setDayPlan((prev) => {
      if (!prev || prev.route_order.includes(stop.address)) return prev;

      return {
        ...prev,
        route_order: [...prev.route_order, stop.address],
      };
    });
    setDayPlanNeedsReoptimization(true);
    setShowAddDayPlanStopMenu(false);
    setDayPlanAddressSearch("");
    setDayPlanAddressSuggestions([]);
  };

  const addCustomStopToDayPlan = (stop: StopOption) => {
    setCustomStops((prev) =>
      prev.some((item) => item.address === stop.address) ? prev : [...prev, stop]
    );
    addStopToDayPlan(stop);
  };

  const nurserySelectedCount = selectedStops.filter(
    (stop) => stop.address === nurseryStop.address
  ).length;

  const setStopSelection = (stop: StopOption) => {
    setRouteData(null);
    setOrsRoute(null);
    setTrafficAssessment(null);
    setRouteDecision(null);
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
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{t.appTitle}</h1>
              <p className="mt-2 text-sm text-slate-200">
                {t.appSubtitle}
              </p>
            </div>
            <label className="min-w-36 text-sm font-semibold text-slate-200">
              <span className="mb-1 block">{t.language}</span>
              <select
                value={language}
                onChange={(event) => saveAppLanguage(normalizeLanguage(event.target.value))}
                className="w-full rounded-xl border border-white/20 bg-white/10 p-2 text-white"
              >
                {(["en", "es"] as const).map((option) => (
                  <option key={option} value={option} className="text-slate-900">
                    {languageLabels[option]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-4">
            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">{t.routeMode}</p>
              <p className="mt-1 text-sm font-semibold text-white">
                {routeMode === "single" ? t.singleStop : t.fullRoute}
              </p>
            </div>

            {routeMode === "full" && (
              <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
                <p className="text-xs uppercase tracking-wide text-slate-300">
                  {t.startLocation}
                </p>
                <p className="mt-1 text-sm font-semibold text-white">{start}</p>
              </div>
            )}

            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">{t.currentDate}</p>
              <p className="mt-1 text-sm font-semibold text-white">{date}</p>
            </div>

            <div className="rounded-xl bg-white/10 p-4 backdrop-blur-sm">
              <p className="text-xs uppercase tracking-wide text-slate-300">{t.currentTime}</p>
              <p className="mt-1 text-sm font-semibold text-white">{time}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <label className="mb-2 block text-sm font-semibold text-slate-700">
                {t.routeType}
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
                      setTrafficAssessment(null);
                      setRouteDecision(null);
                      setRouteNeedsRebuild(false);
                      setError("");
                    }}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                      routeMode === mode
                        ? "bg-slate-900 text-white shadow-sm"
                        : "bg-transparent text-slate-700 hover:bg-white"
                    }`}
                  >
                    {mode === "single" ? t.singleStop : t.fullRoute}
                  </button>
                ))}
              </div>

              {routeMode === "full" && (
                <>
                  <label className="mt-6 mb-2 block text-sm font-semibold text-slate-700">
                    {t.startLocation}
                  </label>
                  <select
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-800 shadow-sm"
                  >
                    <option value="168 Heyers Mill Rd, Colts Neck, NJ 07722">
                      {t.nursery}
                    </option>
                    <option value="475 South St, Morristown, NJ 07960">
                      Morristown
                    </option>
                  </select>
                </>
              )}

              <label className="mt-6 mb-3 block text-sm font-semibold text-slate-700">
                {t.addCustomAddress}
              </label>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <input
                  type="text"
                  value={customAddressSearch}
                  onChange={(e) => setCustomAddressSearch(e.target.value)}
                  placeholder={t.searchNewAddress}
                  className="mb-3 w-full rounded-xl border border-slate-300 bg-white p-3 text-slate-800"
                />

                {isSearchingAddresses && (
                  <p className="mb-3 text-sm text-slate-500">{t.searchingAddresses}</p>
                )}

                {!isSearchingAddresses &&
                  customAddressSearch.trim().length >= 3 &&
                  customAddressSuggestions.length === 0 && (
                    <p className="mb-3 text-sm text-slate-500">{t.noAddressMatches}</p>
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
                        <div className="font-semibold text-slate-800">{t.customAddress}</div>
                        <div className="text-sm text-slate-500">{suggestion.address}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {customStops.length > 0 && (
                <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <label className="mb-3 block text-sm font-semibold text-slate-700">
                    {t.customStopsAdded}
                  </label>

                  <div className="space-y-2">
                    {customStops.map((stop) => (
                      <div
                        key={stop.address}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
                      >
                        <div>
                          <div className="font-semibold text-slate-800">{t.customAddress}</div>
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
                            {t.add}
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
                            {t.remove}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <label className="mt-6 mb-3 block text-sm font-semibold text-slate-700">
                {routeMode === "single" ? t.chooseDestination : t.selectProperties}
              </label>
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setStopSelection(nurseryStop)}
                  className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 shadow-sm transition hover:bg-emerald-100"
                >
                  {routeMode === "single"
                    ? selectedStops[0]?.address === nurseryStop.address
                      ? t.nurserySelected
                      : t.routeToNursery
                    : `${t.addNurseryStop}${nurserySelectedCount > 0 ? ` (${nurserySelectedCount})` : ""}`}
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
                  {routeMode === "single" ? t.destination : t.selectedStops}
                </h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                  {selectedStops.length}
                </span>
              </div>

              {selectedStops.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500">
                  {routeMode === "single"
                    ? t.chooseOneDestination
                    : t.noStopsSelected}
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
                          {t.remove}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">{t.routeActions}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {routeMode === "single"
                  ? t.singleActionHelp
                  : t.fullActionHelp}
              </p>

              <label className="mt-5 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <input
                  type="checkbox"
                  checked={showDecisionDetails}
                  onChange={(event) => setShowDecisionDetails(event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="block text-sm font-semibold text-slate-800">
                    {t.routeDecisionDetails}
                  </span>
                  <span className="mt-1 block text-xs text-slate-500">
                    {t.candidateScoringReport}
                  </span>
                </span>
              </label>

              <div className="mt-6 flex flex-col gap-3">
                <button
                  onClick={testRoute}
                  disabled={loading || selectedStops.length === 0}
                  className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loading
                    ? routeMode === "single"
                      ? t.creatingRoute
                      : t.optimizing
                    : routeMode === "single"
                      ? t.createRoute
                      : t.optimizeRoute}
                </button>

                {routeMode === "single" && (
                  <button
                    onClick={() => router.push("/nav")}
                    disabled={!routeData || !orsRoute || routeNeedsRebuild}
                    className="rounded-xl bg-blue-700 px-4 py-3 font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t.openNavigation}
                  </button>
                )}
              </div>

              {error && (
                <p className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                  {error}
                </p>
              )}
            </div>
            {displayedRouteData && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="mb-3 text-lg font-semibold text-slate-900">
                  {routeMode === "single" ? t.currentRoute : t.optimizedRoute}
                </h2>
                {routeMode === "full" && (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setShowAddDayPlanStopMenu((prev) => !prev)}
                        className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                      >
                        {showAddDayPlanStopMenu ? t.closeAddStop : t.addStopToPlan}
                      </button>
                      <button
                        type="button"
                        onClick={reOptimizeDayPlan}
                        disabled={rebuildingRoute}
                        className="rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rebuildingRoute ? t.optimizing : t.reOptimizeRemaining}
                      </button>
                    </div>
                    {showAddDayPlanStopMenu && (
                      <div className="mb-4 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
                        <div className="mb-3 rounded-lg border border-slate-200 bg-white p-2">
                          <input
                            type="text"
                            value={dayPlanAddressSearch}
                            onChange={(event) => setDayPlanAddressSearch(event.target.value)}
                            placeholder={t.searchNewAddress}
                            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          />
                          {isSearchingDayPlanAddresses && (
                            <p className="mt-2 text-xs text-slate-500">
                              {t.searchingAddresses}
                            </p>
                          )}
                          {!isSearchingDayPlanAddresses &&
                            dayPlanAddressSearch.trim().length >= 3 &&
                            dayPlanAddressSuggestions.length === 0 && (
                              <p className="mt-2 text-xs text-slate-500">
                                {t.noAddressMatches}
                              </p>
                            )}
                          {dayPlanAddressSuggestions.length > 0 && (
                            <div className="mt-2 space-y-2">
                              {dayPlanAddressSuggestions.map((stop) => (
                                <button
                                  key={stop.address}
                                  type="button"
                                  onClick={() => addCustomStopToDayPlan(stop)}
                                  disabled={rebuildingRoute}
                                  className="block w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <div className="text-sm font-semibold text-slate-900">
                                    {stop.customerName}
                                  </div>
                                  <div className="mt-0.5 text-xs text-slate-500">
                                    {stop.address}
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {availableDayPlanStops.length === 0 ? (
                          <p className="px-2 py-3 text-sm text-slate-500">
                            {t.noStopsAvailable}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {availableDayPlanStops.map((stop) => (
                              <button
                                key={stop.address}
                                type="button"
                                onClick={() => addStopToDayPlan(stop)}
                                disabled={rebuildingRoute}
                                className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <div className="text-sm font-semibold text-slate-900">
                                  {stop.customerName}
                                </div>
                                <div className="mt-0.5 text-xs text-slate-500">
                                  {stop.address}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className="space-y-2">
                  {displayedRouteData.route_order.map((stop: string, index: number) => {
                    const isNursery = stop === nurseryStop.address;
                    return (
                      <div
                        key={`${stop}-${index}`}
                        className={`rounded-xl border p-3 ${
                          routeMode === "full" && index === 0
                            ? "border-blue-300 bg-blue-50"
                            : "border-slate-200 bg-slate-50"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                            {index + 1}
                          </div>

                          <div className="min-w-0 flex-1">
                            {routeMode === "full" && index === 0 && (
                              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-blue-700">
                                {t.nextStop}
                              </div>
                            )}
                            <div
                              className={`text-sm font-semibold ${
                                isNursery ? "text-emerald-700" : "text-slate-900"
                              }`}
                            >
                              {isNursery ? t.nurseryStop : t.stop}
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500">
                              {stop}
                            </div>
                          </div>
                          {routeMode === "full" && (
                            <button
                              type="button"
                              onClick={() => startDayPlanDrive(stop)}
                              disabled={startingDayPlanAddress !== null}
                              className="shrink-0 rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {startingDayPlanAddress === stop ? t.startingDrive : t.startDrive}
                            </button>
                          )}
                        </div>
                        {routeMode === "full" && (
                          <div className="mt-3 grid grid-cols-3 gap-2">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => {
                              setDayPlan((prev) => {
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

                              setDayPlanNeedsReoptimization(false);
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {t.up}
                          </button>
                          <button
                            type="button"
                            disabled={index === displayedRouteData.route_order.length - 1}
                            onClick={() => {
                              setDayPlan((prev) => {
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

                              setDayPlanNeedsReoptimization(false);
                            }}
                            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {t.down}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDayPlan((prev) => {
                                if (!prev) return prev;

                                return {
                                  ...prev,
                                  route_order: prev.route_order.filter(
                                    (_, stopIndex) => stopIndex !== index
                                  ),
                                };
                              });

                              setDayPlanNeedsReoptimization(false);
                            }}
                            className="rounded-lg border border-red-300 bg-white px-2 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
                          >
                            {t.remove}
                          </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 rounded-xl bg-slate-50 p-4">
                  <p className="text-sm text-slate-700">
                    <strong>{t.reason}:</strong> {displayedRouteData.reason}
                  </p>
                </div>
                {trafficAssessment && (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {t.routeReady}
                        </p>
                        <p className="mt-1 text-2xl font-bold text-slate-900">
                          {t.eta} {formatMinutes(selectedEtaSeconds)}
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          trafficAssessment.status === "accepted"
                            ? "bg-emerald-100 text-emerald-700"
                            : trafficAssessment.status === "rejected"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {trafficLabel} {t.traffic}
                      </span>
                    </div>
                    {selectedDelayMinutes !== null && selectedDelayMinutes > 0 && (
                      <p className="mt-2 text-sm text-slate-600">
                        {t.trafficDelay(selectedDelayMinutes)}
                      </p>
                    )}
                  </div>
                )}
                {showDecisionDetails && routeDecision && (
                  <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          Route Decision
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {routeDecision.scoredCandidateCount} of {routeDecision.candidateCount} candidates scored
                        </p>
                      </div>
                      <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                        {routeDecision.selectedCandidateId ?? "none"}
                      </span>
                    </div>

                    <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                      {routeDecision.selectedReason}
                    </p>

                    <div className="mt-4 space-y-3">
                      {routeDecision.candidates.map((candidate) => (
                        <div
                          key={candidate.id}
                          className={`rounded-xl border p-3 ${
                            candidate.selected
                              ? "border-blue-300 bg-blue-50"
                              : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">
                                {candidate.label}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {formatDistance(candidate.distanceMeters)} · Route ETA {formatMinutes(candidate.routeDurationSeconds)}
                              </p>
                            </div>
                            <div className="flex shrink-0 gap-2">
                              {candidate.selected && (
                                <span className="rounded-full bg-blue-600 px-2 py-1 text-xs font-semibold text-white">
                                  chosen
                                </span>
                              )}
                              <span
                                className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  candidate.accepted
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-amber-100 text-amber-800"
                                }`}
                              >
                                {candidate.accepted ? "accepted" : "rejected"}
                              </span>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                            <div className="rounded-lg bg-white p-2">
                              <p className="font-semibold text-slate-500">TomTom ETA</p>
                              <p className="mt-1 text-slate-900">
                                {formatMinutes(candidate.tomTomTravelTimeSeconds)}
                              </p>
                            </div>
                            <div className="rounded-lg bg-white p-2">
                              <p className="font-semibold text-slate-500">Delay</p>
                              <p className="mt-1 text-slate-900">
                                {formatMinutes(candidate.tomTomDelaySeconds)}
                              </p>
                            </div>
                            <div className="rounded-lg bg-white p-2">
                              <p className="font-semibold text-slate-500">Overage</p>
                              <p className="mt-1 text-slate-900">
                                {candidate.tomTomDelayRatio === null
                                  ? "N/A"
                                  : `${Math.round(candidate.tomTomDelayRatio * 100)}%`}
                              </p>
                            </div>
                          </div>

                          <div className="mt-3 rounded-lg bg-white p-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-semibold text-slate-500">
                                Commercial Check
                              </p>
                              <span
                                className={`rounded-full px-2 py-0.5 font-semibold ${
                                  candidate.commercialValidation.status === "passed"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : candidate.commercialValidation.status === "rejected"
                                      ? "bg-red-100 text-red-700"
                                      : "bg-slate-100 text-slate-600"
                                }`}
                              >
                                {candidate.commercialValidation.status}
                              </span>
                            </div>
                            <p className="mt-1 text-slate-600">
                              {candidate.commercialValidation.reason}
                            </p>
                          </div>

                          {candidate.rejectionReason && (
                            <p className="mt-3 text-xs text-slate-600">
                              {candidate.rejectionReason}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
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
