import OpenAI from "openai";
import { NextResponse } from "next/server";
import { decodePolyline } from "@/lib/geo";
import { normalizeLanguage, type AppLanguage } from "@/lib/i18n";
import { withProviderTimeout } from "@/lib/provider-timeouts";
import {
  annotateRouteTrafficSections,
  chooseRouteCandidate as chooseValidatedRouteCandidate,
  createRouteCandidates as createValidatedRouteCandidates,
} from "@/lib/routing-policy";
import {
  GEOAPIFY_TRUCK_MODE,
  TOMTOM_TRUCK_QUERY_PARAMS,
  TRAILER_FRIENDLY_ORS_OPTIONS,
} from "@/lib/vehicle-profile";
import type {
  AppRoute,
  Coordinate,
  Route,
  RouteDecisionCandidate,
  RouteDecisionReport,
  RouteStopInput,
  TrafficAssessment,
} from "@/lib/route-types";
import { NURSERY_ADDRESS, normalizeAddress, startCoordsMap } from "@/lib/stops";

const USE_GEOAPIFY_ROUTING = false;
const GOOGLE_CANDIDATE_LIMIT = 2;
const ORS_CANDIDATE_LIMIT = 2;
const GEOAPIFY_FALLBACK_ROUTE_TYPE = "less_maneuvers";
const NORTHBOUND_CORRIDOR_DESTINATION_LATITUDE = 40.55;
const EASTERN_NORTHBOUND_CORRIDOR_MIN_LATITUDE = 40.6;
const EASTERN_NORTHBOUND_CORRIDOR_MIN_LONGITUDE = -74.43;
const EASTERN_NORTHBOUND_CORRIDOR_MAX_EXTRA_SECONDS = 25 * 60;
const ROUTE_34_ROUTE_9_CORRIDOR_LABEL = "Route 34 / Route 9 / Route 1-82 corridor";

const NORTHERN_CORRIDORS = [
  {
    id: "route-34-route-9",
    label: ROUTE_34_ROUTE_9_CORRIDOR_LABEL,
    waypoints: [[-74.248, 40.6895]] as Coordinate[],
    routeModifiers: {
      avoidHighways: true,
    },
  },
];

function isEasternNorthboundDestination(destination: Coordinate | undefined) {
  return (
    !!destination &&
    destination[1] >= EASTERN_NORTHBOUND_CORRIDOR_MIN_LATITUDE &&
    destination[0] >= EASTERN_NORTHBOUND_CORRIDOR_MIN_LONGITUDE
  );
}

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  return new OpenAI({ apiKey });
}

type GeoapifyStep = {
  instruction?: {
    text?: string;
  };
  distance?: number;
  time?: number;
  from_index?: number;
  to_index?: number;
};

type GeoapifyLeg = {
  distance?: number;
  time?: number;
  steps?: GeoapifyStep[];
};

type GeoapifyRouteResponse = {
  features?: {
    geometry?: {
      coordinates?: Coordinate[][];
    };
    properties?: {
      distance?: number;
      time?: number;
      legs?: GeoapifyLeg[];
    };
  }[];
  error?: string;
};

type OptimizedRouteOutput = {
  route_order: string[];
  reason: string;
};

type GoogleRouteStep = {
  distanceMeters?: number;
  staticDuration?: string;
  localizedValues?: {
    distance?: {
      text?: string;
    };
    staticDuration?: {
      text?: string;
    };
  };
  polyline?: {
    encodedPolyline?: string;
  };
  navigationInstruction?: {
    instructions?: string;
  };
};

type GoogleRouteLeg = {
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  polyline?: {
    encodedPolyline?: string;
  };
  steps?: GoogleRouteStep[];
};

type GoogleRoute = {
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  polyline?: {
    encodedPolyline?: string;
  };
  legs?: GoogleRouteLeg[];
};

type GoogleRouteResponse = {
  routes?: GoogleRoute[];
  error?: {
    message?: string;
    status?: string;
  };
};

type GoogleRouteModifiers = {
  avoidTolls?: boolean;
  avoidHighways?: boolean;
};

type TomTomPoint = {
  latitude: number;
  longitude: number;
};

type TomTomGuidanceInstruction = {
  message?: string;
  routeOffsetInMeters?: number;
  travelTimeInSeconds?: number;
  point?: TomTomPoint;
  pointIndex?: number;
};

