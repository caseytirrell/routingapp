import { NextResponse } from "next/server";

type NominatimResult = {
  name?: string;
  display_name: string;
  lon: string;
  lat: string;
};

type AddressSearchResult = {
  customerName: string;
  address: string;
  coords: [number, number];
  isCustom: true;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to search addresses";
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim();

    if (!q || q.length < 3) {
      return NextResponse.json({ results: [] });
    }

    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(q)}` +
      `&format=jsonv2` +
      `&addressdetails=1` +
      `&limit=8` +
      `&countrycodes=us`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "crew-route-optimizer/1.0",
        "Accept-Language": "en-US,en",
      },
      cache: "no-store",
    });

    const data = (await response.json()) as NominatimResult[];

    if (!response.ok) {
      throw new Error(`Address lookup failed with status ${response.status}`);
    }

    const results: AddressSearchResult[] = (data || [])
      .map((item) => ({
        customerName: item.name || "Custom Address",
        address: item.display_name,
        coords: [Number(item.lon), Number(item.lat)] as [number, number],
        isCustom: true as const,
      }))
      .filter((item) => {
        const text = item.address.toLowerCase();
        return (
          text.includes("new jersey") ||
          text.includes("nj")
        );
      });

    return NextResponse.json({ results });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        results: [],
        error: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
