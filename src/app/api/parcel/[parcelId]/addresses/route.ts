// app/api/parcel/[parcelId]/addresses/route.ts
import { NextResponse } from "next/server";
import { Pool } from "pg";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ parcelId: string }> }
) {
    const { parcelId } = await params;
    const numericParcelId = Number(parcelId);

    if (!Number.isFinite(numericParcelId) || numericParcelId <= 0) {
        return NextResponse.json({ error: "Invalid parcel ID" }, { status: 400 });
    }

    const client = await pool.connect();
    const queryLabel = `[addresses] parcel ${parcelId}`;
    console.time(queryLabel);

    try {
        // Use transaction with statement timeout
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '2500 ms'");

        // First check if we have the precomputed address_parcels table
        const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'address_parcels'
      ) AS exists
    `);

        let query: string;
        const params = [numericParcelId];


        let rows: any[] = [];

        if (tableCheck.rows[0].exists) {
            // Try enhanced query first
            try {
                query = `
            SELECT 
              ap.address_point_id AS address_point_id,
              a.address_number as civic_number,
              a.linear_name_full as street_name,
              a.address_full,
              ST_AsGeoJSON(ap.address_geom, 6)::jsonb AS geom
            FROM address_parcels ap
            LEFT JOIN addresses a ON a.address_point_id = ap.address_point_id
            WHERE ap.parcel_id = $1
            LIMIT 5000
          `;
                console.log("[addresses] Trying enhanced precomputed query");
                const result = await client.query(query, params);
                rows = result.rows;
            } catch (enhancedError) {
                await client.query("ROLLBACK");
                await client.query("BEGIN");
                await client.query("SET LOCAL statement_timeout = '2500 ms'");

                console.log("[addresses] Enhanced precomputed query failed, using basic");
                query = `
            SELECT 
              ap.address_point_id AS address_point_id,
              NULL as civic_number,
              NULL as street_name,
              ST_AsGeoJSON(ap.address_geom, 6)::jsonb AS geom
            FROM address_parcels ap
            WHERE ap.parcel_id = $1
            LIMIT 5000
          `;
                const result = await client.query(query, params);
                rows = result.rows;
            }
        } else {
            // Try enhanced spatial join first
            try {
                query = `
            SELECT 
              a.address_point_id AS address_point_id,
              a.address_number as civic_number,
              a.linear_name_full as street_name,
              a.address_full,
              ST_AsGeoJSON(a.geom, 6)::jsonb AS geom
            FROM addresses a
            JOIN parcels p ON p.objectid = $1
            WHERE a.geom && p.geom
              AND ST_Intersects(a.geom, p.geom)
            LIMIT 5000
          `;
                console.log("[addresses] Trying enhanced spatial query");
                const result = await client.query(query, params);
                rows = result.rows;
            } catch (enhancedError) {
                await client.query("ROLLBACK");
                await client.query("BEGIN");
                await client.query("SET LOCAL statement_timeout = '2500 ms'");

                console.log("[addresses] Enhanced spatial query failed, using basic");
                query = `
            SELECT 
              a.address_point_id AS address_point_id,
              NULL as civic_number,
              NULL as street_name,
              ST_AsGeoJSON(a.geom, 6)::jsonb AS geom
            FROM addresses a
            JOIN parcels p ON p.objectid = $1
            WHERE a.geom && p.geom
              AND ST_Intersects(a.geom, p.geom)
            LIMIT 5000
          `;
                const result = await client.query(query, params);
                rows = result.rows;
            }
        }

        await client.query("COMMIT");

        // Build GeoJSON FeatureCollection
        const features = rows.map((row: {
            address_point_id: number;
            civic_number?: string | number;
            street_name?: string;
            address_full?: string;
            geom: unknown
        }) => {
            // Use address_full if available, otherwise build from parts
            const fullAddress = row.address_full ||
                (row.civic_number && row.street_name
                    ? `${row.civic_number} ${row.street_name}`.trim()
                    : null);

            return {
                type: "Feature" as const,
                geometry: row.geom,
                properties: {
                    address_point_id: row.address_point_id,
                    civic_number: row.civic_number || null,
                    street_name: row.street_name || null,
                    full_address: fullAddress
                }
            };
        });

        const result = {
            type: "FeatureCollection" as const,
            features
        };

        console.log(`[addresses] returned ${features.length} features for parcel ${parcelId}`);

        return NextResponse.json(result);

    } catch (error) {
        await client.query("ROLLBACK");

        console.error(`[addresses] Error for parcel ${parcelId}:`, error);

        // Handle timeout specifically
        if ((error as { code?: string }).code === '57014') {
            return NextResponse.json({
                error: "Query timeout"
            }, { status: 504 });
        }

        // Generic error response
        return NextResponse.json({
            error: "Database query failed"
        }, { status: 500 });

    } finally {
        client.release();
        console.timeEnd(queryLabel);
    }
}
