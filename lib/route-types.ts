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
  summary?: {
    distance?: number;
    duration?: number;
  };
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

export type CommercialValidationStatus = "passed" | "rejected" | "unknown";

export type CommercialRestrictionValidation = {
  status: CommercialValidationStatus;
  reason: string;
  matchedRules: string[];
};

export type RouteDecisionCandidate = {
  id: string;
  provider: "ors" | "geoapify" | "google";
  label: string;
  selected: boolean;
  accepted: boolean;
  rejectionReason: string | null;
  distanceMeters: number | null;
  routeDurationSeconds: number | null;
  tomTomTravelTimeSeconds: number | null;
  tomTomDelaySeconds: number | null;
  tomTomDelayRatio: number | null;
  commercialValidation: CommercialRestrictionValidation;
  trafficAssessment: TrafficAssessment;
};

export type RouteDecisionReport = {
  selectedCandidateId: string | null;
  selectedReason: string;
  candidateCount: number;
  scoredCandidateCount: number;
  candidates: RouteDecisionCandidate[];
};

export type RouteApiResponse = {
  output?: RouteData;
  orsRoute?: AppRoute;
  trafficAssessment?: TrafficAssessment;
  routeDecision?: RouteDecisionReport;
  error?: string;
};

export type RouteStopInput = {
  address: string;
  coords: Coordinate;
};
