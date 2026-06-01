"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import maplibregl from "maplibre-gl";
import {
  decodePolyline,
  getBearingBetweenPoints,
  getClosestPathIndex,
  getClosestPointOnPath,
  getDistanceAlongPathInFeet,
  getDistanceFromPathFeet,
  getDistanceInFeet,
  getUpcomingPathBearing,
} from "@/lib/geo";
import {
  LANGUAGE_CHANGE_EVENT,
  LANGUAGE_STORAGE_KEY,
  languageLabels,
  navText,
  normalizeLanguage,
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
  RouteSegment,
  RouteStep,
  StopOption,
} from "@/lib/route-types";

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

type SavedNavigationState = {
  start: string;
  routeData: RouteData | null;
  orsRoute: AppRoute | null;
  currentLegIndex: number;
  followTruck: boolean;
  routeMode?: "single" | "full";
  customStops?: StopOption[];
  dayPlanStopAddress?: string;
};

const DAY_PLAN_STORAGE_KEY = "crewDayPlanState";

function formatDistanceToNextStop(feet: number | null): string {
  if (feet === null) return "—";

  if (feet < 1000) {
    return `${Math.round(feet)} ft`;
  }

  const miles = feet / 5280;
  return `${miles.toFixed(1)} mi`;
}

function formatEtaTime(date: Date, language: AppLanguage): string {
  return new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getStepInstructionText(step: RouteStep | null): string | null {
  if (!step) return null;

  if (typeof step.instruction === "string") {
    return step.instruction;
  }

  if (typeof step.instruction?.text === "string") {
    return step.instruction.text;
  }

  if (typeof step.name === "string" && step.name.trim()) {
    return step.name;
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function replaceCurrentLegInDisplayGeometry(
  fullRouteGeometry: Coordinate[],
  currentSegment: RouteSegment,
  currentLegPath: Coordinate[],
  isCurrentLegRerouted: boolean
): Coordinate[] {
  if (!isCurrentLegRerouted || currentLegPath.length < 2) {
    return fullRouteGeometry;
  }

  const startIndex = currentSegment.steps?.[0]?.way_points?.[0] ?? 0;
  const endIndex =
    currentSegment.steps?.[currentSegment.steps.length - 1]?.way_points?.[1] ??
    fullRouteGeometry.length - 1;

  return [
    ...fullRouteGeometry.slice(0, startIndex),
    ...currentLegPath,
    ...fullRouteGeometry.slice(endIndex + 1),
  ];
}


export default function NavPage() {
  const router = useRouter();
  const [start, setStart] = useState("168 Heyers Mill Rd, Colts Neck, NJ 07722");
  const [routeMode, setRouteMode] = useState<"single" | "full">("single");
  const [followTruck, setFollowTruck] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [availableStops, setAvailableStops] = useState<StopOption[]>([
    nurseryStop,
    ...properties,
  ]);
  const [truckLocation, setTruckLocation] = useState<[number, number] | null>(null);
  const truckAnimationRef = useRef<[number, number] | null>(null);
  const [currentLegIndex, setCurrentLegIndex] = useState(0);
  const [isRerouting, setIsRerouting] = useState(false);
  const [lastRerouteAt, setLastRerouteAt] = useState(0);
  const [currentLegPath, setCurrentLegPath] = useState<[number, number][]>([]);
  const [currentLegProgressIndex, setCurrentLegProgressIndex] = useState(0);
  const [orsRoute, setOrsRoute] = useState<AppRoute | null>(null);
  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [navigationStarted, setNavigationStarted] = useState(false);
  const [navigationPaused, setNavigationPaused] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date());
  const [dayPlanStopAddress, setDayPlanStopAddress] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("en");
  const t = navText[language];

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const truckMarkerRef = useRef<maplibregl.Marker | null>(null);
  const truckMarkerElementRef = useRef<HTMLDivElement | null>(null);
  const previousTruckLocationRef = useRef<[number, number] | null>(null);
  const currentTruckHeadingRef = useRef<number | null>(null);
  const reroutedLegIndexRef = useRef<number | null>(null);
  const reroutedLegOriginalSegmentRef = useRef<RouteSegment | null>(null);



  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  const stopMap = useMemo(
    () =>
      new Map(
        availableStops.map((stop) => [stop.address, stop.coords as [number, number]])
      ),
    [availableStops]
  );

  const SNAP_TO_ROUTE_THRESHOLD_FEET = 50;
  const ARRIVAL_SUGGESTION_THRESHOLD_FEET = 150;
  const ARRIVAL_STRONG_SUGGESTION_THRESHOLD_FEET = 75;
  const REROUTE_DISTANCE_THRESHOLD_FEET = 125;
  const REROUTE_COOLDOWN_MS = 3000;
  const spokenTurnThresholdsRef = useRef<Set<string>>(new Set());
  const spokenArrivalRef = useRef<string | null>(null);

  const speakPrompt = useCallback((message: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = language === "es" ? "es-US" : "en-US";
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }, [language]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentDateTime(new Date());
    }, 30000);

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

  useEffect(() => {
    const saved = localStorage.getItem("crewRouteState");

    if (!saved) {
      router.replace("/");
      return;
    }

    try {
      const parsed = JSON.parse(saved) as SavedNavigationState;
      console.log("RESTORED crewRouteState IN NAV:", parsed);

      if (parsed.customStops?.length) {
        const baseStops = [nurseryStop, ...properties];
        const mergedStops = [
          ...baseStops,
          ...parsed.customStops.filter(
            (savedStop) =>
              !baseStops.some((stop) => stop.address === savedStop.address)
          ),
        ];

        setAvailableStops(mergedStops);
      }

      if (!parsed.routeData || !parsed.orsRoute) {
        router.replace("/");
        return;
      }

      if (parsed.start) setStart(parsed.start);
      if (parsed.routeData) setRouteData(parsed.routeData);
      if (parsed.orsRoute) setOrsRoute(parsed.orsRoute);
      if (typeof parsed.currentLegIndex === "number") {
        setCurrentLegIndex(parsed.currentLegIndex);
      }
      if (typeof parsed.followTruck === "boolean") {
        setFollowTruck(parsed.followTruck);
      }
      if (parsed.routeMode === "single" || parsed.routeMode === "full") {
        setRouteMode(parsed.routeMode);
      }
      if (parsed.dayPlanStopAddress) {
        setDayPlanStopAddress(parsed.dayPlanStopAddress);
      }
    } catch (error) {
      console.error("Failed to load navigation state:", error);
      router.replace("/");
    }
  }, [router]);

  useEffect(() => {
    const requestWakeLock = async () => {
      try {
        if (!("wakeLock" in navigator)) {
          console.log("Screen Wake Lock API is not supported in this browser.");
          return;
        }

        const wakeLockNavigator = navigator as NavigatorWithWakeLock;
        wakeLockRef.current = await wakeLockNavigator.wakeLock?.request("screen") ?? null;
        console.log("Screen wake lock active.");

        wakeLockRef.current.addEventListener("release", () => {
          console.log("Screen wake lock released.");
          wakeLockRef.current = null;
        });
      } catch (error) {
        console.error("Failed to request screen wake lock:", error);
      }
    };

    const releaseWakeLock = async () => {
      try {
        if (wakeLockRef.current) {
          await wakeLockRef.current.release();
          wakeLockRef.current = null;
        }
      } catch (error) {
        console.error("Failed to release screen wake lock:", error);
      }
    };

    if (navigationStarted && !navigationPaused) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    return () => {
      releaseWakeLock();
    };
  }, [navigationStarted, navigationPaused]);

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

    map.on("load", () => {
      setMapReady(true);
      map.resize();
    });

    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const rawLngLat: [number, number] = [
          position.coords.longitude,
          position.coords.latitude,
        ];

        setTruckLocation(rawLngLat);

        const distanceToPath =
          currentLegPath.length > 1
            ? getDistanceFromPathFeet(rawLngLat, currentLegPath)
            : null;

        const snappedPoint =
          distanceToPath !== null &&
          distanceToPath <= SNAP_TO_ROUTE_THRESHOLD_FEET &&
          currentLegPath.length > 1
            ? getClosestPointOnPath(rawLngLat, currentLegPath)
            : null;

        const lngLat = snappedPoint ?? rawLngLat;

        const closestIndex =
          currentLegPath.length > 1
            ? getClosestPathIndex(lngLat, currentLegPath)
            : null;

        const routeBearing =
          closestIndex !== null
            ? getUpcomingPathBearing(currentLegPath, closestIndex)
            : null;

        const gpsHeading =
          typeof position.coords.heading === "number" && !Number.isNaN(position.coords.heading)
            ? position.coords.heading
            : null;

        const movementDistanceFeet = previousTruckLocationRef.current
          ? getDistanceInFeet(previousTruckLocationRef.current, rawLngLat)
          : 0;

        const movementBearing =
          previousTruckLocationRef.current && movementDistanceFeet >= 15
            ? getBearingBetweenPoints(previousTruckLocationRef.current, rawLngLat)
            : null;

        const markerHeading = gpsHeading ?? movementBearing ?? routeBearing;

        if (markerHeading !== null) {
          currentTruckHeadingRef.current = markerHeading;
        }

        if (markerHeading !== null && truckMarkerElementRef.current) {
          truckMarkerElementRef.current.style.transform = `rotate(${markerHeading}deg)`;
        }

        previousTruckLocationRef.current = rawLngLat;

        if (closestIndex !== null) {
          setCurrentLegProgressIndex(closestIndex);
        }

        if (navigationStarted && !navigationPaused && routeBearing !== null) {
          mapRef.current?.easeTo({
            center: lngLat,
            zoom: 17,
            bearing: routeBearing,
            pitch: 45,
            duration: 500,
          });
        }


        if (!truckMarkerRef.current || !truckMarkerElementRef.current) {
          truckMarkerRef.current?.remove();
          truckMarkerRef.current = null;

          const markerElement = document.createElement("div");
          markerElement.style.width = "36px";
          markerElement.style.height = "36px";
          markerElement.style.borderRadius = "9999px";
          markerElement.style.background = "#2563eb";
          markerElement.style.border = "3px solid white";
          markerElement.style.boxShadow = "0 8px 18px rgba(15, 23, 42, 0.35)";
          markerElement.style.display = "flex";
          markerElement.style.alignItems = "center";
          markerElement.style.justifyContent = "center";

          markerElement.innerHTML = `
            <div style="
              width: 0;
              height: 0;
              border-left: 8px solid transparent;
              border-right: 8px solid transparent;
              border-bottom: 18px solid white;
              transform: translateY(-2px);
            "></div>
          `;


          truckMarkerElementRef.current = markerElement;

          truckMarkerRef.current = new maplibregl.Marker({ element: markerElement })
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
      },
      (error) => {
        const errorNames: Record<number, string> = {
          1: "Permission denied",
          2: "Position unavailable",
          3: "Timeout",
        };

        console.error("GPS ERROR:", {
          code: error.code,
          type: errorNames[error.code] ?? "Unknown error",
          message: error.message,
        });
        setNavigationError(`GPS error: ${errorNames[error.code] ?? error.message}`);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 30000,
      }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [mapReady, orsRoute, currentLegPath, navigationStarted, navigationPaused]);

  useEffect(() => {
    if (!orsRoute?.routes?.[0]?.geometry) return;
    if (
      reroutedLegIndexRef.current === currentLegIndex &&
      currentLegPath.length > 1
    ) {
      return;
    }

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
    reroutedLegIndexRef.current = null;
    reroutedLegOriginalSegmentRef.current = null;
  }, [orsRoute, currentLegIndex, currentLegPath.length]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !orsRoute?.routes?.[0]?.geometry) return;

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
    const isCurrentLegRerouted = reroutedLegIndexRef.current === currentLegIndex;
    const segmentForDisplaySplice =
      isCurrentLegRerouted && reroutedLegOriginalSegmentRef.current
        ? reroutedLegOriginalSegmentRef.current
        : currentSegment;

    const displayRouteGeometry = replaceCurrentLegInDisplayGeometry(
      fullRouteGeometry,
      segmentForDisplaySplice,
      currentLegGeometry,
      isCurrentLegRerouted
    );

    const drivenGeometry = currentLegGeometry.slice(0, currentLegProgressIndex + 1);
    const remainingGeometry = currentLegGeometry.slice(currentLegProgressIndex);

    const fullRouteGeoJson = {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: displayRouteGeometry,
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

    const startCoords = startCoordsMap.get(start);

    if (startCoords) {
      const startMarker = new maplibregl.Marker({ color: "green" })
        .setLngLat(startCoords)
        .setPopup(new maplibregl.Popup().setText("Start / End"))
        .addTo(map);

      markersRef.current.push(startMarker);
    }

    const stopMarkerGroups = new Map<
      string,
      {
        addresses: string[];
        coords: [number, number];
        stopNumbers: number[];
      }
    >();

    routeData?.route_order?.forEach((address: string, index: number) => {
      const coords = stopMap.get(address);

      if (!coords) return;

      const markerKey = `${coords[0].toFixed(6)},${coords[1].toFixed(6)}`;
      const existingGroup = stopMarkerGroups.get(markerKey);

      if (existingGroup) {
        existingGroup.stopNumbers.push(index + 1);

        if (!existingGroup.addresses.includes(address)) {
          existingGroup.addresses.push(address);
        }
      } else {
        stopMarkerGroups.set(markerKey, {
          addresses: [address],
          coords,
          stopNumbers: [index + 1],
        });
      }
    });

    stopMarkerGroups.forEach(({ addresses, coords, stopNumbers }) => {
      const el = document.createElement("div");

      const label = stopNumbers.join(" / ");
      const hasMultipleStops = stopNumbers.length > 1;

      el.className = hasMultipleStops
        ? "flex h-9 min-w-12 items-center justify-center rounded-full border-2 border-white bg-red-600 px-2 text-sm font-bold text-white shadow"
        : "flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-red-600 text-sm font-bold text-white shadow";

      el.textContent = label;

      const popupText = hasMultipleStops
        ? `Stops ${label}: ${addresses.join(" | ")}`
        : `Stop ${label}: ${addresses[0]}`;

      const stopMarker = new maplibregl.Marker({ element: el })
        .setLngLat(coords)
        .setPopup(new maplibregl.Popup().setText(popupText))
        .addTo(map);

      markersRef.current.push(stopMarker);
    });

    const bounds = new maplibregl.LngLatBounds();
    displayRouteGeometry.forEach((coord: [number, number]) => bounds.extend(coord));

    if (!truckLocation) {
      map.fitBounds(bounds, {
        padding: 40,
      });
    }
  }, [mapReady, orsRoute, routeData, start, currentLegIndex, currentLegPath, currentLegProgressIndex, followTruck, stopMap, truckLocation]);

  useEffect(() => {
    if (!routeData || !orsRoute) return;

    const navigationState = {
      start,
      routeData,
      orsRoute,
      currentLegIndex,
      followTruck,
      routeMode,
      customStops: availableStops.filter((stop) => stop.isCustom),
      dayPlanStopAddress,
    };

    localStorage.setItem("crewRouteState", JSON.stringify(navigationState));
  }, [start, routeData, orsRoute, currentLegIndex, followTruck, routeMode, availableStops, dayPlanStopAddress]);

  const currentStopAddress = routeData?.route_order?.[currentLegIndex] ?? null;

  const currentStopCoords =
    currentStopAddress
      ? stopMap.get(currentStopAddress) ?? null
      : startCoordsMap.get(start) ?? null;

  const distanceToCurrentStopFeet =
    truckLocation && currentStopCoords
      ? getDistanceInFeet(truckLocation, currentStopCoords)
      : null;

  const arrivalSuggestionLevel =
    distanceToCurrentStopFeet !== null &&
    distanceToCurrentStopFeet <= ARRIVAL_STRONG_SUGGESTION_THRESHOLD_FEET
      ? "strong"
      : distanceToCurrentStopFeet !== null &&
          distanceToCurrentStopFeet <= ARRIVAL_SUGGESTION_THRESHOLD_FEET
        ? "near"
        : null;

  const arrivalSuggestionText =
    arrivalSuggestionLevel === "strong"
      ? t.atStop
      : arrivalSuggestionLevel === "near"
        ? t.nearStop
        : null;

  const currentSegment = orsRoute?.routes?.[0]?.segments?.[currentLegIndex] ?? null;
  const remainingCurrentLegSeconds = useMemo(() => {
    if (typeof currentSegment?.duration !== "number") return null;

    const totalCurrentLegFeet = getDistanceAlongPathInFeet(
      currentLegPath,
      0,
      currentLegPath.length - 1
    );
    const remainingCurrentLegFeet = getDistanceAlongPathInFeet(
      currentLegPath,
      currentLegProgressIndex,
      currentLegPath.length - 1
    );
    const remainingCurrentLegRatio =
      totalCurrentLegFeet > 0
        ? Math.min(Math.max(remainingCurrentLegFeet / totalCurrentLegFeet, 0), 1)
        : 1;

    return currentSegment.duration * remainingCurrentLegRatio;
  }, [currentLegPath, currentLegProgressIndex, currentSegment]);
  const etaLabel =
    remainingCurrentLegSeconds === null
      ? null
      : t.etaToNextStop(
          formatEtaTime(
            new Date(currentDateTime.getTime() + remainingCurrentLegSeconds * 1000),
            language
          ),
          Math.max(0, Math.round(remainingCurrentLegSeconds / 60))
        );

  const currentSteps = currentSegment?.steps ?? [];
  const currentLegStartIndex = currentSteps?.[0]?.way_points?.[0] ?? 0;
  const currentFullRouteIndex = currentLegStartIndex + currentLegProgressIndex;

  const currentStep =
    currentSteps.find((step: RouteStep) => {
      const stepStartIndex = step?.way_points?.[0];
      const stepEndIndex = step?.way_points?.[1];

      if (
        typeof stepStartIndex !== "number" ||
        typeof stepEndIndex !== "number"
      ) {
        return false;
      }

      return (
        stepStartIndex <= currentFullRouteIndex &&
        stepEndIndex >= currentFullRouteIndex
      );
    }) ?? null;

  const currentRoadName =
    typeof currentStep?.name === "string" && currentStep.name.trim()
      ? currentStep.name
      : null;

  const nextStep =
    currentSteps.find((step: RouteStep) => {
      const stepEndIndex = step?.way_points?.[1];

      if (typeof stepEndIndex !== "number") return false;

      return stepEndIndex > currentFullRouteIndex;
    }) ?? null;

  const nextTurnInstruction = getStepInstructionText(nextStep);

  const nextTurnEndIndex =
    typeof nextStep?.way_points?.[1] === "number"
      ? nextStep.way_points[1] - currentLegStartIndex
      : null;

  const nextTurnDistanceFeet =
    nextTurnEndIndex !== null && currentLegPath.length > 1
      ? getDistanceAlongPathInFeet(
          currentLegPath,
          currentLegProgressIndex,
          Math.max(currentLegProgressIndex, nextTurnEndIndex)
        )
      : null;

  const nextTurnDistanceLabel =
    nextTurnDistanceFeet === null
      ? ""
      : nextTurnDistanceFeet < 1000
        ? `${Math.round(nextTurnDistanceFeet)} ft`
        : `${(nextTurnDistanceFeet / 5280).toFixed(1)} mi`;

  const nextTurnSpokenDistance =
    nextTurnDistanceFeet === null
      ? ""
      : nextTurnDistanceFeet < 1000
        ? `${Math.round(nextTurnDistanceFeet)} feet`
        : `${(nextTurnDistanceFeet / 5280).toFixed(1)} miles`;

  const distanceFromCurrentLegFeet =
    truckLocation && currentLegPath.length > 1
      ? getDistanceFromPathFeet(truckLocation, currentLegPath)
      : null;

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

  const rerouteCurrentLeg = useCallback(async () => {
    if (!truckLocation || !currentStopCoords || isRerouting) return;

    try {
      setIsRerouting(true);

      const res = await fetch("/api/reroute-leg", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          truckLocation,
          destination: currentStopCoords,
          heading: currentTruckHeadingRef.current,
          language,
        }),
      });

      const data = (await res.json()) as RouteApiResponse;

      if (!res.ok || !data.orsRoute?.routes?.[0]) {
        throw new Error(data.error || "Failed to reroute current leg.");
      }

      const rerouteRoute = data.orsRoute.routes[0];

      const newPath =
        typeof rerouteRoute.geometry === "string"
          ? decodePolyline(rerouteRoute.geometry)
          : rerouteRoute.geometry;

      reroutedLegIndexRef.current = currentLegIndex;
      reroutedLegOriginalSegmentRef.current = currentSegment;
      setCurrentLegPath(newPath);
      setCurrentLegProgressIndex(0);
      setNavigationError("");

      const rerouteSegment = rerouteRoute.segments?.[0];

      if (rerouteSegment) {
        setOrsRoute((prev: AppRoute | null) => {
          if (!prev?.routes?.[0]) return prev;

          const updatedRoutes = [...prev.routes];
          const updatedSegments = [...(updatedRoutes[0].segments || [])];

          updatedSegments[currentLegIndex] = rerouteSegment;

          updatedRoutes[0] = {
            ...updatedRoutes[0],
            segments: updatedSegments,
          };

          return {
            ...prev,
            routes: updatedRoutes,
          };
        });
      }
    } catch (error: unknown) {
      setNavigationError(getErrorMessage(error));
    } finally {
      setIsRerouting(false);
    }
  }, [currentLegIndex, currentSegment, currentStopCoords, isRerouting, language, truckLocation]);

  useEffect(() => {
    if (
      !navigationStarted ||
      navigationPaused ||
      distanceFromCurrentLegFeet === null ||
      distanceFromCurrentLegFeet <= REROUTE_DISTANCE_THRESHOLD_FEET ||
      !truckLocation ||
      !currentStopCoords ||
      isRerouting
    ) {
      return;
    }

    const now = Date.now();

    if (now - lastRerouteAt < REROUTE_COOLDOWN_MS) {
      return;
    }

    const timeout = setTimeout(() => {
      setLastRerouteAt(Date.now());
      rerouteCurrentLeg();
    }, 300);

    return () => clearTimeout(timeout);
  }, [
    navigationStarted,
    navigationPaused,
    distanceFromCurrentLegFeet,
    truckLocation,
    currentStopCoords,
    isRerouting,
    lastRerouteAt,
    rerouteCurrentLeg,
  ]);

  const totalLegs = orsRoute?.routes?.[0]?.segments?.length ?? 0;
  const progressPercent =
    totalLegs > 0 ? Math.min(((currentLegIndex + 1) / totalLegs) * 100, 100) : 0;

  const isOffRoute =
    navigationStarted &&
    !navigationPaused &&
    distanceFromCurrentLegFeet !== null &&
    distanceFromCurrentLegFeet > REROUTE_DISTANCE_THRESHOLD_FEET;

  const routeStatusLabel = isRerouting
    ? t.rerouting
    : isOffRoute
      ? t.offRoute
      : navigationPaused
        ? t.paused
        : navigationStarted
          ? t.onRoute
          : t.routeReady;

  const routeStatusClassName = isRerouting
    ? "bg-amber-100 text-amber-800"
    : isOffRoute
      ? "bg-red-100 text-red-700"
      : navigationPaused
        ? "bg-slate-100 text-slate-700"
        : navigationStarted
          ? "bg-emerald-100 text-emerald-700"
          : "bg-blue-100 text-blue-700";

  useEffect(() => {
    spokenTurnThresholdsRef.current.clear();
    spokenArrivalRef.current = null;
  }, [currentLegIndex, currentStopAddress]);

  useEffect(() => {
    if (
      !navigationStarted ||
      navigationPaused ||
      !nextTurnInstruction ||
      nextTurnDistanceFeet === null
    ) {
      return;
    }

    const thresholds = [
      { id: "one-mile", feet: 5280 },
      { id: "half-mile", feet: 2640 },
      { id: "quarter-mile", feet: 1320 },
      { id: "five-hundred-feet", feet: 500 },
    ];

    const threshold = thresholds.find((item) => {
      const key = `${currentLegIndex}-${item.id}-${nextTurnInstruction}`;
      return nextTurnDistanceFeet <= item.feet && !spokenTurnThresholdsRef.current.has(key);
    });

    if (!threshold) return;

    const key = `${currentLegIndex}-${threshold.id}-${nextTurnInstruction}`;
    spokenTurnThresholdsRef.current.add(key);
    speakPrompt(t.turnPrompt(nextTurnSpokenDistance, nextTurnInstruction));
  }, [
    currentLegIndex,
    navigationPaused,
    navigationStarted,
    nextTurnDistanceFeet,
    nextTurnInstruction,
    nextTurnSpokenDistance,
    speakPrompt,
    t,
  ]);

  useEffect(() => {
    if (!navigationStarted || navigationPaused || !arrivalSuggestionLevel || !currentStopAddress) {
      return;
    }

    const key = `${currentLegIndex}-${currentStopAddress}-${arrivalSuggestionLevel}`;
    if (spokenArrivalRef.current === key) return;

    spokenArrivalRef.current = key;
    speakPrompt(t.closeToAddress(currentStopAddress));
  }, [
    arrivalSuggestionLevel,
    currentLegIndex,
    currentStopAddress,
    navigationPaused,
    navigationStarted,
    speakPrompt,
    t,
  ]);

  const completeDayPlanStop = () => {
    if (!dayPlanStopAddress) return;

    const savedDayPlan = localStorage.getItem(DAY_PLAN_STORAGE_KEY);
    if (!savedDayPlan) return;

    try {
      const parsed = JSON.parse(savedDayPlan) as DayPlanState;
      const completedStopIndex = parsed.routeData.route_order.indexOf(dayPlanStopAddress);
      const remainingStops =
        completedStopIndex === -1
          ? parsed.routeData.route_order
          : parsed.routeData.route_order.filter((_, index) => index !== completedStopIndex);

      if (remainingStops.length === 0) {
        localStorage.removeItem(DAY_PLAN_STORAGE_KEY);
        return;
      }

      localStorage.setItem(
        DAY_PLAN_STORAGE_KEY,
        JSON.stringify({
          ...parsed,
          routeData: {
            ...parsed.routeData,
            route_order: remainingStops,
          },
          activeStopAddress: null,
          needsReoptimization: remainingStops.length > 1,
        } satisfies DayPlanState)
      );
    } catch (error) {
      console.error("Failed to update day plan:", error);
    }
  };

  const finishDayPlanDrive = () => {
    completeDayPlanStop();
    localStorage.removeItem("crewRouteState");
    router.push("/");
  };

  const exitCurrentDrive = () => {
    localStorage.removeItem("crewRouteState");
    router.push("/");
  };

  const completeCurrentDrive = () => {
    if (!window.confirm(t.confirmCompleteRoute)) {
      return;
    }

    if (dayPlanStopAddress) {
      finishDayPlanDrive();
      return;
    }

    exitCurrentDrive();
  };

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-slate-100">
      <div ref={mapContainerRef} className="h-[100dvh] w-full" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 p-2 sm:p-3">
        <div className="pointer-events-auto mx-auto max-w-5xl rounded-2xl border border-white/60 bg-white/85 p-2.5 sm:p-3 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 text-center">
              <div className="truncate text-base font-semibold text-slate-900">
                {currentStopAddress ?? t.returnToStart}
              </div>
              <div className="mt-1 flex items-center justify-center gap-2 text-xs text-slate-500">
                <span>
                  {t.stopProgress(Math.min(currentLegIndex + 1, totalLegs || 1), totalLegs || 0)}
                </span>

                <span className={`rounded-full px-2 py-0.5 font-semibold ${routeStatusClassName}`}>
                  {routeStatusLabel}
                </span>
              </div>
              {etaLabel && (
                <div className="mt-1 text-xs font-semibold text-blue-700">
                  {etaLabel}
                </div>
              )}
            </div>
            <button
              onClick={() => {
                if (!navigationStarted) {
                  setNavigationStarted(true);
                  setNavigationPaused(false);
                  speakPrompt(
                    nextTurnInstruction
                      ? `${t.navigationStarted} ${nextTurnInstruction}${nextTurnSpokenDistance ? ` ${t.inDistance(nextTurnSpokenDistance).toLowerCase()}` : ""}.`
                      : t.navigationStarted
                  );
                } else {
                  setNavigationPaused((prev) => {
                    const nextPaused = !prev;
                    speakPrompt(nextPaused ? t.navigationPaused : t.navigationResumed);
                    return nextPaused;
                  });
                }
              }}
              className="rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            >
              {!navigationStarted ? t.start : navigationPaused ? t.continue : t.pause}
            </button>
            <button
              onClick={() => {
                if (!truckLocation) return;

                if (navigationStarted && currentLegPath.length > 1) {
                  const closestIndex = getClosestPathIndex(truckLocation, currentLegPath);
                  const bearing = getUpcomingPathBearing(currentLegPath, closestIndex);

                  mapRef.current?.flyTo({
                    center: truckLocation,
                    zoom: 17,
                    bearing: bearing ?? 0,
                    pitch: 45,
                  });
                } else {
                  mapRef.current?.flyTo({
                    center: truckLocation,
                    zoom: 14,
                    bearing: 0,
                    pitch: 0,
                  });
                }
              }}
              className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              {t.recenter}
            </button>
            <select
              value={language}
              onChange={(event) => saveAppLanguage(normalizeLanguage(event.target.value))}
              className="rounded-2xl border border-slate-300 bg-white px-2 py-2 text-sm font-semibold text-slate-700 shadow-sm"
            >
              {(["en", "es"] as const).map((option) => (
                <option key={option} value={option}>
                  {languageLabels[option]}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between text-xs font-medium text-slate-500">
              <span>{t.routeProgress}</span>
              <span>{Math.round(progressPercent)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-blue-600 transition-all"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-2 sm:p-3">
        <div className="pointer-events-auto mx-auto max-w-5xl rounded-2xl border border-white/70 bg-white/88 p-2.5 shadow-xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs sm:text-sm">
            <div className="min-w-0 truncate text-slate-700">
              <span className="font-semibold text-slate-900">
                {formatDistanceToNextStop(distanceToCurrentStopFeet)}
              </span>{" "}
              {t.toNextStop}
            </div>
            <div className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-slate-700">
              {truckLocation ? t.gpsOn : t.findingGps}
            </div>
          </div>
          <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                {t.currentRoad}
              </div>
              <div className="mt-1 text-sm font-medium text-slate-900">
                {currentRoadName ?? t.unknownRoad}
              </div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {t.nextTurn}
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900">
              {nextTurnInstruction ?? t.continueCurrentRoad}
            </div>

            {nextTurnDistanceLabel && (
              <div className="mt-1 text-xs font-semibold text-blue-700">
                {t.inDistance(nextTurnDistanceLabel)}
              </div>
            )}
          </div>
          {navigationError && (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              <span>{navigationError}</span>
              <button
                type="button"
                onClick={() => setNavigationError("")}
                className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-0.5 text-xs text-red-700"
              >
                {t.dismiss}
              </button>
            </div>
          )}
          {arrivalSuggestionText && (
            <div className="mb-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
              {arrivalSuggestionText}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => {
                if (
                  distanceToCurrentStopFeet !== null &&
                  distanceToCurrentStopFeet > 250
                ) {
                  const confirmed = window.confirm(
                    t.confirmArrived(Math.round(distanceToCurrentStopFeet))
                  );

                  if (!confirmed) return;
                }

                completeCurrentDrive();
              }}
              disabled={!orsRoute?.routes?.[0]?.segments?.length}
              className={`rounded-2xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition disabled:opacity-50 sm:text-base ${
                arrivalSuggestionText
                  ? "bg-emerald-600 hover:bg-emerald-700"
                  : "bg-orange-600 hover:bg-orange-700"
              }`}
            >
              {t.completeRoute}
            </button>
            <button
              onClick={exitCurrentDrive}
              className="rounded-2xl border border-red-300 bg-white px-4 py-3 text-sm font-semibold text-red-600 shadow-sm transition hover:bg-red-50 sm:text-base"
            >
              {t.cancelDrive}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
