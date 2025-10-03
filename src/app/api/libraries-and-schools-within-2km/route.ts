import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(req: Request) {
  try {
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
        SELECT 
            branchname, 
            address,
            ST_AsGeoJSON(geom) as geom_geojson,
            ST_Distance(
                geom::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            ) as dist_m
        FROM libraries
        WHERE ST_DWithin(
            geom::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            2000  -- radius in meters
        )
        ORDER BY dist_m;
      `;

      const querySchools = `
        SELECT 
            name, 
            address_full,
            ST_AsGeoJSON(geom) as geom_geojson,
            ST_Distance(
                geom::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
            ) as dist_m
        FROM schools
        WHERE ST_DWithin(
            geom::geography,
            ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
            2000  -- radius in meters
        )
        ORDER BY dist_m;
      `;

      const resultLibraries = await client.query(query, params);
      const resultSchools = await client.query(querySchools, params);

      return NextResponse.json({
        libraries: resultLibraries.rows,
        schools: resultSchools.rows,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error fetching libraries:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
