"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SimpleAddressTable } from "@/components/SimpleAddressTable";
import { SearchControl } from "@/components/SearchControl";
import { eventBus } from "@/lib/events";

interface SchoolFeature {
    name: string;
    source_address: string;
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
                clearSchoolsFromMap(map);
            } else {
                setSelected(map, parcelId);
                loadAddressesForParcel(map, parcelId);
                onSelectionChange(parcelId);

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

async function loadNearestSchools(map: maplibregl.Map, coordinates: [number, number]) {
    const src = map.getSource("schools") as GeoJSONSource;
    const linesSrc = map.getSource("school-lines") as GeoJSONSource;

    console.log("[loadNearestSchools] Starting with coordinates:", coordinates);
    console.log("[loadNearestSchools] Sources found - schools:", !!src, "lines:", !!linesSrc);

    if (!src || !linesSrc) {
        console.error("[loadNearestSchools] Missing map sources!");
        return;
    }

    const [lng, lat] = coordinates;
    const url = `/api/nearest-5-schools?lat=${lat}&lng=${lng}`;

    console.log("[loadNearestSchools] fetching from:", url);

    try {
        const res = await fetch(url, { cache: "no-store" });
        console.log("[loadNearestSchools] API response status:", res.status);

        const schools: SchoolFeature[] = res.ok ? await res.json() : [];
        console.log("[loadNearestSchools] Schools received:", schools.length, schools);

        if (schools.length === 0) {
            console.log("[loadNearestSchools] No schools found, clearing map");
            src.setData({ type: "FeatureCollection", features: [] });
            linesSrc.setData({ type: "FeatureCollection", features: [] });
            return;
        }

        // Convert schools data to GeoJSON features
        const features = schools.map(school => {
            try {
                const geom = JSON.parse(school.geom_geojson);
                console.log("[loadNearestSchools] Parsed geometry for", school.name, ":", geom);
                return {
                    type: "Feature" as const,
                    geometry: geom,
                    properties: {
                        name: school.name,
                        source_address: school.source_address,
                        dist_m: school.dist_m
                    }
                };
            } catch (error) {
                console.error("[loadNearestSchools] Error parsing school geometry:", school.geom_geojson, error);
                return null;
            }
        }).filter(Boolean);

        console.log("[loadNearestSchools] Processed features:", features);

        const geojson = {
            type: "FeatureCollection" as const,
            features: features.filter((f): f is NonNullable<typeof f> => f !== null)
        };

        console.log("[loadNearestSchools] Setting school data on map:", geojson);
        src.setData(geojson);

        // Draw lines from address to each school
        const lineFeatures = features.filter((f): f is NonNullable<typeof f> => f !== null).map(feature => ({
            type: "Feature" as const,
            geometry: {
                type: "LineString" as const,
                coordinates: [coordinates, feature.geometry.coordinates]
            },
            properties: {
                school_name: feature.properties.name,
                distance: feature.properties.dist_m
            }
        }));

        console.log("[loadNearestSchools] Line features created:", lineFeatures);

        const linesGeoJson = {
            type: "FeatureCollection" as const,
            features: lineFeatures
        };

        console.log("[loadNearestSchools] Setting line data on map:", linesGeoJson);
        linesSrc.setData(linesGeoJson);

        console.log(`[nearest-schools] loaded ${features.length} schools with connecting lines`);
    } catch (error) {
        console.error("[nearest-schools] fetch failed:", error);
        src.setData({ type: "FeatureCollection", features: [] });
        linesSrc.setData({ type: "FeatureCollection", features: [] });
    }
}

function clearSchoolsFromMap(map: maplibregl.Map) {
    const src = map.getSource("schools") as GeoJSONSource;
    const linesSrc = map.getSource("school-lines") as GeoJSONSource;

    if (src) src.setData({ type: "FeatureCollection", features: [] });
    if (linesSrc) linesSrc.setData({ type: "FeatureCollection", features: [] });

    console.log("[nearest-schools] cleared schools from map");
}

export default function NearestSchoolsPage() {
    const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const abortControllerRef = useRef<AbortController | undefined>(undefined);
    const mapRef = useRef<maplibregl.Map | null>(null);
    const [selectedParcelId, setSelectedParcelId] = useState<number | string | null>(null);
    const [selectedAddress, setSelectedAddress] = useState<AddressFeature | null>(null);
    const [nearestSchools, setNearestSchools] = useState<SchoolFeature[]>([]);
    const [schoolsLoading, setSchoolsLoading] = useState(false);

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
            if (style?.layers) {
                style.layers.forEach((layer: unknown) => {
                    const layerObj = layer as { type?: string; layout?: Record<string, unknown>; id?: string };
                    if (layerObj.type === "symbol" ||
                        (layerObj.layout?.["text-field"]) ||
                        (layerObj.id?.includes("label")) ||
                        (layerObj.id?.includes("text"))) {
                        try {
                            if (layerObj.id) {
                                map.removeLayer(layerObj.id);
                            }
                        } catch {
                            // Layer might already be removed or not found
                            console.log(`Could not remove layer: ${layerObj.id}`);
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
            <div style="color: #666; font-size: 11px; margin-top: 2px;">Address: ${props.source_address || 'Unknown'}</div>
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

            // Add hover effect for school lines
            map.on("mouseenter", "school-lines", () => {
                map.getCanvas().style.cursor = "pointer";
            });

            map.on("mouseleave", "school-lines", () => {
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

            loadParcels(map);
        });

        map.on("moveend", debouncedLoadParcels);

        // Function to clear parcel selection
        const clearParcelSelection = () => {
            setSelected(map, null);
            loadAddressesForParcel(map, null);
            setSelectedParcelId(null);
            setSelectedAddress(null);
            clearSchoolsFromMap(map);
            setNearestSchools([]);
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
        const handleSelectAddress = async (address: AddressFeature) => {
            console.log("[nearest-schools] Address selected:", address);
            setSelectedAddress(address);
            setSchoolsLoading(true);

            try {
                // Load schools on map first
                await loadNearestSchools(map, address.geometry.coordinates);

                // Fetch schools data for the sidebar display
                const [lng, lat] = address.geometry.coordinates;
                const url = `/api/nearest-5-schools?lat=${lat}&lng=${lng}`;
                console.log("[nearest-schools] Fetching schools from:", url);

                const res = await fetch(url, { cache: "no-store" });
                console.log("[nearest-schools] API response status:", res.status);

                if (res.ok) {
                    const schools: SchoolFeature[] = await res.json();
                    console.log("[nearest-schools] Schools data:", schools);
                    setNearestSchools(schools);
                } else {
                    console.error("[nearest-schools] API error:", res.status, await res.text());
                    setNearestSchools([]);
                }
            } catch (error) {
                console.error("[nearest-schools] Error loading nearest schools:", error);
                setNearestSchools([]);
            } finally {
                setSchoolsLoading(false);
            }
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

            {/* Page Title and Back Link - Top Right */}
            <div
                style={{
                    position: "absolute",
                    top: "20px",
                    right: selectedParcelId ? "380px" : "20px",
                    zIndex: 1000,
                    transition: "right 0.3s ease",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                }}
            >
                <a
                    href="/"
                    style={{
                        background: "rgba(255, 255, 255, 0.95)",
                        color: "#000",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        textDecoration: "none",
                        fontSize: "12px",
                        fontWeight: 600,
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                        transition: "all 0.2s ease",
                        display: "inline-block",
                        alignSelf: "flex-end",
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(255, 255, 255, 1)";
                        e.currentTarget.style.transform = "translateY(-1px)";
                        e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = "rgba(255, 255, 255, 0.95)";
                        e.currentTarget.style.transform = "translateY(0)";
                        e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)";
                    }}
                >
                    ← Back to Main Map
                </a>
                <div
                    style={{
                        background: "rgba(255, 255, 255, 0.95)",
                        padding: "12px 20px",
                        borderRadius: "8px",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                        fontSize: "16px",
                        fontWeight: 600,
                        color: "#000",
                    }}
                >
                    Nearest Schools Finder
                </div>
            </div>

            {/* Address Table - Right Side */}
            <SimpleAddressTable parcelId={selectedParcelId} />

            {/* Schools Info Panel - Bottom Left */}
            {selectedAddress && (
                <div
                    style={{
                        position: "absolute",
                        bottom: "20px",
                        left: "20px",
                        width: "320px",
                        maxHeight: "300px",
                        backgroundColor: "rgba(255, 255, 255, 0.95)",
                        borderRadius: "8px",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                        zIndex: 1000,
                        overflow: "hidden",
                    }}
                >
                    <div style={{
                        padding: "16px",
                        borderBottom: "1px solid #e0e0e0",
                        backgroundColor: "#f8f9fa",
                    }}>
                        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#000" }}>
                            Nearest 5 Schools
                        </h3>
                        <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
                            {schoolsLoading ? "Loading..." : `${nearestSchools.length} schools found`}
                        </div>
                        <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>
                            For: {selectedAddress.properties.full_address ||
                                (selectedAddress.properties.civic_number && selectedAddress.properties.street_name
                                    ? `${selectedAddress.properties.civic_number} ${selectedAddress.properties.street_name}`
                                    : "Unknown address")}
                        </div>
                    </div>

                    <div style={{
                        maxHeight: "200px",
                        overflow: "auto",
                        padding: "8px",
                    }}>
                        {nearestSchools.length === 0 && !schoolsLoading ? (
                            <div style={{
                                padding: "16px",
                                color: "#666",
                                fontSize: "14px",
                                textAlign: "center"
                            }}>
                                No schools found
                            </div>
                        ) : (
                            <div style={{ padding: "4px" }}>
                                {nearestSchools.map((school, index) => (
                                    <button
                                        key={`${school.name}-${index}`}
                                        type="button"
                                        style={{
                                            padding: "12px",
                                            borderBottom: index < nearestSchools.length - 1 ? "1px solid #f0f0f0" : "none",
                                            cursor: "pointer",
                                            transition: "background-color 0.2s",
                                            border: "none",
                                            background: "transparent",
                                            width: "100%",
                                            textAlign: "left",
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.backgroundColor = "#f5f5f5";
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.backgroundColor = "transparent";
                                        }}
                                    >
                                        <div style={{
                                            fontWeight: 600,
                                            color: "#000",
                                            fontSize: "14px",
                                            marginBottom: "4px",
                                        }}>
                                            {index + 1}. {school.name}
                                        </div>
                                        <div style={{
                                            color: "#666",
                                            fontSize: "12px",
                                            marginBottom: "2px",
                                        }}>
                                            Distance: {Math.round(school.dist_m)}m
                                        </div>
                                        <div style={{
                                            color: "#888",
                                            fontSize: "11px",
                                        }}>
                                            {school.source_address || "Unknown address"}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
