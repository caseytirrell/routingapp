import { NextResponse } from "next/server";
import { decodePolyline } from "@/lib/geo";
import { normalizeLanguage, type AppLanguage } from "@/lib/i18n";
import {
  chooseRouteCandidate,
  createRouteCandidates,
  type RouteCandidateInput,
} from "@/lib/routing-policy";
import type { AppRoute, Coordinate } from "@/lib/route-types";
import {
  GEOAPIFY_TRUCK_MODE,
  TRAILER_FRIENDLY_ORS_OPTIONS,
} from "@/lib/vehicle-profile";

const GEOAPIFY_REROUTE_TYPE = "less_maneuvers";

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
      coordinates?: Coordinate[] | Coordinate[][];
    };
    properties?: {
      distance?: number;
      time?: number;
      legs?: GeoapifyLeg[];
    };
  }[];
  error?: string;
};

type GoogleRouteStep = {
  distanceMeters?: number;
  staticDuration?: string;
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

type LiveRerouteCandidateResult = {
  provider: "ors" | "geoapify" | "google";
  candidates: RouteCandidateInput[];
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
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

function toGeoapifyWaypoints(coordinates: [number, number][]) {
  return coordinates.map(([lon, lat]) => `${lat},${lon}`).join("|");
}

function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;

  const match = value.match(/^(\d+(?:\.\d+)?)s$/);

  if (!match) return null;

  return Math.round(Number(match[1]));
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
  return {
    routes: (googleData.routes ?? []).slice(0, 1).map((route) => {
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

function convertGeoapifyToAppRoute(geoapifyData: GeoapifyRouteResponse): AppRoute {
  const feature = geoapifyData?.features?.[0];

  if (!feature) {
    throw new Error("Geoapify reroute response did not include any features.");
  }

  const rawGeometry = feature.geometry?.coordinates || [];
  const properties = feature.properties || {};
  const legs = properties.legs || [];

  const isNestedLegGeometry =
    Array.isArray(rawGeometry) &&
    Array.isArray(rawGeometry[0]) &&
    Array.isArray(rawGeometry[0][0]);

  const flatGeometry: Coordinate[] = isNestedLegGeometry
    ? (rawGeometry as Coordinate[][]).flat()
    : (rawGeometry as Coordinate[]);

  let geometryOffset = 0;

  const segments = (
    legs.length ? legs : [{ distance: properties.distance, time: properties.time, steps: [] }]
  ).map((leg, legIndex) => {
    const legGeometry = isNestedLegGeometry
      ? (rawGeometry as Coordinate[][])[legIndex] || []
      : flatGeometry;

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

async function getGeoapifyRoute(
  coordinates: [number, number][],
  routeType = GEOAPIFY_REROUTE_TYPE
) {
  if (!process.env.GEOAPIFY_API_KEY) {
    throw new Error("Missing GEOAPIFY_API_KEY.");
  }

  const waypoints = toGeoapifyWaypoints(coordinates);

  const url =
    `https://api.geoapify.com/v1/routing` +
    `?waypoints=${encodeURIComponent(waypoints)}` +
    `&mode=${GEOAPIFY_TRUCK_MODE}` +
    `&type=${routeType}` +
    `&traffic=approximated` +
    `&details=instruction_details` +
    `&apiKey=${process.env.GEOAPIFY_API_KEY}`;

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
  });

  const data = (await response.json()) as GeoapifyRouteResponse;

  if (!response.ok) {
    throw new Error(data?.error || `Geoapify reroute failed with status ${response.status}`);
  }

  return data;
}

async function getGoogleRoute(
  coordinates: [number, number][],
  language: AppLanguage
) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY.");
  }

  const [originLng, originLat] = coordinates[0];
  const [destinationLng, destinationLat] = coordinates[coordinates.length - 1];
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
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        computeAlternativeRoutes: false,
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
        `Google reroute failed with status ${response.status}`
    );
  }

  return data;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { truckLocation, destination, heading, language: rawLanguage } = body as {
      truckLocation: unknown;
      destination: unknown;
      heading?: number | null;
      language?: unknown;
    };
    const language = normalizeLanguage(rawLanguage);

    console.log("REROUTE INPUT:", { truckLocation, destination, heading });

    if (!isCoordinate(truckLocation) || !isCoordinate(destination)) {
      return jsonError("Missing or invalid truckLocation or destination.", 400);
    }

    if (
      !process.env.OPENROUTESERVICE_API_KEY &&
      !process.env.GEOAPIFY_API_KEY &&
      !process.env.GOOGLE_MAPS_API_KEY
    ) {
      return jsonError("Missing routing API keys.", 500);
    }

    const candidateRequests: Promise<LiveRerouteCandidateResult>[] = [];

    if (process.env.OPENROUTESERVICE_API_KEY) {
      candidateRequests.push(
        fetch("https://api.heigit.org/openrouteservice/v2/directions/driving-hgv", {
          method: "POST",
          headers: {
            Authorization: process.env.OPENROUTESERVICE_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            coordinates: [truckLocation, destination],
            language,
            options: TRAILER_FRIENDLY_ORS_OPTIONS,
            ...(typeof heading === "number"
              ? {
                  bearings: [[Math.round(heading), 45]],
                  continue_straight: true,
                }
              : {}),
          }),
          cache: "no-store",
        }).then(async (response) => {
          const data = (await response.json()) as AppRoute;

          if (!response.ok) {
            throw new Error(`OpenRouteService reroute failed with status ${response.status}`);
          }

          return {
            provider: "ors",
            candidates: createRouteCandidates(data, "ors", 1),
          };
        })
      );
    } else {
      console.log("ORS reroute skipped: Missing OPENROUTESERVICE_API_KEY.");
    }

    if (process.env.GEOAPIFY_API_KEY) {
      candidateRequests.push(
        getGeoapifyRoute([truckLocation, destination], GEOAPIFY_REROUTE_TYPE)
          .then(convertGeoapifyToAppRoute)
          .then((routeData) => ({
            provider: "geoapify",
            candidates: createRouteCandidates(routeData, "geoapify", 1),
          }))
      );
    } else {
      console.log("Geoapify reroute fallback skipped: Missing GEOAPIFY_API_KEY.");
    }

    if (process.env.GOOGLE_MAPS_API_KEY) {
      candidateRequests.push(
        getGoogleRoute([truckLocation, destination], language)
          .then(convertGoogleRoutesToAppRoute)
          .then((routeData) => ({
            provider: "google",
            candidates: createRouteCandidates(routeData, "google", 1),
          }))
      );
    } else {
      console.log("Google reroute candidate skipped: Missing GOOGLE_MAPS_API_KEY.");
    }

    const candidates: RouteCandidateInput[] = [];
    const candidateResults = await Promise.allSettled(candidateRequests);

    candidateResults.forEach((result) => {
      if (result.status === "fulfilled") {
        candidates.push(...result.value.candidates);
        return;
      }

      console.log("Live reroute candidate failed:", getErrorMessage(result.reason));
    });

    if (candidates.length === 0) {
      throw new Error("No live reroute candidates were available.");
    }

    const selectedRoute = await chooseRouteCandidate(candidates, {
      scoreAllCandidates: true,
    });

    return NextResponse.json({
      success: true,
      orsRoute: selectedRoute.routeData,
      trafficAssessment: selectedRoute.trafficAssessment,
      routeDecision: selectedRoute.routeDecision,
    });
  } catch (error: unknown) {
    console.error("REROUTE SERVER ERROR:", error);
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
