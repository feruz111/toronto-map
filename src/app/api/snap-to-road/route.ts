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
  WITH input AS (
  SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS pt
),
road AS (
  SELECT
    c.ogc_fid,
    c.geom,
    COALESCE(c.linear_name_full, c.linear_name_label, c.linear_name) AS street
  FROM centreline c, input i
  ORDER BY c.geom <-> i.pt
  LIMIT 1
),
snap AS (
  SELECT
    r.ogc_fid,
    r.street,
    r.geom        AS road_geom,
    i.pt          AS click_pt,
    ST_ClosestPoint(r.geom, i.pt) AS snap_pt
  FROM road r, input i
)
SELECT
  ogc_fid,
  street,
  ST_Distance(click_pt::geography, road_geom::geography) AS dist_m,
  ST_AsGeoJSON(snap_pt)                       AS snap_geojson,
  ST_AsGeoJSON(ST_ShortestLine(road_geom, click_pt)) AS offset_line_geojson
FROM snap;
      `;

      const resultSnap = await client.query(query, params);

      return NextResponse.json({
        snap: resultSnap.rows,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Error fetching snap to road:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
