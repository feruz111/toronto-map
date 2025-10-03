"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AddressTable } from "@/components/AddressTable";
import { SearchControl } from "@/components/SearchControl";
import { eventBus } from "@/lib/events";
import * as turf from "@turf/turf";

interface SchoolFeature {
  name: string;
  address_full: string;
  geom_geojson: string;
  dist_m: number;
}

interface LibraryFeature {
  branchname: string;
  address: string;
  geom_geojson: string;
  dist_m: number;
}

interface AddressFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    address_point_id: number;
    civic_number?: string | number | null;
    street_name?: string | null;
    full_address?: string | null;
  };
}

const MIN_Z = 10; // Minimum zoom level for parcel loading
const DEBOUNCE_MS = 500; // Debounce delay for API calls

// Track hover and selected states
let hoveredId: number | string | null = null;
let selectedId: number | string | null = null;

function bboxFromMap(map: maplibregl.Map) {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
}

function setHover(map: maplibregl.Map, id: number | string | null) {
  const src = map.getSource("parcels") as GeoJSONSource;
  if (!src) return;

  // Clear previous hover
  if (hoveredId != null) {
    map.setFilter("parcels-hover", ["==", ["get", "parcel_id"], ""]);
  }

  hoveredId = id;

  // Set new hover
  if (hoveredId != null) {
    map.setFilter("parcels-hover", ["==", ["get", "parcel_id"], hoveredId]);
  }
}

function setSelected(map: maplibregl.Map, id: number | string | null) {
  const src = map.getSource("parcels") as GeoJSONSource;
  if (!src) return;

  // Clear previous selection
  if (selectedId != null) {
    map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], ""]);
  }

  selectedId = id;

  // Set new selection
  if (selectedId != null) {
    map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], selectedId]);
  }
}

function setupInteractions(map: maplibregl.Map, onSelectionChange: (id: number | string | null) => void) {
  const hoverTargets = ["parcels-fill", "parcels-line"];

  hoverTargets.forEach((layerId) => {
    // Mousemove - hover state
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = e.features?.[0];
      if (!feature || !feature.properties?.parcel_id) return;
      setHover(map, feature.properties.parcel_id);
    });

    // Mouseleave - clear hover
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      setHover(map, null);
    });

    // Click - select and show popup
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature || !feature.properties?.parcel_id) return;

      const parcelId = feature.properties.parcel_id;

      // Toggle selection
      if (selectedId === parcelId) {
        setSelected(map, null);
        loadAddressesForParcel(map, null);
        onSelectionChange(null);
        // Clear buffer when deselecting
        clearBufferSource(map);
      } else {
        setSelected(map, parcelId);
        loadAddressesForParcel(map, parcelId);
        onSelectionChange(parcelId);
        // Update buffer with new polygon when selecting
        updateBufferSource(map, [e.lngLat.lng, e.lngLat.lat]);

        // Build popup content
        const props = feature.properties || {};
        const pid = props.parcel_id ?? parcelId;
        const type = props.f_type ?? "";
        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000; position: relative;">
            <button onclick="this.closest('.maplibregl-popup').remove(); window.clearParcelSelection && window.clearParcelSelection();" style="position: absolute; top: -8px; right: -8px; background: none; border: none; font-size: 16px; cursor: pointer; color: #666; padding: 2px 6px; border-radius: 3px; line-height: 1;" title="Close">×</button>
            <div style="font-weight:600;margin-bottom:4px;color:#000;">Parcel ${pid}</div>
            ${type ? `<div style="color:#000;">Type: ${type}</div>` : ""}
            <div style="margin-top:6px;color:#000;font-size:11px;">click anywhere else to unselect</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true, closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      }
    });
  });
}


