// app/api/parcels/route.ts
import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parseBbox(url: string) {
  const s = new URL(url).searchParams.get("bbox");
  if (!s) return null;
  const a = s.split(",").map(Number);
  return a.length === 4 && a.every((n) => Number.isFinite(n))
    ? (a as [number, number, number, number])
    : null;
}

function parseZoom(url: string) {
  const z = Number(new URL(url).searchParams.get("z") ?? "12");
  return Number.isFinite(z) ? Math.max(0, Math.min(22, z)) : 12;
}

function toleranceForZoom(z: number) {
  // Convert meters to degrees (approximate at Toronto's latitude ~43.65)
  // 1 degree latitude ≈ 111 km
  // 1 degree longitude ≈ 78 km at 43.65° latitude

  if (z < 9) return 0.0003; // ~30 m
  if (z < 11) return 0.0001; // ~10 m
  if (z < 13) return 0.00005; // ~5 m
  if (z < 15) return 0.00002; // ~2 m
  return 0.000005; // ~0.5 m for high zoom
}

export async function GET(req: Request) {
  const bbox = parseBbox(req.url);
  const z = parseZoom(req.url);

  // Validate required parameters
  if (!bbox) {
    return NextResponse.json(
      { error: "bbox=minX,minY,maxX,maxY required" },
      { status: 400 },
    );
  }

  if (z < 10) {
    return NextResponse.json(
      { error: "Zoom in to load parcels" },
      { status: 400 },
    );
  }

  const [minX, minY, maxX, maxY] = bbox;

  const queryLabel = `[parcels] query z=${z.toFixed(2)} bbox=[${bbox.join(",")}]`;
  console.time(queryLabel);

  const client = await pool.connect();
  try {
    // Use transaction with statement timeout
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '2500 ms'");

    const tol = toleranceForZoom(z);

    const { rows } = await client.query(
      `
      WITH filtered AS (
        SELECT p.objectid, 
               p.f_type,
               ST_Simplify(p.geom, $5) as geom
        FROM parcels p
        WHERE p.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)
        ORDER BY ST_Area(p.geom) DESC
        LIMIT 2000
      )
      SELECT jsonb_build_object(
        'type','FeatureCollection',
        'features', COALESCE(jsonb_agg(
          jsonb_build_object(
            'type','Feature',
            'geometry', CASE 
              WHEN geom IS NULL THEN NULL 
              ELSE ST_AsGeoJSON(geom)::jsonb 
            END,
            'properties', jsonb_build_object(
              'parcel_id', objectid,
              'f_type', f_type
            )
          )
        ), '[]'::jsonb)
      ) AS fc
      FROM filtered;
    `,
      [minX, minY, maxX, maxY, tol],
    );

    await client.query("COMMIT");

    const result = rows[0].fc;
    const featureCount = result.features.length;

    console.log(
      `[parcels] returned ${featureCount} features for z=${z.toFixed(2)}`,
    );

    // Return empty FeatureCollection if no results
    if (featureCount === 0) {
      return new NextResponse(
        JSON.stringify({ type: "FeatureCollection", features: [] }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
          },
        },
      );
    }

    return new NextResponse(JSON.stringify(result), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=600",
      },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");

    console.error(
      `[parcels] Error for z=${z.toFixed(2)} bbox=[${bbox.join(",")}]:`,
      error,
    );

    // Handle timeout specifically
    if (error.code === "57014") {
      return NextResponse.json(
        {
          error: "Query timeout, zoom in or try again",
        },
        { status: 504 },
      );
    }

    // Generic error response
    return NextResponse.json(
      {
        error: "Database query failed",
      },
      { status: 500 },
    );
  } finally {
    client.release();
    console.timeEnd(queryLabel);
  }
}
