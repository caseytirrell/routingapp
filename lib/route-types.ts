export type Coordinate = [number, number];

export type PropertyType = "residential" | "commercial";

export type Property = {
  customerName: string;
  address: string;
  coords: Coordinate;
  propertyType: PropertyType;
};

export type StopOption = Property & {
  isCustom?: boolean;
  isNursery?: boolean;
};

export type RouteData = {
  route_order: string[];
  reason: string;
};

export type RouteStep = {
  instruction?: string | { text?: string };
  name?: string;
  way_points?: number[];
  distance?: number;
  duration?: number;
};

export type RouteSegment = {
  distance?: number;
  duration?: number;
  steps?: RouteStep[];
};

export type Route = {
  geometry: string | Coordinate[];
  segments?: RouteSegment[];
  distance?: number;
  duration?: number;
  time?: number;
};

export type AppRoute = {
  routes: Route[];
};

export type TrafficAssessmentStatus = "accepted" | "rejected" | "unavailable";

export type TrafficAssessment = {
  status: TrafficAssessmentStatus;
  provider: "tomtom";
  reason: string;
  delaySeconds: number | null;
  travelTimeSeconds: number | null;
  noTrafficTravelTimeSeconds: number | null;
  liveTrafficTravelTimeSeconds: number | null;
  trafficDelaySeconds: number | null;
  delayRatio: number | null;
  trafficLengthMeters: number | null;
  thresholdRatio: number;
  routeAttempt: number;
};

export type RouteApiResponse = {
  output?: RouteData;
  orsRoute?: AppRoute;
  trafficAssessment?: TrafficAssessment;
  error?: string;
};

export type RouteStopInput = {
  address: string;
  coords: Coordinate;
};