async function loadAddressesForParcel(map: maplibregl.Map, parcelId: number | string | null) {
  const src = map.getSource("addresses") as GeoJSONSource;
  if (!src) return;

  if (parcelId == null) {
    src.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  const url = `/api/parcel/${parcelId}/addresses`;
  console.log("[addresses] fetching for parcel", parcelId);

  try {
    const res = await fetch(url, { cache: "no-store" });
    const fc = res.ok ? await res.json() : { type: "FeatureCollection", features: [] };
    src.setData(fc);
    console.log(`[addresses] loaded ${fc.features.length} addresses for parcel ${parcelId}`);
  } catch (error) {
    console.error("[addresses] fetch failed:", error);
    src.setData({ type: "FeatureCollection", features: [] });
  }
}

function updateBufferSource(map: maplibregl.Map, coordinates: [number, number]) {
  const bufferSource = map.getSource("buffer") as GeoJSONSource;
  if (!bufferSource) return;

  const points = turf.point(coordinates);
  const buffer = turf.buffer(points, 2000, { units: 'meters' });

  const geojson = {
    type: "FeatureCollection" as const,
    features: [buffer]
  };

  bufferSource.setData(geojson as any);
  console.log(`[buffer] created 2000m buffer around point [${coordinates[0]}, ${coordinates[1]}]`);
}

function clearBufferSource(map: maplibregl.Map) {
  const bufferSource = map.getSource("buffer") as GeoJSONSource;
  if (!bufferSource) return;

  bufferSource.setData({ type: "FeatureCollection", features: [] });
  console.log("[buffer] cleared buffer");
}

async function loadSchoolsonMap(map: maplibregl.Map, schools: SchoolFeature[], addressCoords?: [number, number]) {
  const src = map.getSource("schools") as GeoJSONSource;
  const linesSrc = map.getSource("school-lines") as GeoJSONSource;

  if (!src || !linesSrc) return;

  if (schools.length === 0) {
    src.setData({ type: "FeatureCollection", features: [] });
    linesSrc.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  // Convert schools data to GeoJSON features
  const features = schools.map(school => {
    try {
      const geom = JSON.parse(school.geom_geojson);
      return {
        type: "Feature" as const,
        geometry: geom,
        properties: {
          name: school.name,
          address_full: school.address_full,
          dist_m: school.dist_m
        }
      };
    } catch (error) {
      console.error("Error parsing school geometry:", school.geom_geojson, error);
      return null;
    }
  }).filter(Boolean);

  const geojson = {
    type: "FeatureCollection" as const,
    features: features.filter((f): f is NonNullable<typeof f> => f !== null)
  };

  src.setData(geojson as any);

  // Draw lines from address to each school
  if (addressCoords) {
    const lineFeatures = features.filter((f): f is NonNullable<typeof f> => f !== null).map(feature => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [addressCoords, feature.geometry.coordinates]
      },
      properties: {
        school_name: feature.properties.name,
        distance: feature.properties.dist_m
      }
    }));

    const linesGeoJson = {
      type: "FeatureCollection" as const,
      features: lineFeatures
    };

    linesSrc.setData(linesGeoJson as any);
  }

  console.log(`[schools] loaded ${features.length} schools on map${addressCoords ? ' with connecting lines' : ''}`);
}

