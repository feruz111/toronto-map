// app/api/addresses/route.ts
import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parseBbox(url: string) {
  const s = new URL(url).searchParams.get("bbox");
  if (!s) return null;
  const a = s.split(",").map(Number);
  return a.length === 4 && a.every((n) => Number.isFinite(n)) ? a as [number, number, number, number] : null;
}

function parseZoom(url: string) {
  const z = Number(new URL(url).searchParams.get("z") ?? "12");
  return Number.isFinite(z) ? Math.max(0, Math.min(22, z)) : 12;
}

function parseParcelId(url: string): number | null {
  const pid = new URL(url).searchParams.get("parcel_id");
  if (!pid) return null;
  const num = Number(pid);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export async function GET(req: Request) {
  const parcelId = parseParcelId(req.url);
  const bbox = parseBbox(req.url);
  const z = parseZoom(req.url);

  // Require either parcel_id or bbox
  if (!parcelId && !bbox) {
    return NextResponse.json({ error: "Either parcel_id or bbox is required" }, { status: 400 });
  }

  const client = await pool.connect();
  const queryLabel = parcelId
    ? `[addresses] query parcel_id=${parcelId}`
    : `[addresses] query z=${z.toFixed(2)} bbox=[${bbox?.join(',')}]`;

  console.time(queryLabel);

  try {
    // Use transaction with statement timeout
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '2500 ms'");

    let query: string;
    let params: (number | string)[];

    if (parcelId) {
      // First check if we have the precomputed address_parcels table
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'address_parcels'
        ) AS exists
      `);

      if (tableCheck.rows[0].exists) {
        // Use precomputed table
        query = `
          WITH addr AS (
            SELECT address_point_id AS id, 
                   address_geom AS geom
            FROM address_parcels
            WHERE parcel_id = $1
            LIMIT 5000
          )
          SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(
              jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
                'properties', jsonb_build_object('address_point_id', id)
              )
            ), '[]'::jsonb)
          ) AS fc
          FROM addr
        `;
        params = [parcelId];
      } else {
        // Fallback to spatial join
        query = `
          WITH addr AS (
            SELECT a.address_point_id AS id, 
                   a.address_number,
                   a.linear_name_full,
                   a.address_full,
                   a.geom
            FROM addresses a
            JOIN parcels p ON p.objectid = $1
            WHERE a.geom && p.geom
              AND ST_Intersects(a.geom, p.geom)
            LIMIT 5000
          )
          SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(
              jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
                'properties', jsonb_build_object(
                  'address_point_id', id,
                  'civic_number', address_number,
                  'street_name', linear_name_full,
                  'full_address', address_full
                )
              )
            ), '[]'::jsonb)
          ) AS fc
          FROM addr
        `;
        params = [parcelId];
      }
    } else if (bbox && z >= 12) {
      // Bbox mode with MIN_Z guard
      const [minX, minY, maxX, maxY] = bbox;
      query = `
        WITH addr AS (
          SELECT address_point_id AS id, 
                 geom
          FROM addresses
          WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          LIMIT 5000
        )
        SELECT jsonb_build_object(
          'type', 'FeatureCollection',
          'features', COALESCE(jsonb_agg(
            jsonb_build_object(
              'type', 'Feature',
              'geometry', ST_AsGeoJSON(geom, 6)::jsonb,
              'properties', jsonb_build_object('address_point_id', id)
            )
          ), '[]'::jsonb)
        ) AS fc
        FROM addr
      `;
      params = [minX, minY, maxX, maxY];
    } else {
      // Zoom too low for bbox mode
      await client.query("COMMIT");
      return new NextResponse(
        JSON.stringify({ type: "FeatureCollection", features: [] }),
        { headers: { "content-type": "application/json" } }
      );
    }

    const { rows } = await client.query(query, params);
    await client.query("COMMIT");

    const result = rows[0].fc;
    const featureCount = result.features.length;

    console.log(`[addresses] returned ${featureCount} features for ${parcelId ? `parcel ${parcelId}` : `z=${z.toFixed(2)}`}`);

    return new NextResponse(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error(`[addresses] Error:`, error);

    // Handle timeout specifically
    if ((error as any).code === '57014') {
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
