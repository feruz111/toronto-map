// src/components/SchoolsTable.tsx
"use client";
import { useEffect, useState } from "react";
import { eventBus } from "@/lib/events";

interface School {
    name: string;
    geom_geojson: string;
    source_address: string;
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

interface Props {
    selectedAddress: AddressFeature | null;
    onSchoolsChange?: (schools: School[], addressCoords?: [number, number]) => void;
}

export function SchoolsTable({ selectedAddress, onSchoolsChange }: Props) {
    const [schools, setSchools] = useState<School[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!selectedAddress) {
            setSchools([]);
            return;
        }

        const fetchSchools = async () => {
            setLoading(true);
            setError(null);

            try {
                const res = await fetch(
                    `/api/nearest-schools?lat=${selectedAddress.geometry.coordinates[1]}&lng=${selectedAddress.geometry.coordinates[0]}`,
                    { cache: "no-store" }
                );

                if (!res.ok) {
                    throw new Error(`Failed to fetch schools: ${res.status}`);
                }

                const data = await res.json();
                setSchools(data);
                onSchoolsChange?.(data, selectedAddress.geometry.coordinates);
            } catch (err) {
                console.error("Error fetching schools:", err);
                setError("Failed to load schools");
                setSchools([]);
                onSchoolsChange?.([]);
            } finally {
                setLoading(false);
            }
        };

        fetchSchools();
    }, [selectedAddress, onSchoolsChange]);

    if (!selectedAddress) return null;

    return (
        <div style={{
            position: "absolute",
            right: "380px", // Position to the left of AddressTable
            top: 0,
            bottom: 0,
            width: "320px",
            height: typeof window !== 'undefined' && window.innerWidth < 768 ? "40vh" : "100%",
            backgroundColor: "white",
            boxShadow: "-2px 0 8px rgba(0,0,0,0.1)",
            display: "flex",
            flexDirection: "column",
            zIndex: 1000,
        }}>
            <div style={{
                padding: "16px",
                borderBottom: "1px solid #e0e0e0",
                backgroundColor: "#f5f5f5",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
            }}>
                <div>
                    <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#000" }}>
                        Nearest Schools
                    </h3>
                    <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
                        {loading ? "Loading..." : `${schools.length} schools found`}
                    </div>
                    <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>
                        For: {selectedAddress.properties.full_address ||
                            (selectedAddress.properties.civic_number && selectedAddress.properties.street_name
                                ? `${selectedAddress.properties.civic_number} ${selectedAddress.properties.street_name}`
                                : "Unknown address")}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => eventBus.emit("close-schools", {})}
                    style={{
                        background: "none",
                        border: "none",
                        fontSize: "18px",
                        cursor: "pointer",
                        color: "#666",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        lineHeight: 1,
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = "#e0e0e0";
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = "transparent";
                    }}
                    title="Close"
                >
                    ×
                </button>
            </div>

            <div style={{
                flex: 1,
                overflow: "auto",
                padding: "8px",
            }}>
                {error ? (
                    <div style={{
                        padding: "16px",
                        color: "#d32f2f",
                        fontSize: "14px",
                        textAlign: "center"
                    }}>
                        {error}
                    </div>
                ) : schools.length === 0 && !loading ? (
                    <div style={{
                        padding: "16px",
                        color: "#666",
                        fontSize: "14px",
                        textAlign: "center"
                    }}>
                        No schools found
                    </div>
                ) : (
                    <table style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: "14px",
                    }}>
                        <thead>
                            <tr style={{
                                borderBottom: "2px solid #e0e0e0",
                            }}>
                                <th style={{
                                    padding: "8px",
                                    textAlign: "left",
                                    fontWeight: 600,
                                    color: "#000",
                                    width: "70%",
                                }}>
                                    School Name
                                </th>
                                <th style={{
                                    padding: "8px",
                                    textAlign: "left",
                                    fontWeight: 600,
                                    color: "#000",
                                    width: "30%",
                                }}>
                                    Distance
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {schools.map((school, index) => (
                                <tr
                                    key={`${school.name}-${index}`}
                                    style={{
                                        cursor: "pointer",
                                        borderBottom: "1px solid #f0f0f0",
                                        transition: "background-color 0.2s",
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor = "#f5f5f5";
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor = "transparent";
                                    }}
                                >
                                    <td style={{
                                        padding: "12px 8px",
                                        color: "#000",
                                        fontWeight: "500",
                                    }}>
                                        {school.name}
                                    </td>
                                    <td style={{
                                        padding: "12px 8px",
                                        color: "#666",
                                        fontSize: "12px",
                                    }}>
                                        {Math.round(school.dist_m)}m
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
