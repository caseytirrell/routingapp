import OpenAI from "openai";
import { NextResponse } from "next/server";
import { decodePolyline } from "@/lib/geo";
import { normalizeLanguage, type AppLanguage } from "@/lib/i18n";
import {
  chooseRouteCandidate as chooseValidatedRouteCandidate,
  createRouteCandidates as createValidatedRouteCandidates,
} from "@/lib/routing-policy";
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
const ORS_SMALL_TRUCK_OPTIONS = {
  vehicle_type: "delivery",
  profile_params: {
    restrictions: {
      height: 2.7,
      width: 2.2,
      length: 8,
      weight: 5,
      axleload: 3,
    },
  },
};

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
  const feature = geoapifyData?.features?.[0];

  if (!feature) {
    throw new Error("Geoapify route response did not include any features.");
  }

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
    routes: [
      {
        geometry: flatGeometry,
        segments,
        distance: properties.distance,
        time: properties.time,
      },
    ],
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

async function getGoogleRoute(coordinates: Coordinate[], language: AppLanguage) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY.");
  }

  if (coordinates.length < 2) {
    throw new Error("Google routing requires an origin and destination.");
  }

  const [originLng, originLat] = coordinates[0];
  const [destinationLng, destinationLat] = coordinates[coordinates.length - 1];
  const intermediates = coordinates.slice(1, -1).map(([longitude, latitude]) => ({
    location: {
      latLng: {
        latitude,
        longitude,
      },
    },
  }));

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
        computeAlternativeRoutes: intermediates.length === 0,
        languageCode: language === "es" ? "es" : "en-US",
        units: "IMPERIAL",
      }),
      cache: "no-store",
    }
  );

  const data = (await response.json()) as GoogleRouteResponse;

  if (!response.ok) {
    throw new Error(
      data.error?.message ||
        data.error?.status ||
        `Google routing failed with status ${response.status}`
    );
  }

  return data;
}

async function getOrsRoute(coordinates: Coordinate[], language: AppLanguage) {
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
        options: ORS_SMALL_TRUCK_OPTIONS,
      }),
      cache: "no-store",
    }
  );

  let data: unknown = null;

  try {
    data = await response.json();
  } catch {
    throw new Error("OpenRouteService response was not valid JSON.");
  }

  if (!response.ok) {
    throw new Error(`OpenRouteService failed with status ${response.status}`);
  }

  return data as AppRoute;
}

async function getGeoapifyRoute(coordinates: [number, number][]) {
  const waypoints = toGeoapifyWaypoints(coordinates);

  const url =
    `https://api.geoapify.com/v1/routing` +
    `?waypoints=${encodeURIComponent(waypoints)}` +
    `&mode=truck` +
    `&details=instruction_details` +
    `&apiKey=${process.env.GEOAPIFY_API_KEY}`;

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });

  const data = (await response.json()) as GeoapifyRouteResponse;

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

      const geoapifyData = await getGeoapifyRoute(orsCoordinates);
      routeData = convertGeoapifyToAppRoute(geoapifyData);
      const selectedRoute = await chooseValidatedRouteCandidate(createValidatedRouteCandidates(routeData, "geoapify", 1), {
        scoreAllCandidates: shouldScoreAllCandidates,
      });
      routeData = selectedRoute.routeData;
      trafficAssessment = selectedRoute.trafficAssessment;
      routeDecision = selectedRoute.routeDecision;
    } else {
      if (!process.env.OPENROUTESERVICE_API_KEY) {
        return jsonError("Missing OPENROUTESERVICE_API_KEY.", 500);
      }

      const [googleResult, orsResult] = await Promise.allSettled([
        isPointToPointRoute
          ? getGoogleRoute(orsCoordinates, language).then(convertGoogleRoutesToAppRoute)
          : Promise.resolve({ routes: [] } as AppRoute),
        getOrsRoute(orsCoordinates, language),
      ]);

      const candidates: RouteCandidateInput[] = [];
      const googleRouteData =
        googleResult.status === "fulfilled" ? googleResult.value : null;
      const orsRouteData = orsResult.status === "fulfilled" ? orsResult.value : null;

      if (googleRouteData) {
        candidates.push(
          ...createValidatedRouteCandidates(googleRouteData, "google", GOOGLE_CANDIDATE_LIMIT)
        );
      } else if (isPointToPointRoute && googleResult.status === "rejected") {
        console.log("Google routing failed:", getErrorMessage(googleResult.reason));
      }

      if (orsRouteData) {
        candidates.push(...createValidatedRouteCandidates(orsRouteData, "ors", 1));
      } else if (orsResult.status === "rejected") {
        console.log("ORS routing failed:", getErrorMessage(orsResult.reason));
      }

      if (candidates.length === 0) {
        if (!process.env.GEOAPIFY_API_KEY) {
          const googleError =
            googleResult.status === "rejected"
              ? getErrorMessage(googleResult.reason)
              : "Google returned no route candidates.";
          const orsError =
            orsResult.status === "rejected"
              ? getErrorMessage(orsResult.reason)
              : "OpenRouteService returned no route candidates.";

          return jsonError(
            `No route candidates were available. Google: ${googleError} ORS: ${orsError}`,
            500
          );
        }

        console.log("Google/ORS failed, falling back to Geoapify...");
        const geoapifyData = await getGeoapifyRoute(orsCoordinates);

        console.log("GEOAPIFY FALLBACK SUMMARY:", {
          featureCount: geoapifyData?.features?.length ?? 0,
          legCount: geoapifyData?.features?.[0]?.properties?.legs?.length ?? 0,
          distance: geoapifyData?.features?.[0]?.properties?.distance ?? null,
          time: geoapifyData?.features?.[0]?.properties?.time ?? null,
        });

        const convertedRouteData = convertGeoapifyToAppRoute(geoapifyData);
        const selectedRoute = await chooseValidatedRouteCandidate(createValidatedRouteCandidates(convertedRouteData, "geoapify", 1), {
          scoreAllCandidates: shouldScoreAllCandidates,
        });
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;
        routeDecision = selectedRoute.routeDecision;

        console.log(
          "GEOAPIFY CONVERTED GEOMETRY LENGTH:",
          Array.isArray(convertedRouteData.routes[0]?.geometry)
            ? convertedRouteData.routes[0].geometry.length
            : "not-array"
        );

        console.log(
          "GEOAPIFY CONVERTED SEGMENTS LENGTH:",
          Array.isArray(convertedRouteData.routes[0]?.segments)
            ? convertedRouteData.routes[0].segments.length
            : "no-segments"
        );

        console.log(
          "GEOAPIFY FIRST SEGMENT FIRST STEP:",
          convertedRouteData.routes[0]?.segments?.[0]?.steps?.[0] || "no-step"
        );
      } else {
        const selectedRoute = await chooseValidatedRouteCandidate(candidates, {
          scoreAllCandidates: shouldScoreAllCandidates,
        });
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;
        routeDecision = selectedRoute.routeDecision;
      }
    }

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
