import { decodePolyline } from "./geo";
import { ProviderTimeoutError, withProviderTimeout } from "./provider-timeouts";
import { TOMTOM_TRUCK_QUERY_PARAMS } from "./vehicle-profile";
import type {
  AppRoute,
  CommercialRestrictionValidation,
  Coordinate,
  Route,
  RouteDecisionCandidate,
  RouteDecisionReport,
  RouteStep,
  TrafficAssessment,
  TrafficSection,
} from "./route-types";

const TOMTOM_TRAFFIC_THRESHOLD_RATIO = 0.25;
const TOMTOM_MAX_SUPPORTING_POINTS = 50;
const TOMTOM_MAX_TRAFFIC_ANNOTATION_POINTS = 200;
const GARDEN_STATE_PARKWAY_EXIT_105_LATITUDE = 40.283611;
const GARDEN_STATE_PARKWAY_EXIT_105_BUFFER_DEGREES = 0.002;

const COMMERCIAL_RESTRICTION_RULES = [
  {
    label: "Garden State Parkway",
    patterns: [
      /\bgarden state parkway\b/i,
      /\bgarden state p(?:ar)?kwy\b/i,
      /\bgsp\b/i,
      /\b(?:nj|state route|route|sr)[ -]?444\b/i,
    ],
    type: "allowed-south-of-latitude",
    maxLatitude: GARDEN_STATE_PARKWAY_EXIT_105_LATITUDE,
    reason:
      "Garden State Parkway is allowed only south of Interchange 105 for the commercial restriction rule.",
  },
  {
    label: "Palisades Interstate Parkway",
    patterns: [
      /\bpalisades interstate parkway\b/i,
      /\bpalisades interstate p(?:ar)?kwy\b/i,
      /\bpalisades parkway\b/i,
      /\bpalisades p(?:ar)?kwy\b/i,
      /\bpip\b/i,
      /\b(?:nj|state route|route|sr)[ -]?445\b/i,
    ],
    type: "always-restricted",
    reason: "Commercial traffic is prohibited on the Palisades Interstate Parkway.",
  },
];

type TomTomRouteSummary = {
  travelTimeInSeconds?: number;
  trafficDelayInSeconds?: number;
  trafficLengthInMeters?: number;
  noTrafficTravelTimeInSeconds?: number;
  liveTrafficIncidentsTravelTimeInSeconds?: number;
};

type TomTomPoint = {
  latitude: number;
  longitude: number;
};

type TomTomTrafficSection = {
  sectionType?: string;
  startPointIndex?: number;
  endPointIndex?: number;
  simpleCategory?: string;
  effectiveSpeedInKmh?: number;
  delayInSeconds?: number;
  magnitudeOfDelay?: number;
};

type TomTomRouteResponse = {
  routes?: TomTomRouteResult[];
  detailedError?: {
    message?: string;
  };
  error?: string;
};

type TomTomRouteResult = {
  summary?: TomTomRouteSummary;
  legs?: {
    points?: TomTomPoint[];
  }[];
  sections?: TomTomTrafficSection[];
};

export type RouteCandidateInput = {
  route: Route;
  provider: RouteDecisionCandidate["provider"];
  label: string;
};

function getRouteGeometry(route: Route): Coordinate[] {
  if (Array.isArray(route.geometry)) return route.geometry;
  return decodePolyline(route.geometry);
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
    .map(getStepText)
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
      if (!patterns.some((pattern) => pattern.test(getStepText(step)))) continue;

      const startIndex = step.way_points?.[0];
      const endIndex = step.way_points?.[1];

      if (typeof startIndex !== "number" || typeof endIndex !== "number") continue;

      matchedCoordinates.push(
        ...geometry.slice(Math.max(0, startIndex), Math.min(geometry.length, endIndex + 1))
      );
    }
  }

  return matchedCoordinates;
}

export function validateCommercialRestrictions(
  route: Route
): CommercialRestrictionValidation {
  const instructionText = getRouteInstructionText(route);

  if (!instructionText.trim()) {
    return {
      status: "unknown",
      reason:
        "Commercial validation could not inspect road names because this route did not include turn-by-turn road instructions.",
      matchedRules: [],
    };
  }

  const matchedRules: { label: string; reason: string }[] = [];

  for (const rule of COMMERCIAL_RESTRICTION_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(instructionText))) continue;

    if (rule.type === "allowed-south-of-latitude") {
      const coordinates = getMatchedStepCoordinates(route, rule.patterns);

      if (coordinates.length === 0) {
        matchedRules.push({
          label: rule.label,
          reason: `${rule.reason} The app could not confirm which section was used, so it rejected this candidate.`,
        });
        continue;
      }

      const cutoffLatitude =
        (rule.maxLatitude ?? 0) + GARDEN_STATE_PARKWAY_EXIT_105_BUFFER_DEGREES;

      if (Math.max(...coordinates.map((coordinate) => coordinate[1])) > cutoffLatitude) {
        matchedRules.push({
          label: rule.label,
          reason: `${rule.reason} This route appears to use it north of Interchange 105.`,
        });
      }

      continue;
    }

    matchedRules.push({ label: rule.label, reason: rule.reason });
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