async function loadLibrariesOnMap(map: maplibregl.Map, libraries: LibraryFeature[], addressCoords?: [number, number]) {
  const src = map.getSource("libraries") as GeoJSONSource;
  const linesSrc = map.getSource("library-lines") as GeoJSONSource;

  if (!src || !linesSrc) return;

  if (libraries.length === 0) {
    src.setData({ type: "FeatureCollection", features: [] });
    linesSrc.setData({ type: "FeatureCollection", features: [] });
    return;
  }

  // Convert libraries data to GeoJSON features
  const features = libraries.map(library => {
    try {
      const geom = JSON.parse(library.geom_geojson);
      return {
        type: "Feature" as const,
        geometry: geom,
        properties: {
          branchname: library.branchname,
          address: library.address,
          dist_m: library.dist_m
        }
      };
    } catch (error) {
      console.error("Error parsing library geometry:", library.geom_geojson, error);
      return null;
    }
  }).filter(Boolean);

  const geojson = {
    type: "FeatureCollection" as const,
    features: features.filter((f): f is NonNullable<typeof f> => f !== null)
  };

  src.setData(geojson as any);

  // Draw lines from address to each library
  if (addressCoords) {
    const lineFeatures = features.filter((f): f is NonNullable<typeof f> => f !== null).map(feature => ({
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [addressCoords, feature.geometry.coordinates]
      },
      properties: {
        library_name: feature.properties.branchname,
        distance: feature.properties.dist_m
      }
    }));

    const linesGeoJson = {
      type: "FeatureCollection" as const,
      features: lineFeatures
    };

    linesSrc.setData(linesGeoJson as any);
  }

  console.log(`[libraries] loaded ${features.length} libraries on map${addressCoords ? ' with connecting lines' : ''}`);
}

async function checkDbHealth() {
  try {
    const res = await fetch("/api/db", { cache: "no-store" });
    const data = await res.json();
    console.log("[db] Health check:", data);
    return data;
  } catch (error) {
    console.error("[db] Health check failed:", error);
    return { ok: false, error: "Health check failed" };
  }
}

