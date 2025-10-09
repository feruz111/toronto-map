"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import * as turf from "@turf/turf";

interface NearbyFeature {
    type: string;
    name: string;
    distance_m: number;
    geom_geojson: string;
}

interface NearbyResponse {
    nearby: NearbyFeature[];
}

const MIN_Z = 10;
const DEBOUNCE_MS = 500;

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
        map.setFilter("parcels-hover", ["==", ["get", "parcel_id"], ""]);
    }

    hoveredId = id;

    if (hoveredId != null) {
        map.setFilter("parcels-hover", ["==", ["get", "parcel_id"], hoveredId]);
    }
}

function setSelected(map: maplibregl.Map, id: number | string | null) {
    const src = map.getSource("parcels") as GeoJSONSource;
    if (!src) return;

    if (selectedId != null) {
        map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], ""]);
    }

    selectedId = id;

    if (selectedId != null) {
        map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], selectedId]);
    }
}

async function loadAddressesForParcel(
    map: maplibregl.Map,
    parcelId: number | string | null,
    onAddressesLoaded?: (firstAddress: { coords: [number, number], fullAddress: string } | null) => void
) {
    const src = map.getSource("addresses") as GeoJSONSource;
    if (!src) return;

    if (parcelId == null) {
        src.setData({ type: "FeatureCollection", features: [] });
        if (onAddressesLoaded) onAddressesLoaded(null);
        return;
    }

    const url = `/api/parcel/${parcelId}/addresses`;
    console.log("[addresses] fetching for parcel", parcelId);

    try {
        const res = await fetch(url, { cache: "no-store" });
        const fc = res.ok ? await res.json() : { type: "FeatureCollection", features: [] };
        src.setData(fc);
        console.log(`[addresses] loaded ${fc.features.length} addresses for parcel ${parcelId}`);

        // Get first address if available
        if (fc.features && fc.features.length > 0 && onAddressesLoaded) {
            const firstFeature = fc.features[0];
            const coords = firstFeature.geometry.coordinates as [number, number];
            const fullAddress = firstFeature.properties?.full_address || 'Address';
            onAddressesLoaded({ coords, fullAddress });
        } else if (onAddressesLoaded) {
            onAddressesLoaded(null);
        }
    } catch (error) {
        console.error("[addresses] fetch failed:", error);
        src.setData({ type: "FeatureCollection", features: [] });
        if (onAddressesLoaded) onAddressesLoaded(null);
    }
}

