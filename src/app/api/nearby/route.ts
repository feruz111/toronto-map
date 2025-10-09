import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const lat = parseFloat(searchParams.get("lat") || "0");
    const lng = parseFloat(
      searchParams.get("lng") || searchParams.get("lon") || "0",
    );
    const radius = parseFloat(searchParams.get("radius") || "2000");

    if (!lat || !lng) {
      return NextResponse.json(
        { error: "lat and lng are required" },
        { status: 400 },
      );
    }

    const client = await pool.connect();

    try {
      const params = [lng, lat, radius];

      const query = `
   WITH params AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS pt
),
pois AS (
  SELECT
    'fire_station' AS type,
    COALESCE(name, 'Fire Station') AS name,
    ST_Distance(fs.geom::geography, p.pt) AS distance_m,
    fs.geom
  FROM fire_stations fs, params p
  WHERE ST_DWithin(fs.geom::geography, p.pt, $3)

  UNION ALL

  SELECT
    'park' AS type,
    COALESCE(area_name, 'Park') AS name,
    ST_Distance(ST_Centroid(gs.geom)::geography, p.pt) AS distance_m,
    ST_Centroid(gs.geom) AS geom
  FROM (
    SELECT area_name, geom
    FROM green_spaces gs, params p
    WHERE ST_DWithin(ST_Centroid(gs.geom)::geography, p.pt, $3)
    ORDER BY ST_Distance(ST_Centroid(gs.geom)::geography, p.pt)
    LIMIT 10
  ) gs, params p

  UNION ALL

  SELECT
    'police_station' AS type,
    COALESCE(name, 'Police Station') AS name,
    ST_Distance(ps.geom::geography, p.pt) AS distance_m,
    ps.geom
  FROM police_stations ps, params p
  WHERE ST_DWithin(ps.geom::geography, p.pt, $3)

  UNION ALL

  SELECT
    'transit' AS type,
    COALESCE(stop_name, 'Station') AS name,
    ST_Distance(ts.geom::geography, p.pt) AS distance_m,
    ts.geom
  FROM (
    SELECT stop_name, geom, ST_Distance(ts.geom::geography, p.pt) AS distance_m
    FROM ttc_stations ts, params p
    WHERE ST_DWithin(ts.geom::geography, p.pt, $3)
    ORDER BY distance_m
    LIMIT 10
  ) ts, params p

  UNION ALL

  SELECT
    'transit' AS type,
    COALESCE(stop_name, 'Stop') AS name,
    ST_Distance(tst.geom::geography, p.pt) AS distance_m,
    tst.geom
  FROM (
    SELECT stop_name, geom, ST_Distance(tst.geom::geography, p.pt) AS distance_m
    FROM ttc_stops tst, params p
    WHERE ST_DWithin(tst.geom::geography, p.pt, $3)
    ORDER BY distance_m
    LIMIT 10
  ) tst, params p

  UNION ALL

  SELECT
    'library' AS type,
    COALESCE(branchname, 'Library') AS name,
    ST_Distance(l.geom::geography, p.pt) AS distance_m,
    l.geom
  FROM (
    SELECT branchname, geom, ST_Distance(l.geom::geography, p.pt) AS distance_m
    FROM libraries l, params p
    WHERE ST_DWithin(l.geom::geography, p.pt, $3)
    ORDER BY distance_m
    LIMIT 10
  ) l, params p

  UNION ALL

  SELECT
    'school' AS type,
    COALESCE(name, 'School') AS name,
    ST_Distance(s.geom::geography, p.pt) AS distance_m,
    s.geom
  FROM (
    SELECT name, geom, ST_Distance(s.geom::geography, p.pt) AS distance_m
    FROM schools s, params p
    WHERE ST_DWithin(s.geom::geography, p.pt, $3)
    ORDER BY distance_m
    LIMIT 10
  ) s, params p
)
SELECT type, name, ROUND(distance_m::numeric) AS distance_m, ST_AsGeoJSON(geom) AS geom_geojson
FROM pois
ORDER BY distance_m
LIMIT 100;
      `;

      const result = await client.query(query, params);

      const nearby = result.rows.map((row) => ({
        type: row.type,
        name: row.name,
        distance_m: row.distance_m,
        geom_geojson: row.geom_geojson,
      }));

      return NextResponse.json({ nearby });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error fetching nearby POIs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