type TomTomRoute = {
  summary?: {
    lengthInMeters?: number;
    travelTimeInSeconds?: number;
  };
  legs?: {
    summary?: {
      lengthInMeters?: number;
      travelTimeInSeconds?: number;
    };
    points?: TomTomPoint[];
  }[];
  guidance?: {
    instructions?: TomTomGuidanceInstruction[];
  };
};

type TomTomRouteResponse = {
  routes?: TomTomRoute[];
  detailedError?: {
    message?: string;
  };
  error?: string;
};

type RouteCandidateInput = {
  route: Route;
  provider: RouteDecisionCandidate["provider"];
  label: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toGeoapifyWaypoints(coordinates: [number, number][]) {
  return coordinates.map(([lon, lat]) => `${lat},${lon}`).join("|");
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

function getNorthernCorridorsForRoute(coordinates: Coordinate[]) {
  const destination = coordinates[coordinates.length - 1];

  if (!destination || destination[1] < NORTHBOUND_CORRIDOR_DESTINATION_LATITUDE) {
    return [];
  }

  return NORTHERN_CORRIDORS;
}

function getSelectionPreferenceForRoute(coordinates: Coordinate[]) {
  const destination = coordinates[coordinates.length - 1];

  if (isEasternNorthboundDestination(destination)) {
    return {
      labelIncludes: [ROUTE_34_ROUTE_9_CORRIDOR_LABEL],
      maxExtraSeconds: EASTERN_NORTHBOUND_CORRIDOR_MAX_EXTRA_SECONDS,
      reason:
        "Selected the Route 34 / Route 9 / Route 1-82 corridor because this eastern northbound destination is in the Short Hills/Summit/Springfield corridor zone and the route was commercially valid within the allowed ETA tolerance.",
    };
  }

  return undefined;
}

function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;

  const match = value.match(/^(\d+(?:\.\d+)?)s$/);

  if (!match) return null;

  return Math.round(Number(match[1]));
}

function isCoordinate(value: unknown): value is Coordinate {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function parseStops(value: unknown): RouteStopInput[] {
  if (!Array.isArray(value)) {
    throw new Error("Stops must be an array.");
  }

  if (value.length === 0) {
    throw new Error("Select at least one stop before optimizing.");
  }

  return value.map((stop, index) => {
    if (
      !stop ||
      typeof stop !== "object" ||
      typeof (stop as { address?: unknown }).address !== "string" ||
      !(stop as { address: string }).address.trim() ||
      !isCoordinate((stop as { coords?: unknown }).coords)
    ) {
      throw new Error(`Stop ${index + 1} is missing a valid address or coordinate.`);
    }

    return {
      address: (stop as { address: string }).address.trim(),
      coords: (stop as { coords: Coordinate }).coords,
    };
  });
}

function parseOptionalCoordinate(value: unknown, label: string): Coordinate | undefined {
  if (value === undefined || value === null) return undefined;

  if (!isCoordinate(value)) {
    throw new Error(`${label} must be a valid [longitude, latitude] coordinate.`);
  }

  return value;
}

function getCanonicalRouteOrder(
  candidateOrder: unknown,
  stops: RouteStopInput[]
): string[] | null {
  if (!Array.isArray(candidateOrder)) return null;

  const available = new Map<string, string[]>();

  stops.forEach((stop) => {
    const key = normalizeAddress(stop.address);
    available.set(key, [...(available.get(key) ?? []), stop.address]);
  });

  const resolvedOrder: string[] = [];

  for (const item of candidateOrder) {
    if (typeof item !== "string") return null;

    const key = normalizeAddress(item);
    const matches = available.get(key);

    if (!matches?.length) return null;

    resolvedOrder.push(matches.shift()!);
  }

  const allStopsUsed = [...available.values()].every((matches) => matches.length === 0);

  return allStopsUsed && resolvedOrder.length === stops.length ? resolvedOrder : null;
}

function convertGeoapifyToAppRoute(geoapifyData: GeoapifyRouteResponse): AppRoute {
  const features = geoapifyData?.features ?? [];

  if (features.length === 0) {
    throw new Error("Geoapify route response did not include any features.");
  }

  return {
    routes: features.map((feature) => {
      const legLines = feature.geometry?.coordinates || [];
      const properties = feature.properties || {};
      const legs = properties.legs || [];
      const flatGeometry: Coordinate[] = legLines.flat();

      let geometryOffset = 0;

      const segments = legs.map((leg, legIndex) => {
        const legGeometry = legLines[legIndex] || [];
        const legLength = legGeometry.length;

        const steps = (leg.steps || []).map((step) => ({
          name: step.instruction?.text || "",
          distance: step.distance ?? 0,
          duration: step.time ?? 0,
          way_points: [
            geometryOffset + (step.from_index ?? 0),
            geometryOffset + (step.to_index ?? 0),
          ] as [number, number],
        }));

        const segment = {
          distance: leg.distance ?? 0,
          duration: leg.time ?? 0,
          steps:
            steps.length > 0
              ? steps
              : [
                  {
                    name: "",
                    distance: leg.distance ?? 0,
                    duration: leg.time ?? 0,
                    way_points: [
                      geometryOffset,
                      geometryOffset + Math.max(legLength - 1, 0),
                    ] as [number, number],
                  },
                ],
        };

        geometryOffset += legLength;
        return segment;
      });

      return {
        geometry: flatGeometry,
        segments,
        distance: properties.distance,
        time: properties.time,
      };
    }),
  };
}

function appendGeometry(target: Coordinate[], geometry: Coordinate[]) {
  geometry.forEach((coordinate, index) => {
    const previous = target[target.length - 1];

    if (
      index === 0 &&
      previous &&
      previous[0] === coordinate[0] &&
      previous[1] === coordinate[1]
    ) {
      return;
    }

    target.push(coordinate);
  });
}

function convertGoogleRoutesToAppRoute(googleData: GoogleRouteResponse): AppRoute {
  const routes = googleData.routes ?? [];

  return {
    routes: routes.slice(0, GOOGLE_CANDIDATE_LIMIT).map((route) => {
      const fallbackGeometry = route.polyline?.encodedPolyline
        ? decodePolyline(route.polyline.encodedPolyline)
        : [];
      const fullGeometry: Coordinate[] = [];
      const segments = (route.legs ?? []).map((leg) => {
        const legGeometry: Coordinate[] = [];
        const steps = (leg.steps ?? []).map((step) => {
          const stepGeometry = step.polyline?.encodedPolyline
            ? decodePolyline(step.polyline.encodedPolyline)
            : [];
          const startIndex = fullGeometry.length + legGeometry.length;

          appendGeometry(legGeometry, stepGeometry);

          return {
            instruction: step.navigationInstruction?.instructions ?? "",
            name: step.navigationInstruction?.instructions ?? "",
            distance: step.distanceMeters ?? 0,
            duration: parseDurationSeconds(step.staticDuration) ?? 0,
            way_points: [
              startIndex,
              fullGeometry.length + Math.max(legGeometry.length - 1, 0),
            ] as [number, number],
          };
        });

        if (legGeometry.length === 0 && leg.polyline?.encodedPolyline) {
          appendGeometry(legGeometry, decodePolyline(leg.polyline.encodedPolyline));
        }

        const segmentStartIndex = fullGeometry.length;
        appendGeometry(fullGeometry, legGeometry);
        const segmentEndIndex = Math.max(fullGeometry.length - 1, segmentStartIndex);

        return {
          distance: leg.distanceMeters ?? 0,
          duration:
            parseDurationSeconds(leg.duration) ??
            parseDurationSeconds(leg.staticDuration) ??
            0,
          steps:
            steps.length > 0
              ? steps
              : [
                  {
                    name: "",
                    distance: leg.distanceMeters ?? 0,
                    duration:
                      parseDurationSeconds(leg.duration) ??
                      parseDurationSeconds(leg.staticDuration) ??
                      0,
                    way_points: [segmentStartIndex, segmentEndIndex] as [number, number],
                  },
                ],
        };
      });

      const geometry = fullGeometry.length > 0 ? fullGeometry : fallbackGeometry;
      const durationSeconds =
        parseDurationSeconds(route.duration) ??
        parseDurationSeconds(route.staticDuration) ??
        undefined;

      return {
        geometry,
        segments,
        distance: route.distanceMeters,
        duration: durationSeconds,
      };
    }),
  };
}

function getClosestGeometryIndex(point: Coordinate, geometry: Coordinate[]) {
  if (geometry.length === 0) return 0;

  let closestIndex = 0;
  let closestDistance = Infinity;

  for (let index = 0; index < geometry.length; index++) {
    const [longitude, latitude] = geometry[index];
    const distance =
      Math.abs(longitude - point[0]) + Math.abs(latitude - point[1]);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }

  return closestIndex;
}

function convertTomTomRoutesToAppRoute(tomTomData: TomTomRouteResponse): AppRoute {
  return {
    routes: (tomTomData.routes ?? []).slice(0, 1).map((route) => {
      const geometry: Coordinate[] = [];
      const segments = (route.legs ?? []).map((leg) => {
        const segmentStartIndex = geometry.length;
        const legGeometry = (leg.points ?? []).map(
          (point) => [point.longitude, point.latitude] as Coordinate
        );

        appendGeometry(geometry, legGeometry);

        return {
          distance: leg.summary?.lengthInMeters ?? route.summary?.lengthInMeters ?? 0,
          duration:
            leg.summary?.travelTimeInSeconds ??
            route.summary?.travelTimeInSeconds ??
            0,
          steps: [
            {
              name: "",
              distance:
                leg.summary?.lengthInMeters ?? route.summary?.lengthInMeters ?? 0,
              duration:
                leg.summary?.travelTimeInSeconds ??
                route.summary?.travelTimeInSeconds ??
                0,
              way_points: [
                segmentStartIndex,
                Math.max(geometry.length - 1, segmentStartIndex),
              ] as [number, number],
            },
          ],
        };
      });

      const instructionSteps = (route.guidance?.instructions ?? [])
        .map((instruction, index, instructions) => {
          const pointIndex =
            typeof instruction.pointIndex === "number"
              ? instruction.pointIndex
              : instruction.point
                ? getClosestGeometryIndex(
                    [instruction.point.longitude, instruction.point.latitude],
                    geometry
                  )
                : 0;
          const nextInstruction = instructions[index + 1];
          const nextPointIndex =
            typeof nextInstruction?.pointIndex === "number"
              ? nextInstruction.pointIndex
              : nextInstruction?.point
                ? getClosestGeometryIndex(
                    [nextInstruction.point.longitude, nextInstruction.point.latitude],
                    geometry
                  )
                : geometry.length - 1;

          return {
            instruction: instruction.message ?? "",
            name: instruction.message ?? "",
            distance: instruction.routeOffsetInMeters ?? 0,
            duration: instruction.travelTimeInSeconds ?? 0,
            way_points: [
              Math.max(0, Math.min(pointIndex, geometry.length - 1)),
              Math.max(0, Math.min(nextPointIndex, geometry.length - 1)),
            ] as [number, number],
          };
        })
        .filter((step) => step.name || step.instruction);

      if (instructionSteps.length > 0) {
        segments[0] = {
          ...(segments[0] ?? {
            distance: route.summary?.lengthInMeters ?? 0,
            duration: route.summary?.travelTimeInSeconds ?? 0,
          }),
          steps: instructionSteps,
        };
      }

      return {
        geometry,
        segments,
        distance: route.summary?.lengthInMeters,
        duration: route.summary?.travelTimeInSeconds,
      };
    }),
  };
}

async function getGoogleRoute(
  coordinates: Coordinate[],
  language: AppLanguage,
  options: {
    routeModifiers?: GoogleRouteModifiers;
    computeAlternativeRoutes?: boolean;
    corridorWaypoints?: Coordinate[];
  } = {}
) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY.");
  }

  if (coordinates.length < 2) {
    throw new Error("Google routing requires an origin and destination.");
  }

  const [originLng, originLat] = coordinates[0];
  const [destinationLng, destinationLat] = coordinates[coordinates.length - 1];
  const stopIntermediates = coordinates.slice(1, -1).map(([longitude, latitude]) => ({
    location: {
      latLng: {
        latitude,
        longitude,
      },
    },
  }));
  const corridorIntermediates = (options.corridorWaypoints ?? []).map(
    ([longitude, latitude]) => ({
      location: {
        latLng: {
          latitude,
          longitude,
        },
      },
      via: true,
    })
  );
  const intermediates = [...stopIntermediates, ...corridorIntermediates];

  const { response, data } = await withProviderTimeout("google", async (signal) => {
    const response = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.staticDuration,routes.legs.distanceMeters,routes.legs.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.navigationInstruction.instructions",
        },
        body: JSON.stringify({
          origin: {
            location: {
              latLng: {
                latitude: originLat,
                longitude: originLng,
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: destinationLat,
                longitude: destinationLng,
              },
            },
          },
          ...(intermediates.length > 0 ? { intermediates } : {}),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          computeAlternativeRoutes:
            options.computeAlternativeRoutes ?? intermediates.length === 0,
          ...(options.routeModifiers ? { routeModifiers: options.routeModifiers } : {}),
          languageCode: language === "es" ? "es" : "en-US",
          units: "IMPERIAL",
        }),
        cache: "no-store",
        signal,
      }
    );
    const data = (await response.json()) as GoogleRouteResponse;

    return { response, data };
  });

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        data.error?.status ||
        `Google routing failed with status ${response.status}`
    );
  }

  return data;
}

