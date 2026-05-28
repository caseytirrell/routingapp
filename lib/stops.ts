import type { Coordinate, Property, StopOption } from "./route-types";

export const NURSERY_ADDRESS = "168 Heyers Mill Rd, Colts Neck, NJ 07722";

type PropertyDraft = Omit<Property, "propertyType">;

const residential = (property: PropertyDraft): Property => ({
  ...property,
  propertyType: "residential",
});

const commercial = (property: PropertyDraft): Property => ({
  ...property,
  propertyType: "commercial",
});

export const nurseryStop: StopOption = {
  customerName: "Nursery",
  address: NURSERY_ADDRESS,
  coords: [-74.187268, 40.301599],
  propertyType: "commercial",
  isNursery: true,
};

export const properties: Property[] = [
  residential({ customerName: "Averbach Family", address: "3 Zachary Way, Tinton Falls, NJ 07724", coords: [-74.03599, 40.2774] }),
  residential({ customerName: "Colantoni Family", address: "11 Brandywine Ln, Colts Neck, NJ 07722", coords: [-74.13903, 40.311325] }),
  residential({ customerName: "Eilenberg Family 1", address: "20 Springhouse Rd, Ocean, NJ 08712", coords: [-74.061508, 40.242782] }),
  residential({ customerName: "Eilenberg Family 2", address: "39 Harvey Dr, Short Hills, NJ 07078", coords: [-74.340281, 40.743923] }),
  residential({ customerName: "Fisher Family", address: "103 The Terrace, Seagirt, NJ 08750", coords: [-74.028897, 40.138017] }),
  residential({ customerName: "Gerrity Family", address: "29 Clarksburg Rd, Millstone Township, NJ 08510", coords: [-74.293023, 40.316136] }),
  residential({ customerName: "Koenig Family", address: "217 Beacon Blvd, Seagirt, NJ 08750", coords: [-74.032463, 40.137463] }),
  residential({ customerName: "Laverda Family", address: "4 Polo Club Dr, Tinton Falls, NJ 07724", coords: [-74.075084, 40.313041] }),
  residential({ customerName: "Lerner Family", address: "44 Glenwood Rd, Colts Neck, NJ 07722", coords: [-74.2193, 40.339825] }),
  residential({ customerName: "MacDonald Family", address: "16 Bretwood Dr, Colts Neck, NJ 07722", coords: [-74.179607, 40.284531] }),
  residential({ customerName: "Maizel Family", address: "120 Davis Ln, Red Bank, NJ 07701", coords: [-74.091161, 40.3483229] }),
  residential({ customerName: "McKenna Family", address: "3 Williamsburg N, Colts Neck, NJ 07722", coords: [-74.18596, 40.291659] }),
  residential({ customerName: "Peake Family", address: "25 Wardell Ave, Rumson, NJ 07760", coords: [-74.026324, 40.345205] }),
  residential({ customerName: "Premtaj Family", address: "1058 Franklin Lakes Rd, Franklin Lakes, NJ 07417", coords: [-74.233561, 40.997836] }),
  residential({ customerName: "Sessa Family", address: "83 Hazel Dr, Freehold, NJ 07728", coords: [-74.313458, 40.246766] }),
  residential({ customerName: "Shannon Family", address: "6 Ocala Ct, Freehold, NJ 07728", coords: [-74.326666, 40.23359] }),
  residential({ customerName: "Wolosow Family", address: "41 Heather Dr, Manalapn, NJ 07726", coords: [-74.293023, 40.316136] }),
  commercial({ customerName: "Centrastate Large Building", address: "901 West Main Street, Freehold, NJ 07728", coords: [-74.311356, 40.238205] }),
  commercial({ customerName: "Centrastate Small Building", address: "1001 West Main Street, Freehold, NJ 07728", coords: [-74.314804, 40.234732] }),
  commercial({ customerName: "45 Pearl St", address: "45 Pearl St, Metuchen, NJ 08840", coords: [-74.363352, 40.541416] }),
  commercial({ customerName: "2301 Park Ave", address: "2301 Park Ave, South Plainfield, NJ 07080", coords: [-74.398707, 40.593213] }),
  commercial({ customerName: "416 Rt. 18", address: "416 nj-18, East Brunswick, NJ 08816", coords: [-74.396427, 40.447247] }),
  commercial({ customerName: "2 Walnut Rd", address: "2 Walnut Rd, Freehold, NJ 07901", coords: [-74.353382, 40.714541] }),
  commercial({ customerName: "4 Giralda Farms", address: "4 Giralda Farms, Madison, NJ 07940", coords: [-74.435788, 40.767136] }),
  commercial({ customerName: "11 Saddle Rd", address: "11 Saddle Rd, Hanover, NJ 07927", coords: [-74.466126, 40.815997] }),
  commercial({ customerName: "99 Beauvoir Ave(OMC & Pediatric Entrance)", address: "99 Beauvoir Ave, Summit, NJ 07901", coords: [-74.354624, 40.712355] }),
  commercial({ customerName: "100 Madison Ave(Roof-Top Garden & Garden Patio)", address: "100 Madison Ave, Morristown, NJ 07960", coords: [-74.465685, 40.789571] }),
  commercial({ customerName: "310 South St", address: "310 South St, Morristown, NJ 07960", coords: [-74.467871, 40.785917] }),
  commercial({ customerName: "435 South St", address: "435 South St, Morristown, NJ 07960", coords: [-74.469166, 40.776995] }),
  commercial({ customerName: "465 South St", address: "465 South St, Morristown, NJ 07960", coords: [-74.469041, 40.774349] }),
  commercial({ customerName: "475 South St", address: "475 South St, Morristown, NJ 07960", coords: [-74.469637, 40.772897] }),
  commercial({ customerName: "492 Main St", address: "492 Main St, Chatham, NJ 07928", coords: [-74.232081, 40.744936] }),
  commercial({ customerName: "10 Overlook Rd", address: "10 Overlook Rd, Summit, NJ 07901", coords: [-74.351978, 40.713796] }),
  commercial({ customerName: "15 Randolph Dr", address: "15 Randolph Rd, Morristown, NJ 07960", coords: [-74.462612, 40.789091] }),
  commercial({ customerName: "55 Madison Ave", address: "55 Madison Ave, Freehold, NJ 07960", coords: [-74.467879, 40.787711] }),
  commercial({ customerName: "65 Madison Ave", address: "65 Madison Ave, Freehold, NJ 07960", coords: [-74.466730, 40.787630] }),
  commercial({ customerName: "95 Madison Ave", address: "95 Madison Ave, Freehold, NJ 07960", coords: [-74.464547, 40.787131] }),
  commercial({ customerName: "101 Madison Ave", address: "101 Madison Ave, Freehold, NJ 07960", coords: [-74.463496, 40.786929] }),
  commercial({ customerName: "111 Madison Ave", address: "111 Madison Ave, Freehold, NJ 07960", coords: [-74.462183, 40.787691] }),
  commercial({ customerName: "100 Franklin Village", address: "100 Franklin St, Morristown, NJ 07960", coords: [-74.467328, 40.791835] }),
  commercial({ customerName: "385 Morris Ave", address: "385 Morris Ave, Springfield, NJ 07081", coords: [-74.317368, 40.713517] }),
  commercial({ customerName: "Site One", address: "3 Industrial Ct, Freehold, NJ 07728", coords: [-74.232081, 40.230114] }),
];

export const startCoordsMap = new Map<string, Coordinate>([
  [NURSERY_ADDRESS, [-74.187268, 40.301599]],
  ["475 South St, Morristown, NJ 07960", [-74.480619, 40.781894]],
]);

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}
