import { NextResponse } from "next/server";
import type { Coordinate } from "@/lib/route-types";

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

type AppRoute = {
  routes: {
    geometry: Coordinate[];
    segments: {
      distance: number;
      duration: number;
      steps: {
        name: string;
        distance: number;
        duration: number;
        way_points: [number, number];
      }[];
    }[];
    distance?: number;
    time?: number;
  }[];
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

async function getGeoapifyRoute(coordinates: [number, number][]) {
  if (!process.env.GEOAPIFY_API_KEY) {
    throw new Error("Missing GEOAPIFY_API_KEY.");
  }

  const waypoints = toGeoapifyWaypoints(coordinates);

  const url =
    `https://api.geoapify.com/v1/routing` +
    `?waypoints=${encodeURIComponent(waypoints)}` +
    `&mode=medium_truck` +
    `&type=less_maneuvers` +
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { truckLocation, destination, heading } = body as {
      truckLocation: unknown;
      destination: unknown;
      heading?: number | null;
    };

    console.log("REROUTE INPUT:", { truckLocation, destination, heading });

    if (!isCoordinate(truckLocation) || !isCoordinate(destination)) {
      return jsonError("Missing or invalid truckLocation or destination.", 400);
    }

    if (!process.env.OPENROUTESERVICE_API_KEY && !process.env.GEOAPIFY_API_KEY) {
      return jsonError("Missing routing API keys.", 500);
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
          coordinates: [truckLocation, destination],
          ...(typeof heading === "number"
            ? {
                bearings: [[Math.round(heading), 45]],
                continue_straight: true,
              }
            : {}),
        }),
      }
    );

    console.log("REROUTE STATUS:", orsResponse.status);

    let orsData: unknown = null;

    try {
      orsData = await orsResponse.json();
      console.log("REROUTE DATA:", orsData);
    } catch {
      console.log("REROUTE response was not valid JSON");
    }

    if (!orsResponse.ok) {
      console.log("ORS reroute failed, falling back to Geoapify...");

      const geoapifyData = await getGeoapifyRoute([truckLocation, destination]);
      console.log("GEOAPIFY REROUTE DATA:", geoapifyData);

      return NextResponse.json({
        success: true,
        orsRoute: convertGeoapifyToAppRoute(geoapifyData),
      });
    }

    return NextResponse.json({
      success: true,
      orsRoute: orsData,
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
