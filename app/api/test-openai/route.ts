import OpenAI from "openai";
import { NextResponse } from "next/server";
import { decodePolyline } from "@/lib/geo";
import { normalizeLanguage, type AppLanguage } from "@/lib/i18n";
import type {
  AppRoute,
  CommercialRestrictionValidation,
  Coordinate,
  Route,
  RouteDecisionCandidate,
  RouteDecisionReport,
  RouteStep,
  RouteStopInput,
  TrafficAssessment,
} from "@/lib/route-types";
import { NURSERY_ADDRESS, normalizeAddress, startCoordsMap } from "@/lib/stops";

const USE_GEOAPIFY_ROUTING = false;
const TOMTOM_TRAFFIC_THRESHOLD_RATIO = 0.25;
const TOMTOM_MAX_SUPPORTING_POINTS = 50;
const GOOGLE_CANDIDATE_LIMIT = 2;
const GARDEN_STATE_PARKWAY_EXIT_105_LATITUDE = 40.283611;
const GARDEN_STATE_PARKWAY_EXIT_105_BUFFER_DEGREES = 0.002;
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

const COMMERCIAL_RESTRICTION_RULES = [
  {
    id: "garden-state-parkway",
    label: "Garden State Parkway",
    patterns: [
      /\bgarden state parkway\b/i,
      /\bgarden state pkwy\b/i,
      /\bgsp\b/i,
    ],
    type: "allowed-south-of-latitude",
    maxLatitude: GARDEN_STATE_PARKWAY_EXIT_105_LATITUDE,
    reason: "Garden State Parkway is allowed only south of Interchange 105 for the commercial restriction rule.",
  },
  {
    id: "palisades-interstate-parkway",
    label: "Palisades Interstate Parkway",
    patterns: [
      /\bpalisades interstate parkway\b/i,
      /\bpalisades interstate pkwy\b/i,
      /\bpalisades parkway\b/i,
      /\bpalisades pkwy\b/i,
    ],
    type: "always-restricted",
    reason: "Commercial traffic is prohibited on the Palisades Interstate Parkway.",
  },
];

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

function getRouteGeometry(route: Route): Coordinate[] {
  if (Array.isArray(route.geometry)) return route.geometry;
  return decodePolyline(route.geometry);
}

function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;

  const match = value.match(/^(\d+(?:\.\d+)?)s$/);

  if (!match) return null;

  return Math.round(Number(match[1]));
}

function getRouteDistanceMeters(route: Route): number | null {
  return route.distance ?? route.summary?.distance ?? null;
}

function getRouteDurationSeconds(route: Route): number | null {
  return route.duration ?? route.time ?? route.summary?.duration ?? null;
}

function getRouteInstructionText(route: Route): string {
  return (route.segments ?? [])
    .flatMap((segment) => segment.steps ?? [])
    .map((step) => {
      const instruction =
        typeof step.instruction === "string"
          ? step.instruction
          : step.instruction?.text;

      return [instruction, step.name].filter(Boolean).join(" ");
    })
    .join(" ");
}

function getStepText(step: RouteStep): string {
  const instruction =
    typeof step.instruction === "string"
      ? step.instruction
      : step.instruction?.text;

  return [instruction, step.name].filter(Boolean).join(" ");
}

function getMatchedStepCoordinates(route: Route, patterns: RegExp[]) {
  const geometry = getRouteGeometry(route);
  const matchedCoordinates: Coordinate[] = [];

  for (const segment of route.segments ?? []) {
    for (const step of segment.steps ?? []) {
      const stepText = getStepText(step);

      if (!patterns.some((pattern) => pattern.test(stepText))) continue;

      const startIndex = step.way_points?.[0];
      const endIndex = step.way_points?.[1];

      if (typeof startIndex !== "number" || typeof endIndex !== "number") {
        continue;
      }

      matchedCoordinates.push(
        ...geometry.slice(
          Math.max(0, startIndex),
          Math.min(geometry.length, endIndex + 1)
        )
      );
    }
  }

  return matchedCoordinates;
}