function sampleRouteGeometry(
  geometry: Coordinate[],
  maxSupportingPoints = TOMTOM_MAX_SUPPORTING_POINTS
) {
  if (geometry.length <= maxSupportingPoints) return geometry;

  const sampled: Coordinate[] = [];
  const lastIndex = geometry.length - 1;

  for (let index = 0; index < maxSupportingPoints; index++) {
    sampled.push(
      geometry[Math.round((index / (maxSupportingPoints - 1)) * lastIndex)]
    );
  }

  return sampled;
}

function getTomTomRoutePoints(route: TomTomRouteResult): Coordinate[] {
  const points: Coordinate[] = [];

  for (const leg of route.legs ?? []) {
    for (const point of leg.points ?? []) {
      const coordinate: Coordinate = [point.longitude, point.latitude];
      const previous = points[points.length - 1];

      if (previous && previous[0] === coordinate[0] && previous[1] === coordinate[1]) {
        continue;
      }

      points.push(coordinate);
    }
  }

  return points;
}

function toTrafficSections(route: TomTomRouteResult): TrafficSection[] {
  const points = getTomTomRoutePoints(route);

  if (points.length < 2) return [];

  return (route.sections ?? [])
    .filter(
      (section) =>
        section.sectionType === "TRAFFIC" &&
        typeof section.startPointIndex === "number" &&
        typeof section.endPointIndex === "number"
    )
    .map((section) => {
      const startPointIndex = Math.max(
        0,
        Math.min(section.startPointIndex ?? 0, points.length - 1)
      );
      const endPointIndex = Math.max(
        startPointIndex,
        Math.min(section.endPointIndex ?? startPointIndex, points.length - 1)
      );

      return {
        provider: "tomtom" as const,
        geometry: points.slice(startPointIndex, endPointIndex + 1),
        startPointIndex,
        endPointIndex,
        delaySeconds:
          typeof section.delayInSeconds === "number" ? section.delayInSeconds : null,
        magnitudeOfDelay:
          typeof section.magnitudeOfDelay === "number" ? section.magnitudeOfDelay : null,
        simpleCategory:
          typeof section.simpleCategory === "string" ? section.simpleCategory : null,
        effectiveSpeedKmh:
          typeof section.effectiveSpeedInKmh === "number"
            ? section.effectiveSpeedInKmh
            : null,
      };
    })
    .filter((section) => section.geometry.length > 1);
}