export default function Page() {
  const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [selectedParcelId, setSelectedParcelId] = useState<number | string | null>(null);
  const [selectedAddress, setSelectedAddress] = useState<AddressFeature | null>(null);

  // Handler for school data changes
  const handleSchoolsChange = (schools: SchoolFeature[], addressCoords?: [number, number]) => {
    if (mapRef.current) {
      loadSchoolsonMap(mapRef.current, schools, addressCoords);
    }
  };

  // Handler for library data changes
  const handleLibrariesChange = (libraries: LibraryFeature[], addressCoords?: [number, number]) => {
    if (mapRef.current) {
      loadLibrariesOnMap(mapRef.current, libraries, addressCoords);
    }
  };

  // Move loadParcels to be a nested function so it has access to setSelectedParcelId
  const createLoadParcels = useCallback((_onSelectionCleared: () => void) => {
    return async (map: maplibregl.Map, _abortController?: AbortController) => {
      const z = map.getZoom();
      const bbox = bboxFromMap(map);
      const zoomMessage = document.getElementById("zoom-message");

      console.log("[parcels] z=", z.toFixed(2), "bbox=", bbox);

      const src = map.getSource("parcels") as GeoJSONSource | undefined;

      if (z < MIN_Z) {
        console.log("[parcels] below MIN_Z, clearing source");
        if (src) src.setData({ type: "FeatureCollection", features: [] });
        // Show zoom message
        if (zoomMessage) zoomMessage.style.display = "block";
        return;
      }

      // Hide zoom message when zoom is sufficient
      if (zoomMessage) zoomMessage.style.display = "none";

      const url = `/api/parcels?bbox=${bbox}&z=${z.toFixed(2)}`;
      console.log("[parcels] fetching", url);

      try {
        const res = await fetch(url, {
          cache: "default", // Use browser cache
          signal: _abortController?.signal
        });

        if (res.ok) {
          const fc = await res.json();

          if (src) {
            src.setData(fc);

            // Clear hover state to avoid ghost hovers
            setHover(map, null);

            // Re-apply selected state if it exists
            if (selectedId != null) {
              // Since we're using filter-based selection, we just restore the filter
              map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], selectedId]);
            }
          } else {
            // First time adding source and layers
            map.addSource("parcels", {
              type: "geojson",
              data: fc
            });

            // Base fill layer - using a land-colored palette
            map.addLayer({
              id: "parcels-fill",
              type: "fill",
              source: "parcels",
              paint: {
                "fill-color": "#e8f5e8",
                "fill-opacity": 0.4
              },
            });

            // Base line layer - dark green for land boundaries
            map.addLayer({
              id: "parcels-line",
              type: "line",
              source: "parcels",
              paint: {
                "line-color": "#2d5016",
                "line-width": 0.8,
                "line-opacity": 0.9
              },
            });

            // Hover layer (will be controlled via setFilter)
            map.addLayer({
              id: "parcels-hover",
              type: "line",
              source: "parcels",
              paint: {
                "line-color": "#ff6b35",
                "line-width": 2.5,
                "line-opacity": 1
              },
              filter: ["==", ["get", "parcel_id"], ""]
            });

            // Selected layer (will be controlled via setFilter)
            map.addLayer({
              id: "parcels-selected",
              type: "fill",
              source: "parcels",
              paint: {
                "fill-color": "#ffd166",
                "fill-opacity": 0.35,
                "fill-outline-color": "#e09f3e"
              },
              filter: ["==", ["get", "parcel_id"], ""]
            });

            // Set up interactions after layers are created
            setupInteractions(map, setSelectedParcelId);
          }
        } else {
          console.warn("[parcels] API error:", res.status);
          if (src) src.setData({ type: "FeatureCollection", features: [] });
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.warn("[parcels] fetch failed:", error);
          if (src) src.setData({ type: "FeatureCollection", features: [] });
        }
      }
    };
  }, []);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        sources: {
          'raster-tiles': {
            type: 'raster',
            tiles: [
              'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
            ],
            tileSize: 256,
            maxzoom: 19
          }
        },
        layers: [
          {
            id: 'osm-tiles',
            type: 'raster',
            source: 'raster-tiles',
            minzoom: 0,
            maxzoom: 22
          }
        ]
      },
      center: [-79.3832, 43.6532], // Toronto
      zoom: 12, // Start above MIN_Z so it fetches on load
    });

    mapRef.current = map;

    // Create loadParcels with access to setSelectedParcelId
    const loadParcels = createLoadParcels(() => setSelectedParcelId(null));

    const debouncedLoadParcels = () => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Clear previous timeout
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      // Create new abort controller
      abortControllerRef.current = new AbortController();

      // Set new timeout
      debounceTimeoutRef.current = setTimeout(() => {
        loadParcels(map, abortControllerRef.current);
      }, DEBOUNCE_MS);
    };

    map.on("load", () => {
      // Hide all text/symbol layers from the map style
      const style = map.getStyle();
      if (style && style.layers) {
        style.layers.forEach((layer: any) => {
          if (layer.type === "symbol" ||
            (layer.layout && layer.layout["text-field"]) ||
            (layer.id && layer.id.includes("label")) ||
            (layer.id && layer.id.includes("text"))) {
            try {
              map.removeLayer(layer.id);
            } catch (e) {
              // Layer might already be removed or not found
              console.log(`Could not remove layer: ${layer.id}`);
            }
          }
        });
      }

      // Add addresses source
      map.addSource("addresses", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add schools source
      map.addSource("schools", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add school lines source
      map.addSource("school-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add libraries source
      map.addSource("libraries", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add library lines source
      map.addSource("library-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add buffer source
      map.addSource("buffer", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] }
      });

      // Add addresses layer
      map.addLayer({
        id: "addresses-points",
        type: "circle",
        source: "addresses",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, 2.5,
            14, 4,
            18, 6
          ],
          "circle-color": "#ff4d4f",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1
        }
      });

      // Add schools layer
      map.addLayer({
        id: "schools-points",
        type: "circle",
        source: "schools",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, 8,
            14, 12,
            18, 16
          ],
          "circle-color": "#FF0000",
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 3
        }
      });

      // Add school lines layer
      map.addLayer({
        id: "school-lines",
        type: "line",
        source: "school-lines",
        paint: {
          "line-color": "#FF6B35",
          "line-width": 2,
          "line-opacity": 0.7,
          "line-dasharray": [5, 5]
        }
      });

      // Add libraries layer
      map.addLayer({
        id: "libraries-points",
        type: "circle",
        source: "libraries",
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, 8,
            14, 12,
            18, 16
          ],
          "circle-color": "#0066CC",
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 3
        }
      });

      // Add library lines layer
      map.addLayer({
        id: "library-lines",
        type: "line",
        source: "library-lines",
        paint: {
          "line-color": "#4A90E2",
          "line-width": 2,
          "line-opacity": 0.7,
          "line-dasharray": [5, 5]
        }
      });

      // Add buffer fill layer (semi-transparent)
      map.addLayer({
        id: "buffer-fill",
        type: "fill",
        source: "buffer",
        paint: {
          "fill-color": "#3b82f6",
          "fill-opacity": 0.2
        }
      });

      // Add buffer line layer (border)
      map.addLayer({
        id: "buffer-line",
        type: "line",
        source: "buffer",
        paint: {
          "line-color": "#3b82f6",
          "line-width": 2,
          "line-opacity": 0.8
        }
      });

      // Add click handler for addresses
      map.on("click", "addresses-points", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const addressId = props.address_point_id ?? feature.id;
        const fullAddress = props.full_address;

        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            ${fullAddress ?
            `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
               <div style="color: #666; font-size: 11px;">Address Point: ${addressId}</div>` :
            `<div style="font-weight:600; color: #000;">Address Point: ${addressId}</div>`
          }
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      // Change cursor on address hover
      map.on("mouseenter", "addresses-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "addresses-points", () => {
        map.getCanvas().style.cursor = "";
      });

      // Add click handler for schools
      map.on("click", "schools-points", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const schoolName = props.name;
        const distance = props.dist_m;

        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="font-weight:600; color: #000; margin-bottom: 4px;">${schoolName}</div>
            <div style="color: #666; font-size: 11px;">Distance: ${Math.round(distance)}m</div>
            <div style="color: #666; font-size: 11px; margin-top: 2px;">Address: ${props.address_full || 'Unknown'}</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      // Add click handler for libraries
      map.on("click", "libraries-points", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const libraryName = props.branchname;
        const distance = props.dist_m;

        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="font-weight:600; color: #000; margin-bottom: 4px;">${libraryName}</div>
            <div style="color: #666; font-size: 11px;">Distance: ${Math.round(distance)}m</div>
            <div style="color: #666; font-size: 11px; margin-top: 2px;">Address: ${props.address || 'Unknown'}</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      // Change cursor on school hover
      map.on("mouseenter", "schools-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "schools-points", () => {
        map.getCanvas().style.cursor = "";
      });

      // Change cursor on library hover
      map.on("mouseenter", "libraries-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "libraries-points", () => {
        map.getCanvas().style.cursor = "";
      });

      // Add hover effect for school lines
      map.on("mouseenter", "school-lines", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "school-lines", () => {
        map.getCanvas().style.cursor = "";
      });

      // Add hover effect for library lines
      map.on("mouseenter", "library-lines", () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", "library-lines", () => {
        map.getCanvas().style.cursor = "";
      });

      // Add click handler for school lines
      map.on("click", "school-lines", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const schoolName = props.school_name;
        const distance = props.distance;

        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="font-weight:600; color: #000; margin-bottom: 4px;">Line to: ${schoolName}</div>
            <div style="color: #666; font-size: 11px;">Distance: ${Math.round(distance)}m</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      // Add click handler for library lines
      map.on("click", "library-lines", (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;

        const props = feature.properties || {};
        const libraryName = props.library_name;
        const distance = props.distance;

        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="font-weight:600; color: #000; margin-bottom: 4px;">Line to: ${libraryName}</div>
            <div style="color: #666; font-size: 11px;">Distance: ${Math.round(distance)}m</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
          .setLngLat(e.lngLat)
          .setHTML(html)
          .addTo(map);
      });

      loadParcels(map);
    });

    map.on("moveend", debouncedLoadParcels);

    // Add DB health check to console for debugging
    console.log("[db] To check DB health, run: checkDbHealth()");
    (window as unknown as { checkDbHealth: typeof checkDbHealth }).checkDbHealth = checkDbHealth;

    // Function to clear parcel selection
    const clearParcelSelection = () => {
      setSelected(map, null);
      loadAddressesForParcel(map, null);
      setSelectedParcelId(null);
      setSelectedAddress(null);
      loadSchoolsonMap(map, []);
      loadLibrariesOnMap(map, []);
      clearBufferSource(map);
    };

    // Make it available globally for popup close button
    (window as unknown as { clearParcelSelection: () => void }).clearParcelSelection = clearParcelSelection;

    // Set up event listener for focus-address events
    const handleFocusAddress = ({ id, lngLat }: { id: number | string; lngLat: [number, number] }) => {
      map.easeTo({
        center: lngLat,
        zoom: Math.max(map.getZoom(), 16)
      });

      // Show popup at the address point
      // Try to find the feature in the addresses source to get full address
      const addressesSource = map.getSource("addresses") as GeoJSONSource;
      let fullAddress = null;

      if (addressesSource?._data) {
        const features = (addressesSource._data as { features?: Array<{ properties?: { address_point_id?: number | string; full_address?: string } }> }).features || [];
        const matchingFeature = features.find((f) =>
          f.properties?.address_point_id === id
        );
        fullAddress = matchingFeature?.properties?.full_address;
      }

      const html = `
        <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
          ${fullAddress ?
          `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
             <div style="color: #666; font-size: 11px;">Address Point: ${id}</div>` :
          `<div style="font-weight:600; color: #000;">Address Point: ${id}</div>`
        }
        </div>
      `;

      new maplibregl.Popup({ closeOnClick: true })
        .setLngLat(lngLat)
        .setHTML(html)
        .addTo(map);
    };

    // Set up event listener for close-table events
    const handleCloseTable = () => {
      clearParcelSelection();
    };

    // Set up event listener for parcel selection from address
    const handleSelectParcel = ({ parcelId }: { parcelId: number | string }) => {
      setSelected(map, parcelId);
      loadAddressesForParcel(map, parcelId);
      setSelectedParcelId(parcelId);
    };

    // Set up event listener for select-address events
    const handleSelectAddress = (address: AddressFeature) => {
      setSelectedAddress(address);
    };



    eventBus.on("focus-address", handleFocusAddress);
    eventBus.on("close-table", handleCloseTable);
    eventBus.on("select-parcel", handleSelectParcel);
    eventBus.on("select-address", handleSelectAddress);

    return () => {
      // Cleanup
      eventBus.off("focus-address", handleFocusAddress);
      eventBus.off("close-table", handleCloseTable);
      eventBus.off("select-parcel", handleSelectParcel);
      eventBus.off("select-address", handleSelectAddress);
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      map.remove();
    };
  }, [createLoadParcels]);

  return (
    <div className="relative w-full h-screen">
      <div id="map" className="w-full h-full" />

      {/* Search Control - Top Left */}
      <div
        style={{
          position: "absolute",
          top: "20px",
          left: "20px",
          zIndex: 1000,
          width: "320px",
        }}
      >
        <SearchControl />
      </div>

      {/* Zoom Message - Top Center */}
      <div
        id="zoom-message"
        style={{
          position: "absolute",
          top: "20px",
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0, 0, 0, 0.8)",
          color: "white",
          padding: "10px 20px",
          borderRadius: "5px",
          fontSize: "14px",
          display: "none",
          zIndex: 1000,
        }}
      >
        Zoom in to load parcels
      </div>

      {/* Address Table - Right Side (now includes schools and libraries) */}
      <AddressTable
        parcelId={selectedParcelId}
        selectedAddress={selectedAddress}
        onSchoolsChange={handleSchoolsChange}
        onLibrariesChange={handleLibrariesChange}
      />
    </div>
  );
}