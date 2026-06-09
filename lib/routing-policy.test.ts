import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "./route-types";
import {
  chooseRouteCandidate,
  createRouteCandidates,
  validateCommercialRestrictions,
} from "./routing-policy";

const commercialRoute: Route = {
  geometry: [
    [-74.2, 40.2],
    [-74.1, 40.25],
  ],
  duration: 300,
  distance: 5_000,
  segments: [
    {
      steps: [
        {
          instruction: "Continue on Route 18",
          name: "Route 18",
          way_points: [0, 1],
        },
      ],
    },
  ],
};

function routeUsingGardenStateParkway(latitude: number): Route {
  return {
    geometry: [
      [-74.2, latitude],
      [-74.1, latitude + 0.001],
    ],
    duration: 120,
    distance: 3_000,
    segments: [
      {
        steps: [
          {
            instruction: "Merge onto Garden State Parkway",
            name: "Garden State Parkway",
            way_points: [0, 1],
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("validateCommercialRestrictions", () => {
  it("rejects Garden State Parkway use north of Interchange 105", () => {
    const validation = validateCommercialRestrictions(
      routeUsingGardenStateParkway(40.4)
    );

    expect(validation.status).toBe("rejected");
    expect(validation.matchedRules).toContain("Garden State Parkway");
  });

  it("allows Garden State Parkway use south of Interchange 105", () => {
    const validation = validateCommercialRestrictions(
      routeUsingGardenStateParkway(40.1)
    );

    expect(validation.status).toBe("passed");
  });
});

describe("chooseRouteCandidate", () => {
  it("chooses a slower commercially valid route over a faster restricted route", async () => {
    vi.stubEnv("TOMTOM_API_KEY", "");

    const result = await chooseRouteCandidate(
      [
        ...createRouteCandidates(
          { routes: [routeUsingGardenStateParkway(40.4)] },
          "google",
          1
        ),
        ...createRouteCandidates({ routes: [commercialRoute] }, "ors", 1),
      ],
      { scoreAllCandidates: true }
    );

    expect(result.routeData.routes[0]).toBe(commercialRoute);
    expect(result.routeDecision.selectedCandidateId).toBe("ors-1");
    expect(
      result.routeDecision.candidates.find((candidate) => candidate.id === "google-1")
        ?.commercialValidation.status
    ).toBe("rejected");
  });

  it("refuses to select a fallback when every candidate is commercially rejected", async () => {
    vi.stubEnv("TOMTOM_API_KEY", "");

    await expect(
      chooseRouteCandidate(
        createRouteCandidates(
          { routes: [routeUsingGardenStateParkway(40.4)] },
          "google",
          1
        ),
        { scoreAllCandidates: true }
      )
    ).rejects.toThrow("No commercially valid route candidates were available");
  });

  it("keeps a commercially valid route selectable when TomTom traffic times out", async () => {
    vi.useFakeTimers();
    vi.stubEnv("TOMTOM_API_KEY", "test-key");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );

    const resultPromise = chooseRouteCandidate(
      createRouteCandidates({ routes: [commercialRoute] }, "ors", 1),
      { scoreAllCandidates: true }
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result.routeData.routes[0]).toBe(commercialRoute);
    expect(result.trafficAssessment.status).toBe("unavailable");
    expect(result.trafficAssessment.reason).toContain("TomTom request timed out");
  });
});