function validateCommercialRestrictions(route: Route): CommercialRestrictionValidation {
  const instructionText = getRouteInstructionText(route);

  if (!instructionText.trim()) {
    return {
      status: "unknown",
      reason:
        "Commercial validation could not inspect road names because this route did not include turn-by-turn road instructions.",
      matchedRules: [],
    };
  }

  const matchedRules = [];

  for (const rule of COMMERCIAL_RESTRICTION_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(instructionText))) {
      continue;
    }

    if (rule.type === "allowed-south-of-latitude") {
      if (typeof rule.maxLatitude !== "number") continue;

      const coordinates = getMatchedStepCoordinates(route, rule.patterns);

      if (coordinates.length === 0) {
        matchedRules.push({
          label: rule.label,
          reason: `${rule.reason} The app could not confirm which section was used, so it rejected this candidate.`,
        });
        continue;
      }

      const maxLatitude = Math.max(...coordinates.map((coordinate) => coordinate[1]));
      const cutoffLatitude =
        rule.maxLatitude + GARDEN_STATE_PARKWAY_EXIT_105_BUFFER_DEGREES;

      if (maxLatitude > cutoffLatitude) {
        matchedRules.push({
          label: rule.label,
          reason: `${rule.reason} This route appears to use it north of Interchange 105.`,
        });
      }

      continue;
    }

    matchedRules.push({
      label: rule.label,
      reason: rule.reason,
    });
  }

  if (matchedRules.length > 0) {
    return {
      status: "rejected",
      reason: matchedRules.map((rule) => rule.reason).join(" "),
      matchedRules: matchedRules.map((rule) => rule.label),
    };
  }

  return {
    status: "passed",
    reason: "No known commercial-restricted roads were found in the route instructions.",
    matchedRules: [],
  };
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

