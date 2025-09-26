// app/api/address/[addressId]/parcel/route.ts
import { NextResponse } from "next/server";
import { Pool } from "pg";

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ addressId: string }> }
) {
    const { addressId } = await params;
    const numericAddressId = Number(addressId);

    if (!Number.isFinite(numericAddressId) || numericAddressId <= 0) {
        return NextResponse.json({ error: "Invalid address ID" }, { status: 400 });
    }

    const client = await pool.connect();
    const queryLabel = `[address-parcel] address ${addressId}`;
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
        const queryParams = [numericAddressId];

        if (tableCheck.rows[0].exists) {
            // Use precomputed table
            query = `
                SELECT ap.parcel_id
                FROM address_parcels ap
                WHERE ap.address_point_id = $1
                LIMIT 1
            `;
        } else {
            // Fallback to spatial join
            query = `
                SELECT p.objectid AS parcel_id
                FROM addresses a
                JOIN parcels p ON ST_Intersects(a.geom, p.geom)
                WHERE a.address_point_id = $1
                LIMIT 1
            `;
        }

        const result = await client.query(query, queryParams);
        await client.query("COMMIT");

        if (result.rows.length === 0) {
            return NextResponse.json({ error: "No parcel found for this address" }, { status: 404 });
        }

        const parcelId = result.rows[0].parcel_id;
        console.log(`[address-parcel] address ${addressId} -> parcel ${parcelId}`);

        return NextResponse.json({ parcelId }, {
            headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
            },
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error(`[address-parcel] Error for address ${addressId}:`, error);

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
