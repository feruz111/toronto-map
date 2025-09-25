"use client";
import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AddressTable } from "@/components/AddressTable";
import { eventBus } from "@/lib/events";

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

  if (hoveredId != null) {
    map.setFeatureState({ source: "parcels", id: hoveredId }, { hover: false });
  }
  hoveredId = id;
  if (hoveredId != null) {
    map.setFeatureState({ source: "parcels", id: hoveredId }, { hover: true });
  }
}

function setSelected(map: maplibregl.Map, id: number | string | null) {
  const src = map.getSource("parcels") as GeoJSONSource;
  if (!src) return;

  if (selectedId != null) {
    map.setFeatureState({ source: "parcels", id: selectedId }, { selected: false });
  }
  selectedId = id;
  if (selectedId != null) {
    map.setFeatureState({ source: "parcels", id: selectedId }, { selected: true });
  }
}

function setupInteractions(map: maplibregl.Map, onSelectionChange: (id: number | string | null) => void) {
  const hoverTargets = ["parcels-fill", "parcels-line"];

  hoverTargets.forEach((layerId) => {
    // Mousemove - hover state
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const feature = e.features?.[0];
      if (!feature || feature.id === undefined) return;
      setHover(map, feature.id);
    });

    // Mouseleave - clear hover
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      setHover(map, null);
    });

    // Click - select and show popup
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const feature = e.features?.[0];
      if (!feature || feature.id === undefined) return;

      // Toggle selection
      if (selectedId === feature.id) {
        setSelected(map, null);
        loadAddressesForParcel(map, null);
        onSelectionChange(null);
      } else {
        setSelected(map, feature.id);
        loadAddressesForParcel(map, feature.id);
        onSelectionChange(feature.id);

        // Build popup content
        const props = feature.properties || {};
        const pid = props.parcel_id ?? feature.id;
        const type = props.f_type ?? "";
        const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000; position: relative;">
            <button onclick="this.closest('.maplibregl-popup').remove(); window.clearParcelSelection && window.clearParcelSelection();" style="position: absolute; top: -8px; right: -8px; background: none; border: none; font-size: 16px; cursor: pointer; color: #666; padding: 2px 6px; border-radius: 3px; line-height: 1;" title="Close">×</button>
            <div style="font-weight:600;margin-bottom:4px;color:#000;">Parcel ${pid}</div>
            ${type ? `<div style="color:#000;">Type: ${type}</div>` : ""}
            <div style="margin-top:6px;color:#000;">click anywhere else to unselect</div>
          </div>
        `;

        new maplibregl.Popup({ closeOnClick: true })
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

  // Move loadParcels to be a nested function so it has access to setSelectedParcelId
  const createLoadParcels = (onSelectionCleared: () => void) => {
    return async (map: maplibregl.Map, abortController?: AbortController) => {
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
          signal: abortController?.signal
        });

        if (res.ok) {
          const fc = await res.json();

          if (src) {
            src.setData(fc);

            // Clear hover state to avoid ghost hovers
            setHover(map, null);

            // Re-apply selected state if it exists
            if (selectedId != null) {
              try {
                map.setFeatureState({ source: "parcels", id: selectedId }, { selected: true });
              } catch {
                // Best effort - feature might not exist in new data
                console.log("[parcels] Could not restore selected state for", selectedId);
                // Clear addresses if selected parcel no longer exists
                loadAddressesForParcel(map, null);
                selectedId = null;
                onSelectionCleared();
              }
            }
          } else {
            // First time adding source and layers
            map.addSource("parcels", {
              type: "geojson",
              data: fc,
              promoteId: "parcel_id"  // Enable feature-state
            });

            // Base fill layer
            map.addLayer({
              id: "parcels-fill",
              type: "fill",
              source: "parcels",
              paint: {
                "fill-color": "#6fd3e7",
                "fill-opacity": 0.25
              },
            });

            // Base line layer
            map.addLayer({
              id: "parcels-line",
              type: "line",
              source: "parcels",
              paint: {
                "line-color": "#1b6f7e",
                "line-width": 0.6,
                "line-opacity": 0.9
              },
            });

            // Hover layer
            map.addLayer({
              id: "parcels-hover",
              type: "line",
              source: "parcels",
              paint: {
                "line-color": "#00bcd4",
                "line-width": 2
              },
              filter: ["==", ["feature-state", "hover"], true]
            });

            // Selected layer
            map.addLayer({
              id: "parcels-selected",
              type: "fill",
              source: "parcels",
              paint: {
                "fill-color": "#ffd166",
                "fill-opacity": 0.35,
                "fill-outline-color": "#e09f3e"
              },
              filter: ["==", ["feature-state", "selected"], true]
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
  };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: "map",
      style: "https://demotiles.maplibre.org/style.json",
      center: [-79.3832, 43.6532], // Toronto
      zoom: 12, // Start above MIN_Z so it fetches on load
    });

    mapRef.current = map;

    // Local function to handle parcel selection changes
    const handleParcelSelectionChange = (id: number | string | null) => {
      setSelectedParcelId(id);
    };

    // Create loadParcels with access to handleParcelSelectionChange
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
      // Add addresses source
      map.addSource("addresses", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "address_point_id"
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
    };

    // Make it available globally for popup close button
    (window as any).clearParcelSelection = clearParcelSelection;

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

      if (addressesSource && addressesSource._data) {
        const features = (addressesSource._data as any).features || [];
        const matchingFeature = features.find((f: any) =>
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

    eventBus.on("focus-address", handleFocusAddress);
    eventBus.on("close-table", handleCloseTable);

    return () => {
      // Cleanup
      eventBus.off("focus-address", handleFocusAddress);
      eventBus.off("close-table", handleCloseTable);
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      map.remove();
    };
  }, []);

  return (
    <div className="relative w-full h-screen">
      <div id="map" className="w-full h-full" />
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
      <AddressTable parcelId={selectedParcelId} />
    </div>
  );
}