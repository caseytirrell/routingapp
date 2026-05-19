import OpenAI from "openai";
import { NextResponse } from "next/server";

const USE_GEOAPIFY_ROUTING = false;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const startCoordsMap = new Map<string, [number, number]>([
  ["168 Heyers Mill Rd, Colts Neck, NJ 07722", [-74.187268, 40.301599]],
  ["475 South St, Morristown, NJ 07960", [-74.480619, 40.781894]],
]);

type Coordinate = [number, number];

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

type OptimizedRouteOutput = {
  route_order: string[];
  reason: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toGeoapifyWaypoints(coordinates: [number, number][]) {
  return coordinates.map(([lon, lat]) => `${lat},${lon}`).join("|");
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
    const { date, time, start, stops, startCoords, preserveOrder } = body as {
      date: string;
      time: string;
      start: string;
      stops: { address: string; coords: [number, number] }[];
      startCoords?: [number, number];
      preserveOrder: boolean;
    };
    const stopsList = stops
      .map(
        (stop: { address: string; coords: [number, number] }) =>
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

      const optimizedStops = enforceNurseryPlacement(
        separateConsecutiveDuplicateStops(parsedOutput.route_order),
        stops,
        "168 Heyers Mill Rd, Colts Neck, NJ 07722"
      );

      parsedOutput.route_order = optimizedStops;
    }

    const optimizedStops = enforceNurseryPlacement(
      separateConsecutiveDuplicateStops(parsedOutput.route_order),
      stops,
      "168 Heyers Mill Rd, Colts Neck, NJ 07722"
    );
    parsedOutput.route_order = optimizedStops;

    const normalizeAddress = (value: string) => value.trim().toLowerCase();

    const stopMap = new Map(
      stops.map((stop: { address: string; coords: [number, number] }) => [
        normalizeAddress(stop.address),
        stop.coords,
      ])
    );

    const mappedStartCoords = startCoordsMap.get(start);
    const resolvedStartCoords = startCoords ?? mappedStartCoords;

    if (!resolvedStartCoords) {
      throw new Error(`Missing coordinates for start location: ${start}`);
    }

    const orsCoordinates = [
      resolvedStartCoords,
      ...optimizedStops.map((address: string) => {
        const coords = stopMap.get(normalizeAddress(address));
        if (!coords) {
          throw new Error(`Missing coordinates for stop: ${address}`);
        }
        return coords;
      }),
      resolvedStartCoords,
    ];

    console.log("ORS coordinates:", orsCoordinates);

    let routeData: AppRoute | unknown;

    if (USE_GEOAPIFY_ROUTING) {
      const geoapifyData = await getGeoapifyRoute(orsCoordinates);
      routeData = convertGeoapifyToAppRoute(geoapifyData);
    } else {
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
        routeData = orsData;
      }
    }

    return NextResponse.json({
      success: true,
      output: parsedOutput,
      orsRoute: routeData,
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