export async function annotateRouteTrafficSections(
  routeData: AppRoute
): Promise<AppRoute> {
  const apiKey = process.env.TOMTOM_API_KEY;
  const selectedRoute = routeData.routes?.[0];

  if (!apiKey || !selectedRoute) {
    return routeData;
  }

  const geometry = sampleRouteGeometry(
    getRouteGeometry(selectedRoute),
    TOMTOM_MAX_TRAFFIC_ANNOTATION_POINTS
  );

  if (geometry.length < 2) {
    return routeData;
  }

  const origin = geometry[0];
  const destination = geometry[geometry.length - 1];
  const locations = `${origin[1]},${origin[0]}:${destination[1]},${destination[0]}`;
  const query = new URLSearchParams({
    key: apiKey,
    traffic: "true",
    routeRepresentation: "polyline",
    computeTravelTimeFor: "all",
    sectionType: "traffic",
    ...TOMTOM_TRUCK_QUERY_PARAMS,
  });

  try {
    const { response, data } = await withProviderTimeout("tomtom", async (signal) => {
      const response = await fetch(
        `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supportingPoints: geometry.map(([longitude, latitude]) => ({
              latitude,
              longitude,
            })),
          }),
          cache: "no-store",
          signal,
        }
      );
      const data = (await response.json()) as TomTomRouteResponse;

      return { response, data };
    });

    if (!response.ok) {
      console.log(
        "TomTom traffic section annotation failed:",
        data.detailedError?.message ||
          data.error ||
          `TomTom traffic section request failed with status ${response.status}.`
      );
      return routeData;
    }

    const trafficSections = toTrafficSections(data.routes?.[0] ?? {});

    return {
      ...routeData,
      routes: routeData.routes.map((route, index) =>
        index === 0
          ? {
              ...route,
              trafficSections,
            }
          : route
      ),
    };
  } catch (error) {
    console.log(
      "TomTom traffic section annotation failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return routeData;
  }
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

function createCommercialRejectedTrafficAssessment(
  reason: string,
  routeAttempt: number
): TrafficAssessment {
  return {
    ...createUnavailableTrafficAssessment(reason, routeAttempt),
    status: "rejected",
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
    return createUnavailableTrafficAssessment(
      "Route geometry is too short for TomTom traffic checking.",
      routeAttempt
    );
  }

  const origin = geometry[0];
  const destination = geometry[geometry.length - 1];
  const locations = `${origin[1]},${origin[0]}:${destination[1]},${destination[0]}`;
  const query = new URLSearchParams({
    key: apiKey,
    traffic: "true",
    routeRepresentation: "summaryOnly",
    computeTravelTimeFor: "all",
    sectionType: "traffic",
    ...TOMTOM_TRUCK_QUERY_PARAMS,
  });
  let response: Response;
  let data: TomTomRouteResponse;

  try {
    ({ response, data } = await withProviderTimeout("tomtom", async (signal) => {
      const response = await fetch(
        `https://api.tomtom.com/routing/1/calculateRoute/${locations}/json?${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supportingPoints: geometry.map(([longitude, latitude]) => ({
              latitude,
              longitude,
            })),
          }),
          cache: "no-store",
          signal,
        }
      );
      const data = (await response.json()) as TomTomRouteResponse;

      return { response, data };
    }));
  } catch (error) {
    if (error instanceof ProviderTimeoutError) {
      return createUnavailableTrafficAssessment(error.message, routeAttempt);
    }

    throw error;
  }

  if (!response.ok) {
    return createUnavailableTrafficAssessment(
      data.detailedError?.message ||
        data.error ||
        `TomTom traffic check failed with status ${response.status}.`,
      routeAttempt
    );
  }

  const summary = data.routes?.[0]?.summary;

  if (!summary) {
    return createUnavailableTrafficAssessment(
      "TomTom did not return a route summary.",
      routeAttempt
    );
  }

  const travelTimeSeconds = summary.travelTimeInSeconds ?? null;
  const liveTrafficTravelTimeSeconds =
    summary.liveTrafficIncidentsTravelTimeInSeconds ?? null;
  const noTrafficTravelTimeSeconds =
    summary.noTrafficTravelTimeInSeconds ??
    (travelTimeSeconds !== null && summary.trafficDelayInSeconds !== undefined
      ? Math.max(travelTimeSeconds - summary.trafficDelayInSeconds, 0)
      : null);
  const trafficDelaySeconds = summary.trafficDelayInSeconds ?? null;
  const delaySeconds = Math.max(
    trafficDelaySeconds ?? 0,
    liveTrafficTravelTimeSeconds !== null && noTrafficTravelTimeSeconds !== null
      ? Math.max(liveTrafficTravelTimeSeconds - noTrafficTravelTimeSeconds, 0)
      : 0,
    travelTimeSeconds !== null && noTrafficTravelTimeSeconds !== null
      ? Math.max(travelTimeSeconds - noTrafficTravelTimeSeconds, 0)
      : 0
  );
  const delayRatio =
    noTrafficTravelTimeSeconds && noTrafficTravelTimeSeconds > 0
      ? delaySeconds / noTrafficTravelTimeSeconds
      : null;
  const delayMinutes = Math.round(delaySeconds / 60);
  const ratioPercent = delayRatio === null ? null : Math.round(delayRatio * 100);

  return {
    status:
      delayRatio === null || delayRatio <= TOMTOM_TRAFFIC_THRESHOLD_RATIO
        ? "accepted"
        : "rejected",
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

function compareCandidatesByRouteEta(
  a: { route: Route; assessment?: TrafficAssessment },
  b: { route: Route; assessment?: TrafficAssessment }
) {
  const aRouteTime = getRouteDurationSeconds(a.route) ?? Infinity;
  const bRouteTime = getRouteDurationSeconds(b.route) ?? Infinity;

  if (aRouteTime !== bRouteTime) return aRouteTime - bRouteTime;

  const tomTomEtaDelta =
    (a.assessment?.travelTimeSeconds ?? Infinity) -
    (b.assessment?.travelTimeSeconds ?? Infinity);

  if (tomTomEtaDelta !== 0) return tomTomEtaDelta;

  return (a.assessment?.delayRatio ?? Infinity) - (b.assessment?.delayRatio ?? Infinity);
}

export function createRouteCandidates(
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

export async function chooseRouteCandidate(
  candidates: RouteCandidateInput[],
  options: {
    scoreAllCandidates: boolean;
    selectionPreference?: {
      labelIncludes: string[];
      maxExtraSeconds: number;
      reason: string;
    };
  }
): Promise<{
  routeData: AppRoute;
  trafficAssessment: TrafficAssessment;
  routeDecision: RouteDecisionReport;
}> {
  if (candidates.length === 0) {
    throw new Error("No route candidates were available.");
  }

  const orderedCandidates = [...candidates].sort(compareCandidatesByRouteEta);
  const scoredRoutes = [];

  for (let index = 0; index < orderedCandidates.length; index++) {
    const input = orderedCandidates[index];
    const commercialValidation = validateCommercialRestrictions(input.route);
    const commercialAccepted = commercialValidation.status !== "rejected";
    const assessment = commercialAccepted
      ? await assessRouteWithTomTom(input.route, index + 1)
      : createCommercialRejectedTrafficAssessment(commercialValidation.reason, index + 1);
    const accepted = commercialAccepted;
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
            !commercialAccepted && assessment.status !== "accepted"
              ? assessment.reason
              : null,
          ]
            .filter(Boolean)
            .join(" "),
      distanceMeters: getRouteDistanceMeters(input.route),
      routeDurationSeconds: getRouteDurationSeconds(input.route),
      tomTomTravelTimeSeconds: assessment.travelTimeSeconds,
      tomTomDelaySeconds: assessment.delaySeconds,
      tomTomDelayRatio: assessment.delayRatio,
      commercialValidation,
      trafficAssessment: assessment,
    };

    scoredRoutes.push({ route: input.route, assessment, candidate });

    if (
      commercialAccepted &&
      !options.scoreAllCandidates &&
      !options.selectionPreference
    ) {
      candidate.selected = true;
      return {
        routeData: { routes: [input.route] },
        trafficAssessment: assessment,
        routeDecision: {
          selectedCandidateId: candidate.id,
          selectedReason:
            "Selected the fastest route ETA candidate that passed commercial validation. TomTom traffic was checked and included in the decision report.",
          candidateCount: candidates.length,
          scoredCandidateCount: scoredRoutes.length,
          candidates: scoredRoutes.map((item) => item.candidate),
        },
      };
    }
  }

  const commerciallyValidRoutes = scoredRoutes.filter(
    ({ candidate }) => candidate.commercialValidation.status !== "rejected"
  );

  if (commerciallyValidRoutes.length === 0) {
    throw new Error(
      "No commercially valid route candidates were available. Refusing to use a commercially rejected fallback."
    );
  }

  const fastestRoute = [...commerciallyValidRoutes].sort(compareCandidatesByRouteEta)[0];
  const preferredRoute = options.selectionPreference
    ? [...commerciallyValidRoutes]
        .filter(({ candidate }) =>
          options.selectionPreference?.labelIncludes.some((label) =>
            candidate.label.includes(label)
          )
        )
        .sort(compareCandidatesByRouteEta)[0]
    : undefined;
  const fastestRouteSeconds = getRouteDurationSeconds(fastestRoute.route) ?? Infinity;
  const preferredRouteSeconds = preferredRoute
    ? getRouteDurationSeconds(preferredRoute.route) ?? Infinity
    : Infinity;
  const bestRoute =
    preferredRoute &&
    preferredRouteSeconds <=
      fastestRouteSeconds + (options.selectionPreference?.maxExtraSeconds ?? 0)
      ? preferredRoute
      : fastestRoute;

  bestRoute.candidate.selected = true;
  const usedPreference = bestRoute === preferredRoute;

  return {
    routeData: { routes: [bestRoute.route] },
    trafficAssessment: bestRoute.assessment,
    routeDecision: {
      selectedCandidateId: bestRoute.candidate.id,
      selectedReason:
        usedPreference && options.selectionPreference
          ? options.selectionPreference.reason
          : "Selected the commercially valid route with the lowest displayed route ETA, using TomTom traffic only when route ETA is tied.",
      candidateCount: candidates.length,
      scoredCandidateCount: scoredRoutes.length,
      candidates: scoredRoutes.map((item) => item.candidate),
    },
  };
}