function setupInteractions(
    map: maplibregl.Map,
    onSelectionChange: (id: number | string | null) => void,
    getViewMode: () => ViewMode,
    onLoadNearby?: (coords: [number, number], fullAddress: string) => void
) {
    console.log('[setupInteractions] called, initial mode:', getViewMode());
    const hoverTargets = ["parcels-fill", "parcels-line"];

    hoverTargets.forEach((layerId) => {
        map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
            // Only allow parcel hover in parcels mode
            const currentMode = getViewMode();
            if (currentMode !== 'parcels') return;

            map.getCanvas().style.cursor = "pointer";
            const feature = e.features?.[0];
            if (!feature || !feature.properties?.parcel_id) return;
            setHover(map, feature.properties.parcel_id);
        });

        map.on("mouseleave", layerId, () => {
            if (getViewMode() !== 'parcels') return;

            map.getCanvas().style.cursor = "";
            setHover(map, null);
        });

        map.on("click", layerId, (e: MapLayerMouseEvent) => {
            // Only allow parcel clicks in parcels mode
            const currentMode = getViewMode();
            console.log('[parcel-click]', layerId, 'mode:', currentMode);
            if (currentMode !== 'parcels') {
                console.log('[parcel-click] blocked - not in parcels mode');
                return;
            }

            const feature = e.features?.[0];
            if (!feature || !feature.properties?.parcel_id) {
                console.log('[parcel-click] no feature or parcel_id');
                return;
            }

            const parcelId = feature.properties.parcel_id;
            console.log('[parcel-click] parcel selected:', parcelId);

            if (selectedId === parcelId) {
                setSelected(map, null);
                loadAddressesForParcel(map, null);
                onSelectionChange(null);
            } else {
                setSelected(map, parcelId);
                onSelectionChange(parcelId);

                // Load addresses and trigger nearby search with first address
                loadAddressesForParcel(map, parcelId, (firstAddress) => {
                    if (firstAddress && onLoadNearby) {
                        console.log('[parcel-click] Loading nearby for first address:', firstAddress.fullAddress);
                        onLoadNearby(firstAddress.coords, firstAddress.fullAddress);
                    }
                });

                const props = feature.properties || {};
                const pid = props.parcel_id ?? parcelId;
                const type = props.f_type ?? "";
                const getParcelIcon = (parcelType: string) => {
                    switch (parcelType.toLowerCase()) {
                        case "common": return "🏢";
                        case "residential": return "🏠";
                        case "commercial": return "🏪";
                        case "industrial": return "🏭";
                        case "park": return "🌳";
                        case "school": return "🏫";
                        default: return "📦";
                    }
                };
                const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000; position: relative;">
            <button onclick="this.closest('.maplibregl-popup').remove(); window.clearParcelSelection && window.clearParcelSelection();" style="position: absolute; top: -8px; right: -8px; background: none; border: none; font-size: 16px; cursor: pointer; color: #666; padding: 2px 6px; border-radius: 3px; line-height: 1;" title="Close">×</button>
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span style="font-size: 16px;">${getParcelIcon(type)}</span>
              <div style="font-weight:600;color:#000;">Parcel ${pid}</div>
            </div>
            ${type ? `<div style="color:#000; margin-left: 22px;">Type: ${type}</div>` : ""}
            <div style="margin-top:6px;color:#000;font-size:11px;">Loading nearby places...</div>
          </div>
        `;

                // Remove any existing popups first
                const existingPopups = document.getElementsByClassName('maplibregl-popup');
                while (existingPopups.length > 0) {
                    existingPopups[0].remove();
                }

                new maplibregl.Popup({
                    closeOnClick: false,
                    closeButton: false,
                    maxWidth: '300px'
                })
                    .setLngLat(e.lngLat)
                    .setHTML(html)
                    .addTo(map);
            }
        });
    });
}

function updateBufferSource(map: maplibregl.Map, coordinates: [number, number], radius: number = 2000) {
    const bufferSource = map.getSource("buffer") as GeoJSONSource;
    if (!bufferSource) return;

    const point = turf.point(coordinates);
    const buffer = turf.buffer(point, radius, { units: 'meters' });

    const geojson = {
        type: "FeatureCollection" as const,
        features: [buffer]
    };

    bufferSource.setData(geojson as any);
    console.log(`[buffer] created ${radius}m buffer around point [${coordinates[0]}, ${coordinates[1]}]`);
}

function clearBufferSource(map: maplibregl.Map) {
    const bufferSource = map.getSource("buffer") as GeoJSONSource;
    if (!bufferSource) return;

    bufferSource.setData({ type: "FeatureCollection", features: [] });
    console.log("[buffer] cleared buffer");
}

async function loadNearbyData(lat: number, lng: number, radius: number = 2000): Promise<NearbyResponse> {
    try {
        const res = await fetch(`/api/nearby?lat=${lat}&lng=${lng}&radius=${radius}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return await res.json();
    } catch (error) {
        console.error("[nearby] fetch failed:", error);
        return { nearby: [] };
    }
}

async function loadNearbyOnMap(map: maplibregl.Map, nearbyData: NearbyFeature[]) {
    const src = map.getSource("nearby-points") as GeoJSONSource;
    if (!src) return;

    if (nearbyData.length === 0) {
        src.setData({ type: "FeatureCollection", features: [] });
        return;
    }

    const features = nearbyData.map(poi => {
        try {
            const geom = JSON.parse(poi.geom_geojson);
            return {
                type: "Feature" as const,
                geometry: geom,
                properties: {
                    name: poi.name,
                    type: poi.type,
                    distance_m: poi.distance_m
                }
            };
        } catch (error) {
            console.error("Error parsing POI geometry:", poi.geom_geojson, error);
            return null;
        }
    }).filter(Boolean);

    const geojson = {
        type: "FeatureCollection" as const,
        features: features.filter((f): f is NonNullable<typeof f> => f !== null)
    };

    src.setData(geojson as any);
    console.log(`[nearby] loaded ${features.length} POIs on map`);
}

type ViewMode = 'parcels' | 'nearby';

export default function NearbyPage() {
    console.log('[NearbyPage] component rendering');
    const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const abortControllerRef = useRef<AbortController | undefined>(undefined);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const viewModeRef = useRef<ViewMode>('parcels');
    const [selectedParcelId, setSelectedParcelId] = useState<number | string | null>(null);
    const [nearbyData, setNearbyData] = useState<NearbyFeature[]>([]);
    const [clickedLocation, setClickedLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('parcels');
    console.log('[NearbyPage] viewMode:', viewMode, 'viewModeRef.current:', viewModeRef.current);

    // Keep ref in sync with state
    useEffect(() => {
        viewModeRef.current = viewMode;
    }, [viewMode]);

    // Update parcel layer opacity based on view mode
    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;

        if (map.getLayer('parcels-fill')) {
            map.setPaintProperty('parcels-fill', 'fill-opacity', viewMode === 'nearby' ? 0.15 : 0.4);
            map.setPaintProperty('parcels-line', 'line-opacity', viewMode === 'nearby' ? 0.3 : 0.9);
        }
    }, [viewMode]);

    const createLoadParcels = useCallback((
        _onSelectionCleared: () => void,
        viewModeRefParam: React.MutableRefObject<ViewMode>,
        handleLoadNearby: (coords: [number, number], fullAddress: string) => void
    ) => {
        return async (map: maplibregl.Map, _abortController?: AbortController) => {
            const z = map.getZoom();
            const bbox = bboxFromMap(map);
            const zoomMessage = document.getElementById("zoom-message");

            console.log("[parcels] z=", z.toFixed(2), "bbox=", bbox);

            const src = map.getSource("parcels") as GeoJSONSource | undefined;

            if (z < MIN_Z) {
                console.log("[parcels] below MIN_Z, clearing source");
                if (src) src.setData({ type: "FeatureCollection", features: [] });
                if (zoomMessage) zoomMessage.style.display = "block";
                return;
            }

            if (zoomMessage) zoomMessage.style.display = "none";

            const url = `/api/parcels?bbox=${bbox}&z=${z.toFixed(2)}`;
            console.log("[parcels] fetching", url);

            try {
                const res = await fetch(url, {
                    cache: "default",
                    signal: _abortController?.signal
                });

                if (res.ok) {
                    const fc = await res.json();

                    if (src) {
                        src.setData(fc);
                        setHover(map, null);

                        if (selectedId != null) {
                            map.setFilter("parcels-selected", ["==", ["get", "parcel_id"], selectedId]);
                        }
                    } else {
                        map.addSource("parcels", {
                            type: "geojson",
                            data: fc
                        });

                        map.addLayer({
                            id: "parcels-fill",
                            type: "fill",
                            source: "parcels",
                            paint: {
                                "fill-color": "#e8f5e8",
                                "fill-opacity": 0.4
                            },
                        });

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

                        setupInteractions(map, setSelectedParcelId, () => viewModeRefParam.current, handleLoadNearby);
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
            center: [-79.3832, 43.6532],
            zoom: 12,
        });

        mapRef.current = map;

        // Handler for loading nearby POIs when parcel is clicked
        const handleLoadNearby = async (coords: [number, number], fullAddress: string) => {
            console.log('[handleLoadNearby] coords:', coords, 'address:', fullAddress);

            // Load nearby data
            const data = await loadNearbyData(coords[1], coords[0], 2000);
            setNearbyData(data.nearby);
            setClickedLocation({ lat: coords[1], lng: coords[0] });

            // Switch to nearby viewing mode
            setViewMode('nearby');

            // Draw 2km buffer around the address
            updateBufferSource(map, coords, 2000);

            // Load POIs on the map
            loadNearbyOnMap(map, data.nearby);
        };

        const loadParcels = createLoadParcels(() => setSelectedParcelId(null), viewModeRef, handleLoadNearby);

        const debouncedLoadParcels = () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }

            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }

            abortControllerRef.current = new AbortController();

            debounceTimeoutRef.current = setTimeout(() => {
                loadParcels(map, abortControllerRef.current);
            }, DEBOUNCE_MS);
        };

        map.on("load", () => {

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
                            console.log(`Could not remove layer: ${layer.id}`);
                        }
                    }
                });
            }

            map.addSource("addresses", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            map.addSource("nearby-points", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            map.addSource("buffer", {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] }
            });

            // Add nearby points layer with colored circles based on type
            map.addLayer({
                id: "nearby-points",
                type: "circle",
                source: "nearby-points",
                paint: {
                    "circle-radius": [
                        "interpolate", ["linear"], ["zoom"],
                        10, 6,
                        14, 9,
                        18, 12
                    ],
                    "circle-color": [
                        "match",
                        ["get", "type"],
                        "fire_station", "#FF4444",
                        "police_station", "#4444FF",
                        "park", "#44AA44",
                        "transit", "#FF8800",
                        "school", "#9C27B0",
                        "library", "#FF5722",
                        "#888888"
                    ],
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 2
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

            map.addLayer({
                id: "addresses-points",
                type: "circle",
                source: "addresses",
                paint: {
                    "circle-radius": [
                        "interpolate", ["linear"], ["zoom"],
                        10, 5,
                        14, 8,
                        18, 12
                    ],
                    "circle-color": "#ff4d4f",
                    "circle-stroke-color": "#ffffff",
                    "circle-stroke-width": 2
                }
            });


            // Optional: Click handler for addresses to show address info
            map.on("click", "addresses-points", (e: MapLayerMouseEvent) => {
                const feature = e.features?.[0];
                if (!feature) return;

                const props = feature.properties || {};
                const fullAddress = props.full_address;

                const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span style="font-size: 16px;">🏠</span>
              ${fullAddress ?
                        `<div style="font-weight:600; color: #000;">${fullAddress}</div>` :
                        `<div style="font-weight:600; color: #000;">Address Point</div>`
                    }
            </div>
            <div style="color: #666; font-size: 11px; margin-left: 22px;">Address on parcel</div>
          </div>
        `;

                new maplibregl.Popup({ closeOnClick: true })
                    .setLngLat(e.lngLat)
                    .setHTML(html)
                    .addTo(map);
            });

            // Click handler for nearby points
            map.on("click", "nearby-points", (e: MapLayerMouseEvent) => {
                const feature = e.features?.[0];
                if (!feature) return;

                const props = feature.properties || {};
                const name = props.name;
                const type = props.type;
                const distance = props.distance_m;

                const html = `
          <div style="font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #000;">
            <div style="font-weight:600; color: #000; margin-bottom: 4px;">${name}</div>
            <div style="color: #666; font-size: 11px;">Type: ${type}</div>
            <div style="color: #666; font-size: 11px;">Distance: ${Math.round(distance)}m</div>
          </div>
        `;

                new maplibregl.Popup({ closeOnClick: true })
                    .setLngLat(e.lngLat)
                    .setHTML(html)
                    .addTo(map);
            });

            // Hover effects
            map.on("mouseenter", "addresses-points", () => {
                map.getCanvas().style.cursor = "pointer";
            });

            map.on("mouseleave", "addresses-points", () => {
                map.getCanvas().style.cursor = "";
            });

            map.on("mouseenter", "nearby-points", () => {
                map.getCanvas().style.cursor = "pointer";
            });

            map.on("mouseleave", "nearby-points", () => {
                map.getCanvas().style.cursor = "";
            });

            loadParcels(map);
        });

        map.on("moveend", debouncedLoadParcels);

        const clearParcelSelection = () => {
            setSelected(map, null);
            loadAddressesForParcel(map, null);
            setSelectedParcelId(null);
            setNearbyData([]);
            setClickedLocation(null);
            clearBufferSource(map);
            loadNearbyOnMap(map, []);
            setViewMode('parcels');
        };

        (window as unknown as { clearParcelSelection: () => void }).clearParcelSelection = clearParcelSelection;

        return () => {
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

            {/* Zoom Message */}
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

            {/* Back to Home Link */}
            <div
                style={{
                    position: "absolute",
                    top: "20px",
                    left: "20px",
                    zIndex: 1000,
                }}
            >
                <a
                    href="/"
                    style={{
                        background: "rgba(255, 255, 255, 0.95)",
                        color: "#000",
                        padding: "10px 16px",
                        borderRadius: "6px",
                        textDecoration: "none",
                        fontSize: "14px",
                        fontWeight: 600,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                        display: "inline-block",
                    }}
                >
                    ← Back to Home
                </a>
            </div>

            {/* Mode Indicator */}
            {viewMode === 'nearby' && (
                <div
                    style={{
                        position: "absolute",
                        top: "80px",
                        left: "20px",
                        zIndex: 1000,
                        background: "rgba(59, 130, 246, 0.95)",
                        color: "white",
                        padding: "10px 16px",
                        borderRadius: "6px",
                        fontSize: "13px",
                        fontWeight: 600,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                    }}
                >
                    <span>📍 Nearby View Mode</span>
                    <button
                        onClick={() => {
                            setNearbyData([]);
                            setClickedLocation(null);
                            setViewMode('parcels');
                            if (mapRef.current) {
                                clearBufferSource(mapRef.current);
                                loadNearbyOnMap(mapRef.current, []);
                            }
                        }}
                        style={{
                            background: "rgba(255, 255, 255, 0.2)",
                            border: "1px solid rgba(255, 255, 255, 0.3)",
                            color: "white",
                            padding: "4px 10px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            cursor: "pointer",
                            fontWeight: 600,
                        }}
                    >
                        Exit
                    </button>
                </div>
            )}

            {/* Nearby Data Panel */}
            {nearbyData.length > 0 && (
                <div
                    style={{
                        position: "absolute",
                        top: "80px",
                        right: "20px",
                        width: "350px",
                        maxHeight: "calc(100vh - 120px)",
                        background: "rgba(255, 255, 255, 0.95)",
                        borderRadius: "8px",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        zIndex: 1000,
                        overflow: "hidden",
                        display: "flex",
                        flexDirection: "column",
                    }}
                >
                    <div
                        style={{
                            padding: "16px",
                            borderBottom: "1px solid #e0e0e0",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                        }}
                    >
                        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
                            Nearby Places ({nearbyData.length})
                        </h3>
                        <button
                            onClick={() => {
                                setNearbyData([]);
                                setClickedLocation(null);
                                setViewMode('parcels');
                                if (mapRef.current) {
                                    clearBufferSource(mapRef.current);
                                    loadNearbyOnMap(mapRef.current, []);
                                }
                            }}
                            style={{
                                background: "none",
                                border: "none",
                                fontSize: "20px",
                                cursor: "pointer",
                                color: "#666",
                                padding: "0 4px",
                            }}
                        >
                            ×
                        </button>
                    </div>
                    <div style={{ overflowY: "auto", padding: "12px" }}>
                        {nearbyData.map((item, idx) => {
                            const getIcon = (type: string) => {
                                switch (type) {
                                    case "fire_station": return "🔥";
                                    case "police_station": return "🚔";
                                    case "park": return "🌳";
                                    case "transit": return "🚌";
                                    case "school": return "🏫";
                                    case "library": return "📚";
                                    default: return "📍";
                                }
                            };

                            return (
                                <div
                                    key={idx}
                                    style={{
                                        padding: "10px",
                                        marginBottom: "8px",
                                        background: "#f9f9f9",
                                        borderRadius: "6px",
                                        borderLeft: `4px solid ${item.type === "fire_station" ? "#FF4444" :
                                            item.type === "police_station" ? "#4444FF" :
                                                item.type === "park" ? "#44AA44" :
                                                    item.type === "transit" ? "#FF8800" :
                                                        "#888888"
                                            }`,
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: "10px",
                                    }}
                                >
                                    <div style={{ fontSize: "18px", marginTop: "2px" }}>
                                        {getIcon(item.type)}
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "4px" }}>
                                            {item.name}
                                        </div>
                                        <div style={{ fontSize: "11px", color: "#666" }}>
                                            Type: {item.type.replace(/_/g, " ")}
                                        </div>
                                        <div style={{ fontSize: "11px", color: "#666" }}>
                                            Distance: {Math.round(item.distance_m)}m
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
