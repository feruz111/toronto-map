import { NextResponse } from "next/server";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function parseQuery(url: string): string | null {
    const q = new URL(url).searchParams.get("q");
    return q && q.trim().length > 0 ? q.trim() : null;
}

function parseLimit(url: string): number {
    const v = Number(new URL(url).searchParams.get("limit") ?? "10");
    return Number.isFinite(v) ? Math.max(1, Math.min(100, v)) : 10;
}

export async function GET(req: Request) {
    const q = parseQuery(req.url);
    const limit = parseLimit(req.url);

    if (!q) {
        return NextResponse.json(
            { error: "q (query) parameter is required" },
            { status: 400 }
        );
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL statement_timeout = '3000 ms'");

        const sql = `
      SELECT
        a.address_point_id AS id,
        trim(
          regexp_replace(
            COALESCE(
              NULLIF(a.address_full, 'None'),
              concat_ws(' ', a.address_number::text, a.linear_name_full)
            ),
            '\\s+', ' ', 'g'
          )
        ) AS label,
        ST_X(a.geom) AS lon,
        ST_Y(a.geom) AS lat
      FROM addresses a
      WHERE a.geom IS NOT NULL
        AND lower(
          COALESCE(
            NULLIF(a.address_full, 'None'),
            concat_ws(' ', a.address_number::text, a.linear_name_full)
          )
        ) LIKE lower('%' || $1 || '%')
      LIMIT $2;
    `;

        // pass exactly two params: query string and limit
        const { rows } = await client.query(sql, [q, limit]);

        await client.query("COMMIT");

        // return the rows directly
        return NextResponse.json(rows, {
            headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=300",
            },
        });
    } catch (err: any) {
        await client.query("ROLLBACK");
        console.error(`[search] error for query="${q}":`, err);

        if (err?.code === "57014") {
            return NextResponse.json(
                { error: "Search timeout, try a more specific query" },
                { status: 504 }
            );
        }

        return NextResponse.json({ error: "Search failed" }, { status: 500 });
    } finally {
        client.release();
    }
}