function createCommercialRejectedTrafficAssessment(
  reason: string,
  routeAttempt: number
): TrafficAssessment {
  return {
    status: "rejected",
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

function compareCandidatesByRouteEta(
  a: { route: Route; assessment?: TrafficAssessment },
  b: { route: Route; assessment?: TrafficAssessment }
) {
  const aRouteTime = getRouteDurationSeconds(a.route) ?? Infinity;
  const bRouteTime = getRouteDurationSeconds(b.route) ?? Infinity;
  const aDisplayedRouteMinutes = Math.round(aRouteTime / 60);
  const bDisplayedRouteMinutes = Math.round(bRouteTime / 60);

  if (aDisplayedRouteMinutes !== bDisplayedRouteMinutes) {
    return aDisplayedRouteMinutes - bDisplayedRouteMinutes;
  }

  const aTomTomTime = a.assessment?.travelTimeSeconds ?? Infinity;
  const bTomTomTime = b.assessment?.travelTimeSeconds ?? Infinity;
  const tomTomEtaDelta = aTomTomTime - bTomTomTime;

  if (tomTomEtaDelta !== 0) return tomTomEtaDelta;

  const routeEtaDelta = aRouteTime - bRouteTime;

  if (routeEtaDelta !== 0) return routeEtaDelta;

  return (
    (a.assessment?.delayRatio ?? Infinity) -
    (b.assessment?.delayRatio ?? Infinity)
  );
}

async function chooseRouteCandidate(
  candidates: RouteCandidateInput[],
  options: {
    scoreAllCandidates: boolean;
  }
): Promise<{
  routeData: AppRoute;
  trafficAssessment: TrafficAssessment;
  routeDecision: RouteDecisionReport;
}> {
  if (candidates.length === 0) {
    const trafficAssessment = createUnavailableTrafficAssessment("No routes were available to score.", 1);

    return {
      routeData: { routes: [] },
      trafficAssessment,
      routeDecision: {
        selectedCandidateId: null,
        selectedReason: "No route candidates were available.",
        candidateCount: 0,
        scoredCandidateCount: 0,
        candidates: [],
      },
    };
  }

  const orderedCandidates = [...candidates].sort((a, b) =>
    compareCandidatesByRouteEta(a, b)
  );
  const scoredRoutes: {
    route: Route;
    assessment: TrafficAssessment;
    candidate: RouteDecisionCandidate;
    input: RouteCandidateInput;
  }[] = [];

  for (let index = 0; index < orderedCandidates.length; index++) {
    const input = orderedCandidates[index];
    const commercialValidation = validateCommercialRestrictions(input.route);
    const commercialAccepted = commercialValidation.status !== "rejected";
    const assessment = commercialAccepted
      ? await assessRouteWithTomTom(input.route, index + 1)
      : createCommercialRejectedTrafficAssessment(
          commercialValidation.reason,
          index + 1
        );
    const routeDurationSeconds = getRouteDurationSeconds(input.route);
    const tomTomTravelTimeSeconds = assessment.travelTimeSeconds;
    const trafficAccepted = assessment.status === "accepted";
    const accepted = trafficAccepted && commercialAccepted;
    const providerAttempt =
      orderedCandidates
        .slice(0, index + 1)
        .filter((candidate) => candidate.provider === input.provider).length;
    const candidate: RouteDecisionCandidate = {
      id: `${input.provider}-${providerAttempt}`,
      provider: input.provider,
      label: input.label,
      selected: false,
      accepted,
      rejectionReason: accepted
        ? null
        : [
            commercialValidation.status === "rejected"
              ? commercialValidation.reason
              : null,
            assessment.status !== "accepted" ? assessment.reason : null,
          ]
            .filter(Boolean)
            .join(" "),
      distanceMeters: getRouteDistanceMeters(input.route),
      routeDurationSeconds,
      tomTomTravelTimeSeconds,
      tomTomDelaySeconds: assessment.delaySeconds,
      tomTomDelayRatio: assessment.delayRatio,
      commercialValidation,
      trafficAssessment: assessment,
    };

    scoredRoutes.push({ route: input.route, assessment, candidate, input });

    if (accepted && !options.scoreAllCandidates) {
      candidate.selected = true;
      return {
        routeData: {
          routes: [input.route],
        },
        trafficAssessment: assessment,
        routeDecision: {
          selectedCandidateId: candidate.id,
          selectedReason:
            "Selected the fastest route ETA candidate that passed commercial validation and the TomTom traffic threshold.",
          candidateCount: candidates.length,
          scoredCandidateCount: scoredRoutes.length,
          candidates: scoredRoutes.map((item) => item.candidate),
        },
      };
    }
  }

  const acceptedRoutes = scoredRoutes.filter(
    ({ candidate }) => candidate.accepted
  );
  const comparableRoutes = acceptedRoutes.length > 0 ? acceptedRoutes : scoredRoutes;
  const bestRoute = [...comparableRoutes].sort(compareCandidatesByRouteEta)[0];

  bestRoute.candidate.selected = true;

  const selectedReason =
    acceptedRoutes.length > 0
      ? "Selected the commercial-valid route with the lowest displayed route ETA, using TomTom only when route ETA is tied."
      : "No route passed both commercial validation and the traffic threshold, so the least-bad scored route was selected.";

  return {
    routeData: {
      routes: [bestRoute.route],
    },
    trafficAssessment: bestRoute.assessment,
    routeDecision: {
      selectedCandidateId: bestRoute.candidate.id,
      selectedReason,
      candidateCount: candidates.length,
      scoredCandidateCount: scoredRoutes.length,
      candidates: scoredRoutes.map((item) => item.candidate),
    },
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

function createRouteCandidates(
  routeData: AppRoute,
  provider: RouteDecisionCandidate["provider"],
  limit: number
): RouteCandidateInput[] {
  return (routeData.routes ?? []).slice(0, limit).map((route, index) => ({
    route,
    provider,
    label: `${provider.toUpperCase()} route ${index + 1}`,
  }));
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
      const selectedRoute = await chooseRouteCandidate(createRouteCandidates(routeData, "geoapify", 1), {
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
          ...createRouteCandidates(googleRouteData, "google", GOOGLE_CANDIDATE_LIMIT)
        );
      } else if (isPointToPointRoute && googleResult.status === "rejected") {
        console.log("Google routing failed:", getErrorMessage(googleResult.reason));
      }

      if (orsRouteData) {
        candidates.push(...createRouteCandidates(orsRouteData, "ors", 1));
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
        const selectedRoute = await chooseRouteCandidate(createRouteCandidates(convertedRouteData, "geoapify", 1), {
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
        const selectedRoute = await chooseRouteCandidate(candidates, {
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
