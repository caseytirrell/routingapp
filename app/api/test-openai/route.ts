import OpenAI from "openai";
import { NextResponse } from "next/server";
import { decodePolyline } from "@/lib/geo";
import type {
  AppRoute,
  Coordinate,
  Route,
  RouteStopInput,
  TrafficAssessment,
} from "@/lib/route-types";
import { NURSERY_ADDRESS, normalizeAddress, startCoordsMap } from "@/lib/stops";

const USE_GEOAPIFY_ROUTING = false;
const TOMTOM_TRAFFIC_THRESHOLD_RATIO = 0.25;
const TOMTOM_MAX_SUPPORTING_POINTS = 100;

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

type TomTomRouteSummary = {
  lengthInMeters?: number;
  travelTimeInSeconds?: number;
  trafficDelayInSeconds?: number;
  trafficLengthInMeters?: number;
  noTrafficTravelTimeInSeconds?: number;
  historicTrafficTravelTimeInSeconds?: number;
  liveTrafficIncidentsTravelTimeInSeconds?: number;
};

type TomTomRouteResponse = {
  routes?: {
    summary?: TomTomRouteSummary;
  }[];
  detailedError?: {
    message?: string;
  };
  error?: string;
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

function getRouteGeometry(route: Route): Coordinate[] {
  if (Array.isArray(route.geometry)) return route.geometry;
  return decodePolyline(route.geometry);
}

function sampleRouteGeometry(geometry: Coordinate[]) {
  if (geometry.length <= TOMTOM_MAX_SUPPORTING_POINTS) return geometry;

  const sampled: Coordinate[] = [];
  const lastIndex = geometry.length - 1;

  for (let i = 0; i < TOMTOM_MAX_SUPPORTING_POINTS; i++) {
    const index = Math.round((i / (TOMTOM_MAX_SUPPORTING_POINTS - 1)) * lastIndex);
    sampled.push(geometry[index]);
  }

  return sampled;
}

function createUnavailableTrafficAssessment(
  reason: string,
  routeAttempt: number
): TrafficAssessment {
  return {
    status: "unavailable",
    provider: "tomtom",
    reason,
    delaySeconds: null,
    travelTimeSeconds: null,
    noTrafficTravelTimeSeconds: null,
    liveTrafficTravelTimeSeconds: null,
    trafficDelaySeconds: null,
    delayRatio: null,
    trafficLengthMeters: null,
    thresholdRatio: TOMTOM_TRAFFIC_THRESHOLD_RATIO,
    routeAttempt,
  };
}

function scoreTomTomSummary(
  summary: TomTomRouteSummary,
  routeAttempt: number
): TrafficAssessment {
  const travelTimeSeconds = summary.travelTimeInSeconds ?? null;
  const liveTrafficTravelTimeSeconds =
    summary.liveTrafficIncidentsTravelTimeInSeconds ?? null;
  const noTrafficTravelTimeSeconds =
    summary.noTrafficTravelTimeInSeconds ??
    (travelTimeSeconds !== null && summary.trafficDelayInSeconds !== undefined
      ? Math.max(travelTimeSeconds - summary.trafficDelayInSeconds, 0)
      : null);
  const trafficDelaySeconds = summary.trafficDelayInSeconds ?? null;
  const liveDelaySeconds =
    liveTrafficTravelTimeSeconds !== null && noTrafficTravelTimeSeconds !== null
      ? Math.max(liveTrafficTravelTimeSeconds - noTrafficTravelTimeSeconds, 0)
      : null;
  const travelDelaySeconds =
    travelTimeSeconds !== null && noTrafficTravelTimeSeconds !== null
      ? Math.max(travelTimeSeconds - noTrafficTravelTimeSeconds, 0)
      : null;
  const delaySeconds = Math.max(
    trafficDelaySeconds ?? 0,
    liveDelaySeconds ?? 0,
    travelDelaySeconds ?? 0
  );
  const delayRatio =
    noTrafficTravelTimeSeconds && noTrafficTravelTimeSeconds > 0
      ? delaySeconds / noTrafficTravelTimeSeconds
      : null;
  const accepted =
    delayRatio === null || delayRatio <= TOMTOM_TRAFFIC_THRESHOLD_RATIO;
  const delayMinutes = Math.round(delaySeconds / 60);
  const ratioPercent = delayRatio === null ? null : Math.round(delayRatio * 100);

  return {
    status: accepted ? "accepted" : "rejected",
    provider: "tomtom",
    reason:
      ratioPercent === null
        ? `TomTom traffic check completed with about ${delayMinutes} min delay.`
        : `TomTom traffic check found about ${delayMinutes} min delay (${ratioPercent}% over no-traffic travel time).`,
    delaySeconds,
    travelTimeSeconds,
    noTrafficTravelTimeSeconds,
    liveTrafficTravelTimeSeconds,
    trafficDelaySeconds,
    delayRatio,
    trafficLengthMeters: summary.trafficLengthInMeters ?? null,
    thresholdRatio: TOMTOM_TRAFFIC_THRESHOLD_RATIO,
    routeAttempt,
  };
}

async function assessRouteWithTomTom(
  route: Route,
  routeAttempt: number
): Promise<TrafficAssessment> {
  const apiKey = process.env.TOMTOM_API_KEY;

  if (!apiKey) {
    return createUnavailableTrafficAssessment("Missing TOMTOM_API_KEY.", routeAttempt);
  }

  const geometry = sampleRouteGeometry(getRouteGeometry(route));

  if (geometry.length < 2) {
    return createUnavailableTrafficAssessment("Route geometry is too short for TomTom traffic checking.", routeAttempt);
  }

  const origin = geometry[0];
  const destination = geometry[geometry.length - 1];
  const locations = `${origin[1]},${origin[0]}:${destination[1]},${destination[0]}`;
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&traffic=true` +
    `&travelMode=truck` +
    `&routeRepresentation=summaryOnly` +
    `&computeTravelTimeFor=all` +
    `&sectionType=traffic`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      supportingPoints: geometry.map(([longitude, latitude]) => ({
        latitude,
        longitude,
      })),
    }),
    cache: "no-store",
  });

  const data = (await response.json()) as TomTomRouteResponse;

  if (!response.ok) {
    const message =
      data.detailedError?.message ||
      data.error ||
      `TomTom traffic check failed with status ${response.status}.`;
    return createUnavailableTrafficAssessment(message, routeAttempt);
  }

  const summary = data.routes?.[0]?.summary;

  if (!summary) {
    return createUnavailableTrafficAssessment("TomTom did not return a route summary.", routeAttempt);
  }

  return scoreTomTomSummary(summary, routeAttempt);
}

async function chooseTrafficAwareRoute(routeData: AppRoute): Promise<{
  routeData: AppRoute;
  trafficAssessment: TrafficAssessment;
}> {
  const routes = routeData.routes ?? [];

  if (routes.length === 0) {
    return {
      routeData,
      trafficAssessment: createUnavailableTrafficAssessment("No routes were available to score.", 1),
    };
  }

  const scoredRoutes = [];

  for (let index = 0; index < routes.length; index++) {
    const assessment = await assessRouteWithTomTom(routes[index], index + 1);
    scoredRoutes.push({ route: routes[index], assessment });

    if (assessment.status === "accepted") {
      return {
        routeData: {
          ...routeData,
          routes: [routes[index]],
        },
        trafficAssessment: assessment,
      };
    }
  }

  const bestRoute =
    scoredRoutes
      .filter(({ assessment }) => assessment.delayRatio !== null)
      .sort((a, b) => (a.assessment.delayRatio ?? Infinity) - (b.assessment.delayRatio ?? Infinity))[0] ??
    scoredRoutes[0];

  return {
    routeData: {
      ...routeData,
      routes: [bestRoute.route],
    },
    trafficAssessment: bestRoute.assessment,
  };
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
    };

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

    if (USE_GEOAPIFY_ROUTING) {
      if (!process.env.GEOAPIFY_API_KEY) {
        return jsonError("Missing GEOAPIFY_API_KEY.", 500);
      }

      const geoapifyData = await getGeoapifyRoute(orsCoordinates);
      routeData = convertGeoapifyToAppRoute(geoapifyData);
      const selectedRoute = await chooseTrafficAwareRoute(routeData);
      routeData = selectedRoute.routeData;
      trafficAssessment = selectedRoute.trafficAssessment;
    } else {
      if (!process.env.OPENROUTESERVICE_API_KEY) {
        return jsonError("Missing OPENROUTESERVICE_API_KEY.", 500);
      }

      const orsResponse = await fetch(
        "https://api.heigit.org/openrouteservice/v2/directions/driving-hgv",
        {
          method: "POST",
          headers: {
            Authorization: process.env.OPENROUTESERVICE_API_KEY || "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            coordinates: orsCoordinates,
            alternative_routes: {
              target_count: 3,
              weight_factor: 1.6,
              share_factor: 0.6,
            },
          }),
        }
      );

      console.log("ORS route status:", orsResponse.status);

      let orsData: unknown = null;

      try {
        orsData = await orsResponse.json();
        console.log("ORS FULL RESPONSE:", JSON.stringify(orsData, null, 2));
      } catch {
        console.log("ORS response was not valid JSON");
      }

      if (!orsResponse.ok) {
        if (!process.env.GEOAPIFY_API_KEY) {
          return jsonError("OpenRouteService failed and GEOAPIFY_API_KEY is missing.", 500);
        }

        console.log("ORS failed, falling back to Geoapify...");
        const geoapifyData = await getGeoapifyRoute(orsCoordinates);

        console.log("GEOAPIFY FALLBACK SUMMARY:", {
          featureCount: geoapifyData?.features?.length ?? 0,
          legCount: geoapifyData?.features?.[0]?.properties?.legs?.length ?? 0,
          distance: geoapifyData?.features?.[0]?.properties?.distance ?? null,
          time: geoapifyData?.features?.[0]?.properties?.time ?? null,
        });

        const convertedRouteData = convertGeoapifyToAppRoute(geoapifyData);
        routeData = convertedRouteData;
        const selectedRoute = await chooseTrafficAwareRoute(routeData);
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;

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
        routeData = orsData as AppRoute;
        const selectedRoute = await chooseTrafficAwareRoute(routeData);
        routeData = selectedRoute.routeData;
        trafficAssessment = selectedRoute.trafficAssessment;
      }
    }

    return NextResponse.json({
      success: true,
      output: parsedOutput,
      orsRoute: routeData,
      trafficAssessment,
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
