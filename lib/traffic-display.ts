import type { TrafficSection } from "./route-types";

type TrafficFeature = {
  type: "Feature";
  geometry: {
    type: "LineString";
    coordinates: TrafficSection["geometry"];
  };
  properties: {
    color: string;
    delaySeconds: number | null;
    magnitudeOfDelay: number | null;
    simpleCategory: string | null;
  };
};

export function getTrafficSectionColor(section: TrafficSection) {
  if ((section.magnitudeOfDelay ?? 0) >= 5) {
    return "#dc2626";
  }

  return "#facc15";
}

export function getTrafficSectionsFeatureCollection(
  trafficSections: TrafficSection[]
) {
  return {
    type: "FeatureCollection" as const,
    features: trafficSections
      .filter((section) => section.geometry.length > 1)
      .map(
        (section): TrafficFeature => ({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: section.geometry,
          },
          properties: {
            color: getTrafficSectionColor(section),
            delaySeconds: section.delaySeconds,
            magnitudeOfDelay: section.magnitudeOfDelay,
            simpleCategory: section.simpleCategory,
          },
        })
      ),
  };
}
