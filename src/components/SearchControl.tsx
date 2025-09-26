"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import { eventBus } from "@/lib/events";

interface SearchResult {
    id: number | string;
    label: string;
    lon: number;
    lat: number;
}

interface Props {
    className?: string;
}

export function SearchControl({ className = "" }: Props) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showResults, setShowResults] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(-1);

    const debounceTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
    const inputRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);

    const searchAddresses = useCallback(async (searchQuery: string) => {
        if (!searchQuery.trim()) {
            setResults([]);
            setError(null);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&limit=10`);

            if (!response.ok) {
                if (response.status === 504) {
                    throw new Error("Search timeout, try a more specific query");
                }
                throw new Error("Search failed");
            }

            const data = await response.json();
            setResults(data);
        } catch (err) {
            console.error("Search error:", err);
            setError(err instanceof Error ? err.message : "Search failed");
            setResults([]);
        } finally {
            setLoading(false);
        }
    }, []);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setQuery(value);
        setSelectedIndex(-1);
        setShowResults(true);

        // Clear previous timeout
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }

        // Set new timeout for debounced search
        debounceTimeoutRef.current = setTimeout(() => {
            searchAddresses(value);
        }, 300);
    }, [searchAddresses]);

    const handleResultClick = useCallback(async (result: SearchResult) => {
        // First focus on the address
        eventBus.emit("focus-address", {
            id: result.id,
            lngLat: [result.lon, result.lat]
        });

        // Then try to find and select the parcel
        try {
            const response = await fetch(`/api/address/${result.id}/parcel`);
            if (response.ok) {
                const data = await response.json();
                if (data.parcelId) {
                    eventBus.emit("select-parcel", { parcelId: data.parcelId });
                }
            }
        } catch (error) {
            console.warn("Failed to find parcel for address:", error);
        }

        setQuery(result.label);
        setShowResults(false);
        setSelectedIndex(-1);
        inputRef.current?.blur();
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (!showResults || results.length === 0) return;

        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setSelectedIndex(prev =>
                    prev < results.length - 1 ? prev + 1 : prev
                );
                break;
            case "ArrowUp":
                e.preventDefault();
                setSelectedIndex(prev => prev > 0 ? prev - 1 : -1);
                break;
            case "Enter":
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < results.length) {
                    handleResultClick(results[selectedIndex]);
                }
                break;
            case "Escape":
                setShowResults(false);
                setSelectedIndex(-1);
                inputRef.current?.blur();
                break;
        }
    }, [showResults, results, selectedIndex, handleResultClick]);

    const handleInputFocus = useCallback(() => {
        if (results.length > 0) {
            setShowResults(true);
        }
    }, [results.length]);

    const handleInputBlur = useCallback(() => {
        // Delay hiding results to allow for clicks on results
        setTimeout(() => {
            setShowResults(false);
            setSelectedIndex(-1);
        }, 150);
    }, []);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
        };
    }, []);

    return (
        <div className={`relative ${className}`}>
            <div className="relative">
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onFocus={handleInputFocus}
                    onBlur={handleInputBlur}
                    placeholder="Search addresses..."
                    className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    style={{
                        fontSize: "14px",
                        backgroundColor: "white",
                        boxShadow: "0 2px 4px rgba(0,0,0,0.1)"
                    }}
                />
                {loading && (
                    <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                        <div className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"></div>
                    </div>
                )}
            </div>

            {showResults && (results.length > 0 || error) && (
                <div
                    ref={resultsRef}
                    className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto"
                >
                    {error ? (
                        <div className="px-4 py-3 text-red-600 text-sm">
                            {error}
                        </div>
                    ) : (
                        results.map((result, index) => (
                            <button
                                key={result.id}
                                type="button"
                                onClick={() => handleResultClick(result)}
                                className={`w-full text-left px-4 py-3 cursor-pointer text-sm border-b border-gray-100 last:border-b-0 transition-colors ${index === selectedIndex
                                    ? "bg-blue-50 text-blue-900"
                                    : "hover:bg-gray-50 text-gray-900"
                                    }`}
                                style={{
                                    fontSize: "13px"
                                }}
                            >
                                <div className="font-medium">{result.label}</div>
                                <div className="text-gray-500 text-xs mt-1">
                                    Address Point: {result.id}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}

            {showResults && results.length === 0 && !loading && query.trim() && !error && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50">
                    <div className="px-4 py-3 text-gray-500 text-sm">
                        No addresses found
                    </div>
                </div>
            )}
        </div>
    );
}
