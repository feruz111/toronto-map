// src/components/AddressTable.tsx
"use client";
import { useEffect, useState } from "react";
import { eventBus } from "@/lib/events";

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

interface School {
    name: string;
    address_full: string;
    geom_geojson: string;
    dist_m: number;
}

interface Library {
    branchname: string;
    address: string;
    geom_geojson: string;
    dist_m: number;
}

interface CombinedResponse {
    libraries: Library[];
    schools: School[];
}

interface Props {
    parcelId: number | string | null;
    selectedAddress: AddressFeature | null;
    onSchoolsChange?: (schools: School[], addressCoords?: [number, number]) => void;
    onLibrariesChange?: (libraries: Library[], addressCoords?: [number, number]) => void;
}

export function AddressTable({ parcelId, selectedAddress, onSchoolsChange, onLibrariesChange }: Props) {
    const [addresses, setAddresses] = useState<AddressFeature[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Schools state
    const [schools, setSchools] = useState<School[]>([]);
    const [schoolsLoading, setSchoolsLoading] = useState(false);
    const [schoolsError, setSchoolsError] = useState<string | null>(null);

    // Libraries state
    const [libraries, setLibraries] = useState<Library[]>([]);
    const [librariesLoading, setLibrariesLoading] = useState(false);
    const [librariesError, setLibrariesError] = useState<string | null>(null);

    useEffect(() => {
        if (!parcelId) {
            setAddresses([]);
            return;
        }

        const fetchAddresses = async () => {
            setLoading(true);
            setError(null);

            try {
                const res = await fetch(`/api/parcel/${parcelId}/addresses`, {
                    cache: "no-store"
                });

                if (!res.ok) {
                    throw new Error(`Failed to fetch addresses: ${res.status}`);
                }

                const data = await res.json();
                setAddresses(data.features || []);
            } catch (err) {
                console.error("Error fetching addresses:", err);
                setError("Failed to load addresses");
                setAddresses([]);
            } finally {
                setLoading(false);
            }
        };

        fetchAddresses();
    }, [parcelId]);

    // Fetch schools and libraries when an address is selected
    useEffect(() => {
        if (!selectedAddress) {
            setSchools([]);
            setSchoolsError(null);
            setLibraries([]);
            setLibrariesError(null);
            return;
        }

        const fetchSchoolsAndLibraries = async () => {
            setSchoolsLoading(true);
            setLibrariesLoading(true);
            setSchoolsError(null);
            setLibrariesError(null);

            try {
                const res = await fetch(
                    `/api/libraries-and-schools-within-2km?lat=${selectedAddress.geometry.coordinates[1]}&lng=${selectedAddress.geometry.coordinates[0]}`,
                    { cache: "no-store" }
                );

                if (!res.ok) {
                    throw new Error(`Failed to fetch schools and libraries: ${res.status}`);
                }

                const data: CombinedResponse = await res.json();

                // Set schools data
                setSchools(data.schools || []);
                onSchoolsChange?.(data.schools || [], selectedAddress.geometry.coordinates);

                // Set libraries data
                setLibraries(data.libraries || []);
                onLibrariesChange?.(data.libraries || [], selectedAddress.geometry.coordinates);
            } catch (err) {
                console.error("Error fetching schools and libraries:", err);
                const errorMsg = "Failed to load schools and libraries";
                setSchoolsError(errorMsg);
                setLibrariesError(errorMsg);
                setSchools([]);
                setLibraries([]);
                onSchoolsChange?.([]);
                onLibrariesChange?.([]);
            } finally {
                setSchoolsLoading(false);
                setLibrariesLoading(false);
            }
        };

        fetchSchoolsAndLibraries();
    }, [selectedAddress, onSchoolsChange, onLibrariesChange]);

    const handleRowClick = async (address: AddressFeature) => {
        eventBus.emit("focus-address", {
            id: address.properties.address_point_id,
            lngLat: address.geometry.coordinates
        });

        // Emit selected address for schools table
        eventBus.emit("select-address", address);
    };

    // Process addresses to include formatted address
    const processedAddresses = addresses.map(address => ({
        ...address,
        displayAddress: address.properties.full_address ||
            (address.properties.civic_number && address.properties.street_name
                ? `${address.properties.civic_number} ${address.properties.street_name}`
                : "(unknown)")
    }));

    // Don't render if no parcel is selected
    if (!parcelId) return null;

    return (
        <div style={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: typeof window !== 'undefined' && window.innerWidth < 768 ? "100%" : "360px",
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
                        Addresses in Parcel {parcelId}
                    </h3>
                    <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
                        {loading ? "Loading..." : `${processedAddresses.length} address${processedAddresses.length !== 1 ? 'es' : ''} found`}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => eventBus.emit("close-table", {})}
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
                overflow: "auto",
                padding: "8px",
                flexGrow: selectedAddress ? 0 : 1,
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
                ) : processedAddresses.length === 0 && !loading ? (
                    <div style={{
                        padding: "16px",
                        color: "#666",
                        fontSize: "14px",
                        textAlign: "center"
                    }}>
                        No addresses found
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
                                    width: "60%",
                                }}>
                                    Address
                                </th>
                                <th style={{
                                    padding: "8px",
                                    textAlign: "left",
                                    fontWeight: 600,
                                    color: "#000",
                                    width: "40%",
                                }}>
                                    Address Point ID
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {processedAddresses.map((address) => (
                                <tr
                                    key={address.properties.address_point_id}
                                    onClick={() => handleRowClick(address)}
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
                                        fontWeight: address.displayAddress === "(unknown)" ? "normal" : "500",
                                    }}>
                                        {address.displayAddress}
                                    </td>
                                    <td style={{
                                        padding: "12px 8px",
                                        color: "#666",
                                        fontSize: "12px",
                                    }}>
                                        {address.properties.address_point_id}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Schools Section - only show if address is selected */}
            {selectedAddress && (
                <>
                    <div style={{
                        borderTop: "2px solid #e0e0e0",
                        padding: "8px 16px",
                        backgroundColor: "#f9f9f9",
                        marginTop: "8px",
                    }}>
                        <h4 style={{
                            margin: 0,
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "#000",
                            marginBottom: "8px"
                        }}>
                            Nearest Schools
                        </h4>
                        <div style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
                            {schoolsLoading ? "Loading..." : `${schools.length} schools found`}
                        </div>
                        <div style={{ fontSize: "11px", color: "#888" }}>
                            For: {selectedAddress.properties.full_address ||
                                (selectedAddress.properties.civic_number && selectedAddress.properties.street_name
                                    ? `${selectedAddress.properties.civic_number} ${selectedAddress.properties.street_name}`
                                    : "Unknown address")}
                        </div>
                    </div>

                    <div style={{
                        overflow: "auto",
                        padding: "8px",
                        maxHeight: "250px",
                        flex: 1,
                    }}>
                        {schoolsError ? (
                            <div style={{
                                padding: "16px",
                                color: "#d32f2f",
                                fontSize: "14px",
                                textAlign: "center"
                            }}>
                                {schoolsError}
                            </div>
                        ) : schools.length === 0 && !schoolsLoading ? (
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
                                fontSize: "13px",
                            }}>
                                <thead>
                                    <tr style={{
                                        borderBottom: "1px solid #e0e0e0",
                                    }}>
                                        <th style={{
                                            padding: "6px",
                                            textAlign: "left",
                                            fontWeight: 600,
                                            color: "#000",
                                            width: "70%",
                                        }}>
                                            School Name
                                        </th>
                                        <th style={{
                                            padding: "6px",
                                            textAlign: "left",
                                            fontWeight: 600,
                                            color: "#000",
                                            width: "30%",
                                        }}>
                                            Address
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
                                                padding: "8px 6px",
                                                color: "#000",
                                                fontWeight: "500",
                                            }}>
                                                {school.name}
                                            </td>
                                            <td style={{
                                                padding: "8px 6px",
                                                color: "#666",
                                                fontSize: "11px",
                                            }}>
                                                {school.address_full || "Unknown"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* Libraries Section */}
                    <div style={{
                        borderTop: "2px solid #e0e0e0",
                        padding: "8px 16px",
                        backgroundColor: "#f9f9f9",
                        marginTop: "8px",
                    }}>
                        <h4 style={{
                            margin: 0,
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "#000",
                            marginBottom: "8px"
                        }}>
                            Libraries Within 2km
                        </h4>
                        <div style={{ fontSize: "12px", color: "#666", marginBottom: "8px" }}>
                            {librariesLoading ? "Loading..." : `${libraries.length} libraries found`}
                        </div>
                        <div style={{ fontSize: "11px", color: "#888" }}>
                            For: {selectedAddress.properties.full_address ||
                                (selectedAddress.properties.civic_number && selectedAddress.properties.street_name
                                    ? `${selectedAddress.properties.civic_number} ${selectedAddress.properties.street_name}`
                                    : "Unknown address")}
                        </div>
                    </div>

                    <div style={{
                        overflow: "auto",
                        padding: "8px",
                        maxHeight: "200px",
                        flex: 1,
                    }}>
                        {librariesError ? (
                            <div style={{
                                padding: "16px",
                                color: "#d32f2f",
                                fontSize: "14px",
                                textAlign: "center"
                            }}>
                                {librariesError}
                            </div>
                        ) : libraries.length === 0 && !librariesLoading ? (
                            <div style={{
                                padding: "16px",
                                color: "#666",
                                fontSize: "14px",
                                textAlign: "center"
                            }}>
                                No libraries found
                            </div>
                        ) : (
                            <table style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                fontSize: "13px",
                            }}>
                                <thead>
                                    <tr style={{
                                        borderBottom: "1px solid #e0e0e0",
                                    }}>
                                        <th style={{
                                            padding: "6px",
                                            textAlign: "left",
                                            fontWeight: 600,
                                            color: "#000",
                                            width: "50%",
                                        }}>
                                            Library Name
                                        </th>
                                        <th style={{
                                            padding: "6px",
                                            textAlign: "left",
                                            fontWeight: 600,
                                            color: "#000",
                                            width: "25%",
                                        }}>
                                            Distance
                                        </th>
                                        <th style={{
                                            padding: "6px",
                                            textAlign: "left",
                                            fontWeight: 600,
                                            color: "#000",
                                            width: "25%",
                                        }}>
                                            Address
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {libraries.map((library, index) => (
                                        <tr
                                            key={`${library.branchname}-${index}`}
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
                                                padding: "8px 6px",
                                                color: "#000",
                                                fontWeight: "500",
                                            }}>
                                                {library.branchname}
                                            </td>
                                            <td style={{
                                                padding: "8px 6px",
                                                color: "#666",
                                                fontSize: "11px",
                                            }}>
                                                {Math.round(library.dist_m)}m
                                            </td>
                                            <td style={{
                                                padding: "8px 6px",
                                                color: "#666",
                                                fontSize: "11px",
                                            }}>
                                                {library.address}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                </>
            )}

        </div>
    );
}