async function getTomTomRoute(coordinates: Coordinate[], language: AppLanguage) {
  const apiKey = process.env.TOMTOM_API_KEY;

  if (!apiKey) {
    throw new Error("Missing TOMTOM_API_KEY.");
  }

  if (coordinates.length < 2) {
    throw new Error("TomTom routing requires an origin and destination.");
  }

  const locations = coordinates
    .map(([longitude, latitude]) => `${latitude},${longitude}`)
    .join(":");
  const query = new URLSearchParams({
    key: apiKey,
    traffic: "true",
    routeRepresentation: "polyline",
    computeTravelTimeFor: "all",
    instructionsType: "text",
    language: language === "es" ? "es-MX" : "en-US",
    ...TOMTOM_TRUCK_QUERY_PARAMS,
  });

  const { response, data } = await withProviderTimeout("tomtom", async (signal) => {
    const response = await fetch(
      `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?${query}`,
      {
        method: "GET",
        cache: "no-store",
        signal,
      }
    );
    const data = (await response.json()) as TomTomRouteResponse;

    return { response, data };
  });

  if (!response.ok) {
    throw new Error(
      data.detailedError?.message ||
        data.error ||
        `TomTom routing failed with status ${response.status}`
    );
  }

  return data;
}

async function getOrsRoute(
  coordinates: Coordinate[],
  language: AppLanguage,
  candidateLimit: number
) {
  const { response, data } = await withProviderTimeout("ors", async (signal) => {
    const response = await fetch(
      "https://api.heigit.org/openrouteservice/v2/directions/driving-hgv",
      {
        method: "POST",
        headers: {
          Authorization: process.env.OPENROUTESERVICE_API_KEY || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          coordinates,
          language,
          options: TRAILER_FRIENDLY_ORS_OPTIONS,
          ...(candidateLimit > 1
            ? {
                alternative_routes: {
                  target_count: candidateLimit,
                  share_factor: 0.6,
                  weight_factor: 1.4,
                },
              }
            : {}),
        }),
        cache: "no-store",
        signal,
      }
    );

    let data: unknown = null;

    try {
      data = await response.json();
    } catch {
      throw new Error("OpenRouteService response was not valid JSON.");
    }

    return { response, data };
  });

  if (!response.ok) {
    throw new Error(`OpenRouteService failed with status ${response.status}`);
  }

  return data as AppRoute;
}

