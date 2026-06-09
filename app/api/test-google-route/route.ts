import { NextResponse } from "next/server";
import { withProviderTimeout } from "@/lib/provider-timeouts";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function GET() {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "Missing GOOGLE_MAPS_API_KEY" },
        { status: 500 }
      );
    }

    const { response, data } = await withProviderTimeout("google", async (signal) => {
      const response = await fetch(
        "https://routes.googleapis.com/directions/v2:computeRoutes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask":
              "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
          },
          body: JSON.stringify({
            origin: {
              address: "35 Patton Dr, East Brunswick, NJ",
            },
            destination: {
              address: "25 Wardell Rd, Rumson, NJ 07760",
            },
            intermediates: [
              {
                address: "217 Beacon Blvd, NJ 08750",
              },
              {
                address: "103 The Terrace, Seagirt, NJ 08750",
              },
            ],
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE",
            computeAlternativeRoutes: false,
            languageCode: "en-US",
            units: "IMPERIAL",
          }),
          signal,
        }
      );
      const data = await response.json();

      return { response, data };
    });

    return NextResponse.json({
      success: response.ok,
      data,
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
