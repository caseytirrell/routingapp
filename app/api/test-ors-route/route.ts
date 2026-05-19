import { NextResponse } from "next/server";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function GET() {
  try {
    const apiKey = process.env.OPENROUTESERVICE_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "Missing OPENROUTESERVICE_API_KEY" },
        { status: 500 }
      );
    }

    const response = await fetch(
      "https://api.heigit.org/openrouteservice/v2/directions/driving-hgv",
      {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          coordinates: [
            [-74.177646, 40.304492],
            [-74.133873, 40.344813],
            [-74.061588, 40.230499],
            [-74.042879, 40.102352],
            [-74.177646, 40.304492]
          ]
        }),
      }
    );

    const data = await response.json();

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
