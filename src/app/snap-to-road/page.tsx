"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SimpleAddressTable } from "@/components/SimpleAddressTable";
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
                // Clear snap-to-road data when deselecting parcel
                const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
                if (snapSource) {
                    snapSource.setData({ type: "FeatureCollection", features: [] });
                }
            } else {
                setSelected(map, parcelId);
                loadAddressesForParcel(map, parcelId);
                onSelectionChange(parcelId);
                // Clear snap-to-road data when selecting new parcel
                const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
                if (snapSource) {
                    snapSource.setData({ type: "FeatureCollection", features: [] });
                }

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

export default function SnapToRoadPage() {
    const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const abortControllerRef = useRef<AbortController | undefined>(undefined);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const [selectedParcelId, setSelectedParcelId] = useState<number | string | null>(null);

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
            // Hide all text/symbol layers and POI markers from the map style
            const style = map.getStyle();
            if (style && style.layers) {
                style.layers.forEach((layer: any) => {
                    if (layer.type === "symbol" ||
                        (layer.layout && layer.layout["text-field"]) ||
                        (layer.id && layer.id.includes("label")) ||
                        (layer.id && layer.id.includes("text")) ||
                        (layer.id && layer.id.includes("poi")) ||
                        (layer.id && layer.id.includes("place")) ||
                        (layer.id && layer.id.includes("amenity")) ||
                        (layer.id && layer.id.includes("shop")) ||
                        (layer.id && layer.id.includes("tourism")) ||
                        (layer.id && layer.id.includes("leisure")) ||
                        (layer.id && layer.id.includes("healthcare")) ||
                        (layer.id && layer.id.includes("education")) ||
                        (layer.id && layer.id.includes("government")) ||
                        (layer.id && layer.id.includes("office")) ||
                        (layer.id && layer.id.includes("building")) ||
                        (layer.id && layer.id.includes("waterway")) ||
                        (layer.id && layer.id.includes("natural")) ||
                        (layer.id && layer.id.includes("landuse"))) {
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
            map.on("click", "addresses-points", async (e: MapLayerMouseEvent) => {
                const feature = e.features?.[0];
                if (!feature) return;

                const props = feature.properties || {};
                const addressId = props.address_point_id ?? feature.id;
                const fullAddress = props.full_address;
                const [lng, lat] = e.lngLat.toArray();

                // Call snap-to-road API
                try {
                    const snapResponse = await fetch(`/api/snap-to-road?lat=${lat}&lng=${lng}`);
                    const snapData = await snapResponse.json();

                    if (snapData.snap && snapData.snap.length > 0) {
                        const snapResult = snapData.snap[0];

                        // Clear previous snap-to-road data
                        const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
                        if (snapSource) {
                            snapSource.setData({ type: "FeatureCollection", features: [] });
                        }

                        // Add snap-to-road source if it doesn't exist
                        if (!snapSource) {
                            map.addSource("snap-to-road", {
                                type: "geojson",
                                data: { type: "FeatureCollection", features: [] }
                            });
                        }

                        // Create features for road, snap point, and connecting line
                        const features: any[] = [];

                        // Add road geometry
                        if (snapResult.offset_line_geojson) {
                            const roadGeom = JSON.parse(snapResult.offset_line_geojson);
                            features.push({
                                type: "Feature" as const,
                                properties: { type: "road" },
                                geometry: roadGeom
                            });
                        }

                        // Add snap point
                        if (snapResult.snap_geojson) {
                            const snapGeom = JSON.parse(snapResult.snap_geojson);
                            features.push({
                                type: "Feature" as const,
                                properties: {
                                    type: "snap_point",
                                    street: snapResult.street,
                                    distance: snapResult.dist_m
                                },
                                geometry: snapGeom
                            });
                        }

                        // Add connecting line from address to snap point
                        features.push({
                            type: "Feature" as const,
                            properties: { type: "connection_line" },
                            geometry: {
                                type: "LineString",
                                coordinates: [[lng, lat], JSON.parse(snapResult.snap_geojson).coordinates]
                            }
                        });

                        // Update snap-to-road source
                        const updatedSnapSource = map.getSource("snap-to-road") as GeoJSONSource;
                        updatedSnapSource.setData({
                            type: "FeatureCollection",
                            features: features
                        });

                        // Add layers if they don't exist
                        if (!map.getLayer("snap-road")) {
                            map.addLayer({
                                id: "snap-road",
                                type: "line",
                                source: "snap-to-road",
                                filter: ["==", ["get", "type"], "road"],
                                paint: {
                                    "line-color": "#ff6b35",
                                    "line-width": 3,
                                    "line-opacity": 0.8
                                }
                            });
                        }

                        if (!map.getLayer("snap-point")) {
                            map.addLayer({
                                id: "snap-point",
                                type: "circle",
                                source: "snap-to-road",
                                filter: ["==", ["get", "type"], "snap_point"],
                                paint: {
                                    "circle-radius": 6,
                                    "circle-color": "#ff6b35",
                                    "circle-stroke-color": "#ffffff",
                                    "circle-stroke-width": 2
                                }
                            });
                        }

                        if (!map.getLayer("snap-connection")) {
                            map.addLayer({
                                id: "snap-connection",
                                type: "line",
                                source: "snap-to-road",
                                filter: ["==", ["get", "type"], "connection_line"],
                                paint: {
                                    "line-color": "#ff6b35",
                                    "line-width": 2,
                                    "line-dasharray": [2, 2],
                                    "line-opacity": 0.7
                                }
                            });
                        }

                        // Create popup with snap-to-road information
                        const distance = Math.round(snapResult.dist_m * 100) / 100; // Round to 2 decimal places
                        const html = `
                  <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
                    ${fullAddress ?
                                `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
                       <div style="color: #666; font-size: 11px;">Address Point: ${addressId}</div>` :
                                `<div style="font-weight:600; color: #000;">Address Point: ${addressId}</div>`
                            }
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                      <div style="font-weight: 600; color: #ff6b35; margin-bottom: 4px;">Snap to Road</div>
                      <div style="color: #000; font-size: 11px;">Street: ${snapResult.street || 'Unknown'}</div>
                      <div style="color: #000; font-size: 11px;">Distance: ${distance}m</div>
                    </div>
                  </div>
                `;

                        new maplibregl.Popup({ closeOnClick: true })
                            .setLngLat(e.lngLat)
                            .setHTML(html)
                            .addTo(map);
                    } else {
                        // Fallback to original popup if snap-to-road fails
                        const html = `
                  <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
                    ${fullAddress ?
                                `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
                       <div style="color: #666; font-size: 11px;">Address Point: ${addressId}</div>` :
                                `<div style="font-weight:600; color: #000;">Address Point: ${addressId}</div>`
                            }
                    <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                      <div style="color: #ff6b35; font-size: 11px;">Unable to snap to road</div>
                    </div>
                  </div>
                `;

                        new maplibregl.Popup({ closeOnClick: true })
                            .setLngLat(e.lngLat)
                            .setHTML(html)
                            .addTo(map);
                    }
                } catch (error) {
                    console.error("Error calling snap-to-road API:", error);

                    // Fallback to original popup
                    const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            ${fullAddress ?
                            `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
               <div style="color: #666; font-size: 11px;">Address Point: ${addressId}</div>` :
                            `<div style="font-weight:600; color: #000;">Address Point: ${addressId}</div>`
                        }
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                  <div style="color: #ff6b35; font-size: 11px;">Error loading road data</div>
                </div>
          </div>
        `;

                    new maplibregl.Popup({ closeOnClick: true })
                        .setLngLat(e.lngLat)
                        .setHTML(html)
                        .addTo(map);
                }
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

        // Clear snap-to-road data when clicking on empty areas
        map.on("click", (e) => {
            // Check if the click was on a parcel or address
            const features = map.queryRenderedFeatures(e.point, {
                layers: ["parcels-fill", "parcels-line", "addresses-points"]
            });

            // If no features were clicked, clear snap-to-road data
            if (features.length === 0) {
                const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
                if (snapSource) {
                    snapSource.setData({ type: "FeatureCollection", features: [] });
                }
            }
        });

        // Function to clear snap-to-road data
        const clearSnapToRoad = () => {
            const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
            if (snapSource) {
                snapSource.setData({ type: "FeatureCollection", features: [] });
            }
        };

        // Function to clear parcel selection
        const clearParcelSelection = () => {
            setSelected(map, null);
            loadAddressesForParcel(map, null);
            setSelectedParcelId(null);
            clearSnapToRoad(); // Also clear snap-to-road data
        };

        // Make it available globally for popup close button
        (window as unknown as { clearParcelSelection: () => void }).clearParcelSelection = clearParcelSelection;

        // Set up event listener for focus-address events
        const handleFocusAddress = async ({ id, lngLat }: { id: number | string; lngLat: [number, number] }) => {
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

            // Call snap-to-road API
            try {
                const [lng, lat] = lngLat;
                const snapResponse = await fetch(`/api/snap-to-road?lat=${lat}&lng=${lng}`);
                const snapData = await snapResponse.json();

                if (snapData.snap && snapData.snap.length > 0) {
                    const snapResult = snapData.snap[0];

                    // Clear previous snap-to-road data
                    const snapSource = map.getSource("snap-to-road") as GeoJSONSource;
                    if (snapSource) {
                        snapSource.setData({ type: "FeatureCollection", features: [] });
                    }

                    // Add snap-to-road source if it doesn't exist
                    if (!snapSource) {
                        map.addSource("snap-to-road", {
                            type: "geojson",
                            data: { type: "FeatureCollection", features: [] }
                        });
                    }

                    // Create features for road, snap point, and connecting line
                    const features: any[] = [];

                    // Add road geometry
                    if (snapResult.offset_line_geojson) {
                        const roadGeom = JSON.parse(snapResult.offset_line_geojson);
                        features.push({
                            type: "Feature" as const,
                            properties: { type: "road" },
                            geometry: roadGeom
                        });
                    }

                    // Add snap point
                    if (snapResult.snap_geojson) {
                        const snapGeom = JSON.parse(snapResult.snap_geojson);
                        features.push({
                            type: "Feature" as const,
                            properties: {
                                type: "snap_point",
                                street: snapResult.street,
                                distance: snapResult.dist_m
                            },
                            geometry: snapGeom
                        });
                    }

                    // Add connecting line from address to snap point
                    features.push({
                        type: "Feature" as const,
                        properties: { type: "connection_line" },
                        geometry: {
                            type: "LineString",
                            coordinates: [[lng, lat], JSON.parse(snapResult.snap_geojson).coordinates]
                        }
                    });

                    // Update snap-to-road source
                    const updatedSnapSource = map.getSource("snap-to-road") as GeoJSONSource;
                    updatedSnapSource.setData({
                        type: "FeatureCollection",
                        features: features
                    });

                    // Add layers if they don't exist
                    if (!map.getLayer("snap-road")) {
                        map.addLayer({
                            id: "snap-road",
                            type: "line",
                            source: "snap-to-road",
                            filter: ["==", ["get", "type"], "road"],
                            paint: {
                                "line-color": "#ff6b35",
                                "line-width": 3,
                                "line-opacity": 0.8
                            }
                        });
                    }

                    if (!map.getLayer("snap-point")) {
                        map.addLayer({
                            id: "snap-point",
                            type: "circle",
                            source: "snap-to-road",
                            filter: ["==", ["get", "type"], "snap_point"],
                            paint: {
                                "circle-radius": 6,
                                "circle-color": "#ff6b35",
                                "circle-stroke-color": "#ffffff",
                                "circle-stroke-width": 2
                            }
                        });
                    }

                    if (!map.getLayer("snap-connection")) {
                        map.addLayer({
                            id: "snap-connection",
                            type: "line",
                            source: "snap-to-road",
                            filter: ["==", ["get", "type"], "connection_line"],
                            paint: {
                                "line-color": "#ff6b35",
                                "line-width": 2,
                                "line-dasharray": [2, 2],
                                "line-opacity": 0.7
                            }
                        });
                    }

                    // Create popup with snap-to-road information
                    const distance = Math.round(snapResult.dist_m * 100) / 100; // Round to 2 decimal places
                    const html = `
                <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
                  ${fullAddress ?
                            `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
                   <div style="color: #666; font-size: 11px;">Address Point: ${id}</div>` :
                            `<div style="font-weight:600; color: #000;">Address Point: ${id}</div>`
                        }
                  <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                    <div style="font-weight: 600; color: #ff6b35; margin-bottom: 4px;">Snap to Road</div>
                    <div style="color: #000; font-size: 11px;">Street: ${snapResult.street || 'Unknown'}</div>
                    <div style="color: #000; font-size: 11px;">Distance: ${distance}m</div>
                  </div>
                </div>
              `;

                    new maplibregl.Popup({ closeOnClick: true })
                        .setLngLat(lngLat)
                        .setHTML(html)
                        .addTo(map);
                } else {
                    // Fallback to original popup if snap-to-road fails
                    const html = `
                <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
                  ${fullAddress ?
                            `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
                   <div style="color: #666; font-size: 11px;">Address Point: ${id}</div>` :
                            `<div style="font-weight:600; color: #000;">Address Point: ${id}</div>`
                        }
                  <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                    <div style="color: #ff6b35; font-size: 11px;">Unable to snap to road</div>
                  </div>
                </div>
              `;

                    new maplibregl.Popup({ closeOnClick: true })
                        .setLngLat(lngLat)
                        .setHTML(html)
                        .addTo(map);
                }
            } catch (error) {
                console.error("Error calling snap-to-road API:", error);

                // Fallback to original popup
                const html = `
        <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
          ${fullAddress ?
                        `<div style="font-weight:600; color: #000; margin-bottom: 4px;">${fullAddress}</div>
             <div style="color: #666; font-size: 11px;">Address Point: ${id}</div>` :
                        `<div style="font-weight:600; color: #000;">Address Point: ${id}</div>`
                    }
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #eee;">
                <div style="color: #ff6b35; font-size: 11px;">Error loading road data</div>
              </div>
        </div>
      `;

                new maplibregl.Popup({ closeOnClick: true })
                    .setLngLat(lngLat)
                    .setHTML(html)
                    .addTo(map);
            }
        };

        // Set up event listener for close-table events
        const handleCloseTable = () => {
            clearParcelSelection();
            clearSnapToRoad(); // Also clear snap-to-road data when table is closed
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
    }, [createLoadParcels]);

    // Update addresses when parcel selection changes
    useEffect(() => {
        if (mapRef.current && selectedParcelId) {
            loadAddressesForParcel(mapRef.current, selectedParcelId);
        }
    }, [selectedParcelId]);

    return (
        <div className="relative w-full h-screen">
            <div id="map" className="w-full h-full" />

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

            {/* Address Table - Right Side */}
            <SimpleAddressTable
                parcelId={selectedParcelId}
            />
        </div>
    );
}