async function getGeoapifyRoute(
  coordinates: [number, number][],
  routeType = GEOAPIFY_FALLBACK_ROUTE_TYPE
) {
  const waypoints = toGeoapifyWaypoints(coordinates);

  const url =
    `https://api.geoapify.com/v1/routing` +
    `?waypoints=${encodeURIComponent(waypoints)}` +
    `&mode=${GEOAPIFY_TRUCK_MODE}` +
    `&type=${routeType}` +
    `&details=instruction_details` +
    `&traffic=approximated` +
    `&apiKey=${process.env.GEOAPIFY_API_KEY}`;

  const { response, data } = await withProviderTimeout("geoapify", async (signal) => {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal,
    });
    const data = (await response.json()) as GeoapifyRouteResponse;

    return { response, data };
  });

  if (!response.ok) {
    throw new Error(data?.error || `Geoapify routing failed with status ${response.status}`);
  }

  return data;
}

function separateConsecutiveDuplicateStops(stops: string[]) {
  const result = [...stops];

  let changed = true;

  while (changed) {
    changed = false;

    for (let i = 0; i < result.length - 1; i++) {
      if (result[i] === result[i + 1]) {
        const swapIndex = result.findIndex(
          (stop, index) => index > i + 1 && stop !== result[i]
        );

        if (swapIndex !== -1) {
          [result[i + 1], result[swapIndex]] = [result[swapIndex], result[i + 1]];
          changed = true;
        }
      }
    }
  }

  return result;
}

