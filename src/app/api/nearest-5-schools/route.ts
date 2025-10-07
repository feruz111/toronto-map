import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const lat = parseFloat(searchParams.get("lat") || "0");
  const lng = parseFloat(searchParams.get("lng") || "0");

  if (!lat || !lng) {
    return NextResponse.json(
      { error: "lat and lng are required" },
      { status: 400 },
    );
  }

  const client = await pool.connect();

  try {
    const params = [lng, lat];

    const query = `
SELECT name,ST_AsGeoJSON(geom) AS geom_geojson,source_address,
ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS dist_m
FROM schools
ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
LIMIT 5
`;

    const result = await client.query(query, params);

    console.log(
      "[nearest-5-schools] Query result:",
      result.rows.length,
      "schools found",
    );

    return NextResponse.json(result.rows);
  } catch (error) {
    console.error("[nearest-5-schools] Database error:", error);
    return NextResponse.json(
      { error: "Database query failed" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