function enforceNurseryPlacement(
  optimizedStops: string[],
  originalStops: { address: string; coords: [number, number] }[],
  nurseryAddress: string
) {
  const result = [...optimizedStops];

  const nurseryCount = originalStops.filter(
    (stop) => stop.address === nurseryAddress
  ).length;

  if (nurseryCount !== 1) {
    return result;
  }

  const nurseryOriginalIndex = originalStops.findIndex(
    (stop) => stop.address === nurseryAddress
  );

  if (nurseryOriginalIndex <= 0) {
    return result;
  }

  const previousStopAddress = originalStops[nurseryOriginalIndex - 1].address;

  const nurseryIndex = result.findIndex((address) => address === nurseryAddress);
  const previousIndex = result.findIndex((address) => address === previousStopAddress);

  if (nurseryIndex === -1 || previousIndex === -1) {
    return result;
  }

  if (nurseryIndex === previousIndex + 1) {
    return result;
  }

  result.splice(nurseryIndex, 1);

  const updatedPreviousIndex = result.findIndex(
    (address) => address === previousStopAddress
  );

  if (updatedPreviousIndex !== -1) {
    result.splice(updatedPreviousIndex + 1, 0, nurseryAddress);
  }

  return result;
}


export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      date,
      time,
      start,
      stops: rawStops,
      startCoords,
      originCoords,
      returnCoords,
      returnToStart = true,
      preserveOrder = false,
      includeDecisionReport = false,
      language: rawLanguage,
    } = body as {
      date: string;
      time: string;
      start: string;
      stops?: unknown;
      startCoords?: unknown;
      originCoords?: unknown;
      returnCoords?: unknown;
      returnToStart?: boolean;
      preserveOrder?: boolean;
      includeDecisionReport?: boolean;
      language?: unknown;
    };
    const language = normalizeLanguage(rawLanguage);

    if (typeof start !== "string" || !start.trim()) {
      return jsonError("Start location is required.", 400);
    }

    let stops: RouteStopInput[];
    let parsedStartCoords: Coordinate | undefined;
    let parsedOriginCoords: Coordinate | undefined;
    let parsedReturnCoords: Coordinate | undefined;

    try {
      stops = parseStops(rawStops);
      parsedStartCoords = parseOptionalCoordinate(startCoords, "startCoords");
      parsedOriginCoords = parseOptionalCoordinate(originCoords, "originCoords");
      parsedReturnCoords = parseOptionalCoordinate(returnCoords, "returnCoords");
    } catch (error: unknown) {
      return jsonError(getErrorMessage(error), 400);
    }

    const stopsList = stops
      .map(
        (stop) =>
          `- ${stop.address} (coords: ${stop.coords[1]}, ${stop.coords[0]})`
      )
      .join("\n");

    let parsedOutput: OptimizedRouteOutput;

    if (preserveOrder) {
      parsedOutput = {
        route_order: stops.map((stop) => stop.address),
        reason: "Manual route order selected by user.",
      };
    } else {
      let client: OpenAI;

      try {
        client = getOpenAIClient();
      } catch (error: unknown) {
        return jsonError(getErrorMessage(error), 500);
      }

      const response = await client.responses.create({
        model: "gpt-5.4-mini",
        input: `
                You are a route optimizer for a landscaping crew. Given a start location and a list of stop addresses, return the most practical route order.
                Treat the stops as an unordered set. Choose the most practical route order.
                It is okay to return the same order as the input only if that is truly the best route.

                Consider only:
                - time of day
                - weather
                - typical traffic patterns
                - geographic efficiency
                - avoiding backtracking
                - Return time and traffic to Starting Address
                - Police Activity
                - Bridge Clearances

                Do not consider service time.
                Keep the response minimal.

                Return valid JSON in this format only:
                {
                  "route_order": [
                    "address 1",
                    "address 2",
                    "address 3"
                  ],
                  "reason": "short explanation"
                }

                Data:
                Date: ${date}
                Time: ${time}
                Start: ${start}
                Stops:
                ${stopsList}`,
      });

      parsedOutput = JSON.parse(response.output_text) as OptimizedRouteOutput;
    }

    const canonicalOrder = getCanonicalRouteOrder(parsedOutput.route_order, stops);
    const optimizedStops = enforceNurseryPlacement(
      separateConsecutiveDuplicateStops(canonicalOrder ?? stops.map((stop) => stop.address)),
      stops,
      NURSERY_ADDRESS
    );

    parsedOutput.route_order = optimizedStops;

    if (!canonicalOrder && !preserveOrder) {
      parsedOutput.reason =
        "Used the selected stop order because the optimizer returned an invalid stop list.";
    }

    const stopMap = new Map(
      stops.map((stop) => [
        normalizeAddress(stop.address),
        stop.coords,
      ])
    );

    const mappedStartCoords = startCoordsMap.get(start);
    const resolvedOriginCoords = parsedOriginCoords ?? parsedStartCoords ?? mappedStartCoords;
    const resolvedReturnCoords = parsedReturnCoords ?? mappedStartCoords ?? parsedStartCoords;

    if (!resolvedOriginCoords) {
      return jsonError(`Missing coordinates for start location: ${start}`, 400);
    }

    if (returnToStart && !resolvedReturnCoords) {
      return jsonError(`Missing return coordinates for start location: ${start}`, 400);
    }

    const orsCoordinates = [
      resolvedOriginCoords,
      ...optimizedStops.map((address: string) => {
        const coords = stopMap.get(normalizeAddress(address));
        if (!coords) {
          throw new Error(`Missing coordinates for stop: ${address}`);
        }
        return coords;
      }),
      ...(returnToStart ? [resolvedReturnCoords as Coordinate] : []),
    ];

    console.log("ORS coordinates:", orsCoordinates);

    let routeData: AppRoute;
    let trafficAssessment: TrafficAssessment;
    let routeDecision: RouteDecisionReport;
    const isPointToPointRoute = !returnToStart && orsCoordinates.length === 2;
    const shouldScoreAllCandidates = includeDecisionReport || isPointToPointRoute;

    if (USE_GEOAPIFY_ROUTING) {
      if (!process.env.GEOAPIFY_API_KEY) {
        return jsonError("Missing GEOAPIFY_API_KEY.", 500);
      }

      const geoapifyData = await getGeoapifyRoute(
        orsCoordinates,
        GEOAPIFY_FALLBACK_ROUTE_TYPE
      );
      routeData = convertGeoapifyToAppRoute(geoapifyData);
      const selectedRoute = await chooseValidatedRouteCandidate(createValidatedRouteCandidates(routeData, "geoapify", 1), {
        scoreAllCandidates: shouldScoreAllCandidates,
      });
      routeData = selectedRoute.routeData;
      trafficAssessment = selectedRoute.trafficAssessment;
      routeDecision = selectedRoute.routeDecision;
    } else {
      if (
        !process.env.GOOGLE_MAPS_API_KEY &&
        !process.env.GEOAPIFY_API_KEY &&
        !process.env.OPENROUTESERVICE_API_KEY &&
        !process.env.TOMTOM_API_KEY
      ) {
        return jsonError("Missing routing API keys.", 500);
      }

      const northernCorridors = isPointToPointRoute
        ? getNorthernCorridorsForRoute(orsCoordinates)
        : [];
      const corridorResults = await Promise.allSettled(
        northernCorridors.map((corridor) =>
          process.env.GOOGLE_MAPS_API_KEY
            ? getGoogleRoute(orsCoordinates, language, {
                corridorWaypoints: corridor.waypoints,
                routeModifiers: corridor.routeModifiers,
                computeAlternativeRoutes: false,
              })
                .then(convertGoogleRoutesToAppRoute)
                .then((routeData) => ({ corridor, routeData }))
            : Promise.resolve({ corridor, routeData: { routes: [] } as AppRoute })
        )
      );
      const [googleResult, orsResult, tomTomResult] = await Promise.allSettled([
        process.env.GOOGLE_MAPS_API_KEY
          ? getGoogleRoute(orsCoordinates, language).then(convertGoogleRoutesToAppRoute)
          : Promise.resolve({ routes: [] } as AppRoute),
        process.env.OPENROUTESERVICE_API_KEY
          ? getOrsRoute(
              orsCoordinates,
              language,
              isPointToPointRoute ? ORS_CANDIDATE_LIMIT : 1
            )
          : Promise.resolve({ routes: [] } as AppRoute),
        process.env.TOMTOM_API_KEY
          ? getTomTomRoute(orsCoordinates, language).then(convertTomTomRoutesToAppRoute)
          : Promise.resolve({ routes: [] } as AppRoute),
      ]);

      const candidates: RouteCandidateInput[] = [];
      const googleRouteData =
        googleResult.status === "fulfilled" ? googleResult.value : null;
      const orsRouteData = orsResult.status === "fulfilled" ? orsResult.value : null;
      const tomTomRouteData =
        tomTomResult.status === "fulfilled" ? tomTomResult.value : null;

      if (googleRouteData) {
        candidates.push(
          ...createValidatedRouteCandidates(
            googleRouteData,
            "google",
            isPointToPointRoute ? GOOGLE_CANDIDATE_LIMIT : 1
          )
        );
      } else if (googleResult.status === "rejected") {
        console.log("Google routing failed:", getErrorMessage(googleResult.reason));
      }

      corridorResults.forEach((result) => {
        if (result.status === "fulfilled") {
          candidates.push(
            ...createValidatedRouteCandidates(result.value.routeData, "google", 1).map(
              (candidate) => ({
                ...candidate,
                label: `Google ${result.value.corridor.label}`,
              })
            )
          );
          return;
        }

        console.log("Google northern corridor routing failed:", getErrorMessage(result.reason));
      });

      if (orsRouteData) {
        candidates.push(
          ...createValidatedRouteCandidates(
            orsRouteData,
            "ors",
            isPointToPointRoute ? ORS_CANDIDATE_LIMIT : 1
          )
        );
      } else if (orsResult.status === "rejected") {
        console.log("ORS routing failed:", getErrorMessage(orsResult.reason));
      }

      if (tomTomRouteData) {
        candidates.push(...createValidatedRouteCandidates(tomTomRouteData, "tomtom", 1));
      } else if (tomTomResult.status === "rejected") {
        console.log("TomTom routing failed:", getErrorMessage(tomTomResult.reason));
      }

      if (candidates.length === 0) {
        const googleError =
          googleResult.status === "rejected"
            ? getErrorMessage(googleResult.reason)
            : "Google returned no route candidates.";
        const orsError =
          orsResult.status === "rejected"
            ? getErrorMessage(orsResult.reason)
            : "OpenRouteService returned no route candidates.";
        const tomTomError =
          tomTomResult.status === "rejected"
            ? getErrorMessage(tomTomResult.reason)
            : "TomTom returned no route candidates.";

        if (!process.env.GEOAPIFY_API_KEY) {
          return jsonError(
            `No route candidates were available. Google: ${googleError} ORS: ${orsError} TomTom: ${tomTomError}`,
            500
          );
        }

        console.log("Google/ORS/TomTom failed, falling back to Geoapify...");
        const geoapifyData = await getGeoapifyRoute(
          orsCoordinates,
          GEOAPIFY_FALLBACK_ROUTE_TYPE
        );
        const convertedRouteData = convertGeoapifyToAppRoute(geoapifyData);
        const selectedRoute = await chooseValidatedRouteCandidate(
          createValidatedRouteCandidates(convertedRouteData, "geoapify", 1),
          {
            scoreAllCandidates: shouldScoreAllCandidates,
          }
        );
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;
        routeDecision = selectedRoute.routeDecision;
      } else {
        const selectedRoute = await chooseValidatedRouteCandidate(candidates, {
          scoreAllCandidates: shouldScoreAllCandidates,
          selectionPreference: isPointToPointRoute
            ? getSelectionPreferenceForRoute(orsCoordinates)
            : undefined,
        });
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;
        routeDecision = selectedRoute.routeDecision;
      }
    }

    routeData = await annotateRouteTrafficSections(routeData);

    return NextResponse.json({
      success: true,
      output: parsedOutput,
      orsRoute: routeData,
      trafficAssessment,
      routeDecision,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error),
      },
      { status: 500 }
    );
  }  
}
